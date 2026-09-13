import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { InboxItem } from "../../core/domain/types.js";
import { parseClassificationPayload, classificationPrompt } from "../../core/services/classification.js";
import type { AdapterProgressCallback } from "../../core/execution/execution-adapter.js";
import { reportAgentActivity, startHeartbeat } from "../../core/execution/execution-adapter.js";
import { buildModelArgs } from "./config.js";

type RpcEvent = {
  id?: string;
  type?: string;
  command?: string;
  success?: boolean;
  data?: { cancelled?: unknown };
  message?: { role?: string; content?: unknown };
  messages?: Array<{ role?: string; content?: unknown }>;
};
type ActiveClassification = { assistant: string; settle: (error?: Error) => void; onProgress?: AdapterProgressCallback };
type PendingReset = { id: string; resolve: () => void; reject: (error: Error) => void };

/** Reuses one ephemeral Pi process per classification pass, resetting before every later Inbox item. */
export class PiClassificationAdapter {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = "";
  private readonly decoder = new StringDecoder("utf8");
  private active: ActiveClassification | undefined;
  private reset: PendingReset | undefined;
  private classified = false;
  private requestNumber = 0;

  constructor(
    private readonly command = process.env.STONVIK_PI_COMMAND ?? "pi",
    private readonly timeoutMs = 120_000,
    private readonly heartbeatIntervalMs = 10_000,
    private readonly model?: string,
  ) {}

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.command, ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
      child.once("error", () => resolve(false));
      child.once("close", (code) => resolve(code === 0));
    });
  }

  close(error = new Error("Pi classification process was closed.")): void {
    const child = this.child;
    this.child = undefined;
    this.classified = false;
    child?.kill();
    this.failPending(error);
  }

  async classify(item: InboxItem, signal?: AbortSignal, onProgress?: AdapterProgressCallback, repairReason?: string): Promise<unknown> {
    if (signal?.aborted) throw new Error("Classification cancelled.");
    const child = this.ensureChild();
    if (this.classified) await this.newSession(child, signal);
    this.classified = true;
    return new Promise((resolve, reject) => {
      let settled = false;
      const stopHeartbeat = startHeartbeat(onProgress, "classification", `Clasificación de ${item.id}`, this.heartbeatIntervalMs);
      reportAgentActivity(onProgress, "classification", "Clasificador Pi iniciado.");
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stopHeartbeat();
        signal?.removeEventListener("abort", abort);
        this.active = undefined;
        if (error) {
          reject(error);
          return;
        }
        try {
          // Extract literal paths from the inbox item for auto-generating verification
          const literalPaths = [...new Set(`${item.title}\n${item.body ?? ""}`.match(/\b(?:[\w-]+\/)*[\w-]+\.[A-Za-z0-9]+\b/g) ?? [])];
          resolve(parseClassificationPayload(active.assistant, literalPaths));
        }
        catch (parseError) { reject(parseError); }
      };
      const abort = () => {
        this.close(new Error("Classification cancelled."));
        settle(new Error("Classification cancelled."));
      };
      const timer = setTimeout(() => {
        this.close(new Error("Classification timed out."));
        settle(new Error("Classification timed out."));
      }, this.timeoutMs);
      const active: ActiveClassification = { assistant: "", settle, onProgress };
      this.active = active;
      signal?.addEventListener("abort", abort, { once: true });
      try {
        child.stdin.write(`${JSON.stringify({ type: "prompt", message: classificationPrompt(item.title, item.body, item.clarification, repairReason) })}\n`);
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const modelArgs = buildModelArgs(this.model);
    const child = spawn(this.command, ["--mode", "rpc", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", ...modelArgs], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.read(chunk));
    child.stderr.resume();
    child.once("error", (error) => this.failPending(error));
    child.once("close", (code) => this.failPending(new Error(`Pi classification exited without structured output (code ${code ?? "unknown"}).`)));
    return child;
  }

  private newSession(child: ChildProcessWithoutNullStreams, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Classification cancelled."));
        return;
      }
      const id = `classification-reset-${++this.requestNumber}`;
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (this.reset?.id === id) this.reset = undefined;
        if (error) reject(error);
        else resolve();
      };
      const abort = () => {
        this.close(new Error("Classification cancelled while resetting Pi session."));
        finish(new Error("Classification cancelled while resetting Pi session."));
      };
      const timer = setTimeout(() => {
        this.close(new Error("Pi classification session reset timed out."));
        finish(new Error("Pi classification session reset timed out."));
      }, this.timeoutMs);
      this.reset = { id, resolve: () => finish(), reject: (error) => finish(error) };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        child.stdin.write(`${JSON.stringify({ id, type: "new_session" })}\n`);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private read(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      this.line(this.buffer.slice(0, newline).replace(/\r$/, ""));
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
    }
  }

  private line(raw: string): void {
    if (!raw.trim()) return;
    try {
      const event = JSON.parse(raw) as RpcEvent;
      const reset = this.reset;
      if (reset && reset.id === event.id && event.type === "response" && event.command === "new_session") {
        if (event.success !== true) this.close(new Error("Pi could not reset the classification session."));
        else if (event.data?.cancelled !== false) this.close(new Error("Pi cancelled the classification session reset."));
        else reset.resolve();
        return;
      }
      const active = this.active;
      if (!active) return;
      if (event.type === "message_end" && event.message?.role === "assistant") active.assistant = textOf(event.message.content);
      if (event.type === "tool_execution_start" || event.type === "tool_execution_end") reportAgentActivity(active.onProgress, "classification", "El clasificador completó una actividad permitida.");
      if (event.type === "agent_end") {
        const last = [...(event.messages ?? [])].reverse().find((message) => message.role === "assistant");
        if (last) active.assistant = textOf(last.content);
      }
      if (event.type === "agent_settled") active.settle();
    } catch { /* RPC output is untrusted; only structured assistant content is parsed. */ }
  }

  private failPending(error: Error): void {
    this.child = undefined;
    this.classified = false;
    this.reset?.reject(error);
    this.reset = undefined;
    this.active?.settle(error);
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part): part is { text: string } => typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string").map((part) => part.text).join("\n");
}

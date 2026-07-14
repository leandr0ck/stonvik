import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Classification, InboxItem } from "../domain/types.js";
import { parseClassificationText, classificationPrompt } from "../services/classification.js";

export class PiClassificationAdapter {
  constructor(private readonly command = process.env.FORGIUM_PI_COMMAND ?? "pi", private readonly timeoutMs = 120_000) {}

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.command, ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
      child.once("error", () => resolve(false));
      child.once("close", (code) => resolve(code === 0));
    });
  }

  async classify(item: InboxItem, signal?: AbortSignal): Promise<Classification> {
    const child = spawn(this.command, ["--mode", "rpc", "--no-session"], { stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    let assistant = "";
    const decoder = new StringDecoder("utf8");
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        child.kill();
        callback();
      };
      const abort = () => finish(() => reject(new Error("Classification cancelled.")));
      const timer = setTimeout(() => finish(() => reject(new Error("Classification timed out."))), this.timeoutMs);
      const line = (raw: string) => {
        if (!raw.trim()) return;
        try {
          const event = JSON.parse(raw) as { type?: string; message?: { role?: string; content?: unknown }; messages?: Array<{ role?: string; content?: unknown }> };
          if (event.type === "message_end" && event.message?.role === "assistant") assistant = textOf(event.message.content);
          if (event.type === "agent_end") {
            const last = [...(event.messages ?? [])].reverse().find((message) => message.role === "assistant");
            if (last) assistant = textOf(last.content);
          }
          if (event.type === "agent_settled") finish(() => {
            try { resolve(parseClassificationText(assistant)); } catch (error) { reject(error); }
          });
        } catch { /* RPC output is untrusted; only assistant content is parsed. */ }
      };
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += decoder.write(chunk);
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          line(buffer.slice(0, newline).replace(/\r$/, ""));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
        }
      });
      child.once("error", (error) => finish(() => reject(error)));
      child.once("close", (code) => {
        if (!settled) finish(() => reject(new Error(`Pi classification exited without structured output (code ${code ?? "unknown"}).`)));
      });
      signal?.addEventListener("abort", abort, { once: true });
      child.stdin.write(`${JSON.stringify({ type: "prompt", message: classificationPrompt(item.title, item.body) })}\n`);
    });
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part): part is { text: string } => typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string").map((part) => part.text).join("\n");
}

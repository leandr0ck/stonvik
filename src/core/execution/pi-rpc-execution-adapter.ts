import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { ExecutionProfile } from "../domain/types.js";
import type { ExecutionAdapter, ExecutionRequest, ExecutionResult } from "./execution-adapter.js";
import { reportAgentActivity, startHeartbeat } from "./execution-adapter.js";
import { buildModelArgs } from "../services/config.js";

const RESULT_PATTERN = /STONVIK_RESULT:\s*(completed|verification_failed|blocked|needs_human|cancelled)/i;

export class PiRpcExecutionAdapter implements ExecutionAdapter {
  readonly id = "pi-rpc";

  constructor(
    private readonly command = process.env.STONVIK_PI_COMMAND ?? "pi",
    private readonly timeoutMs = 30 * 60 * 1000,
    private readonly heartbeatIntervalMs = 10_000,
    private readonly model?: string,
  ) {}

  supports(profile: ExecutionProfile): boolean { return profile.kind === "direct"; }

  async isAvailable(_request: ExecutionRequest): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.command, ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
      child.once("error", () => resolve(false));
      child.once("close", (code) => resolve(code === 0));
    });
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const modelArgs = buildModelArgs(this.model);
    const child = spawn(this.command, ["--mode", "rpc", "--no-session", ...modelArgs], { cwd: request.root, stdio: ["pipe", "pipe", "pipe"] });
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let assistantText = "";
    let settled = false;

    return new Promise((resolve, reject) => {
      const stopHeartbeat = startHeartbeat(request.onProgress, "execution", `Pi en ${request.feature.id}`, this.heartbeatIntervalMs);
      reportAgentActivity(request.onProgress, "execution", "Agente Pi iniciado.");
      const finish = (result: ExecutionResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        stopHeartbeat();
        request.signal?.removeEventListener("abort", abort);
        child.kill();
        resolve(result);
      };
      const abort = () => {
        child.stdin.write(`${JSON.stringify({ type: "abort" })}\n`);
        finish({ outcome: "cancelled", summary: "Pi execution was cancelled." });
      };
      const timeout = setTimeout(() => finish({ outcome: "cancelled", summary: `Pi execution exceeded ${this.timeoutMs}ms.` }), this.timeoutMs);
      const handleLine = (line: string) => {
        if (!line.trim()) return;
        let event: PiRpcEvent;
        try { event = JSON.parse(line) as PiRpcEvent; }
        catch { return; }
        if (event.type === "tool_execution_start" || event.type === "tool_execution_end") reportAgentActivity(request.onProgress, "execution", "El agente completó una actividad permitida.");
        if (event.type === "extension_ui_request") reportAgentActivity(request.onProgress, "execution", "El agente solicitó una interacción estructurada.");
        if (event.type === "message_end" && event.message?.role === "assistant") assistantText = assistantTextFrom(event.message.content);
        if (event.type === "agent_end") {
          const messages = event.messages ?? [];
          const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
          if (lastAssistant) assistantText = assistantTextFrom(lastAssistant.content);
        }
        if (event.type === "agent_settled") finish(parsePiResult(assistantText));
      };
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += decoder.write(chunk);
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          handleLine(line);
          newline = buffer.indexOf("\n");
        }
      });
      child.once("error", (error) => {
        if (!settled) { clearTimeout(timeout); stopHeartbeat(); reject(error); }
      });
      child.once("close", (code) => {
        if (!settled) finish(code === 0 ? parsePiResult(assistantText) : { outcome: "needs_human", summary: `Pi exited before producing a Stonevik result (code ${code ?? "unknown"}).` });
      });
      request.signal?.addEventListener("abort", abort, { once: true });
      child.stdin.write(`${JSON.stringify({ id: request.runId, type: "prompt", message: buildPiPrompt(request) })}\n`);
    });
  }
}

export function buildPiPrompt(request: ExecutionRequest): string {
  const profile = request.profile.kind === "direct"
    ? "Implement the Feature directly."
    : `Follow the repository's spec-driven workflow using ${request.profile.specPath}.`;
  return [
    "You are the execution engine for Stonevik.",
    `Work only inside repository: ${request.root}`,
    `Feature: ${request.feature.id}`,
    `Title: ${request.feature.manifest.title}`,
    `Goal: ${request.feature.manifest.goal}`,
    `Constraints:\n${(request.feature.manifest.constraints ?? []).map((constraint) => `- ${constraint}`).join("\n") || "- none"}`,
    `Acceptance criteria:\n${request.feature.manifest.acceptance.map((criterion) => `- ${criterion}`).join("\n")}`,
    `Verification policy:\n${request.feature.manifest.verification.commands.map((command) => `- ${command.name}: ${command.run}`).join("\n") || "- manual evidence required"}`,
    `Allowed paths: ${(request.allowedPaths ?? []).join(", ") || "repository source files only"}`,
    profile,
    "Do not edit Stonevik state directories, manifests, or receipts.",
    "When finished, print exactly one final line: STONVIK_RESULT: completed, verification_failed, blocked, needs_human, or cancelled.",
    "If you cannot establish completion safely, use STONVIK_RESULT: needs_human."
  ].join("\n\n");
}

export function parsePiResult(text: string): ExecutionResult {
  const matches = [...text.matchAll(new RegExp(RESULT_PATTERN.source, "gi"))];
  const match = matches.at(-1);
  if (!match) return { outcome: "needs_human", summary: "Pi finished without a recognized Stonevik result marker." };
  const markerValue = text.slice((match.index ?? 0) + match[0].length).trim();
  try {
    const structured = JSON.parse(markerValue) as Partial<ExecutionResult>;
    if (typeof structured.outcome === "string" && ["completed", "verification_failed", "blocked", "needs_human", "cancelled"].includes(structured.outcome)) return { ...structured, outcome: structured.outcome as ExecutionResult["outcome"], summary: typeof structured.summary === "string" ? structured.summary : `Pi reported ${structured.outcome}.` };
  } catch { /* legacy marker has no JSON payload */ }
  const outcome = match[1]!.toLowerCase() as ExecutionResult["outcome"];
  return { outcome, summary: `Pi reported ${outcome}.` };
}

function assistantTextFrom(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part): part is { type: "text"; text: string } => typeof part === "object" && part !== null && (part as { type?: string }).type === "text" && typeof (part as { text?: unknown }).text === "string").map((part) => part.text).join("\n");
}

interface PiRpcEvent {
  type: string;
  message?: { role?: string; content?: unknown };
  messages?: Array<{ role?: string; content?: unknown }>;
}

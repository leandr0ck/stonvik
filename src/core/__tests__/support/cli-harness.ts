import { spawn } from "node:child_process";
import path from "node:path";

export const compiledCliPath = path.resolve(process.cwd(), "dist/cli/index.js");

export type ProcessResult = { stdout: string; stderr: string; code: number | null };

export function runCompiledCli(root: string, args: string[], env: NodeJS.ProcessEnv = process.env, input = ""): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [compiledCliPath, "--root", root, ...args], { cwd: root, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin.end(input);
  });
}

export async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for process output.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

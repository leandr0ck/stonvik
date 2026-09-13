import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import YAML from "yaml";
import { describe, expect, it } from "vitest";

const cliPath = path.resolve(process.cwd(), "src/cli/index.ts");
const tsx = path.resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
const useBuiltCli = process.env.STONVIK_E2E_DIST === "1";

async function cli(root: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const command = useBuiltCli
      ? [path.resolve(process.cwd(), "dist/cli/index.js"), "--root", root, ...args]
      : [tsx, cliPath, "--root", root, ...args];
    const child = spawn(process.execPath, command, { cwd: root, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin.end();
  });
}

async function fakePi(root: string, status: object): Promise<string> {
  const command = path.join(root, `fake-pi-${JSON.stringify(status).length}`);
  await fs.writeFile(command, [
    "#!/usr/bin/env node",
    "if (process.argv.includes('--version')) process.exit(0);",
    "let prompts = 0;",
    "process.stdin.on('data', (chunk) => {",
    "  for (const line of chunk.toString().split('\\n')) {",
    "    if (!line.trim() || line.includes('extension_ui_response')) continue;",
    "    prompts += 1;",
    "    if (prompts === 1) {",
    "      process.stdout.write(JSON.stringify({ type: 'extension_ui_request', id: 'ticket', method: 'select', options: ['Yes, proceed', 'No, cancel'] }) + '\\n');",
    "      process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');",
    "    } else {",
    `      process.stdout.write(JSON.stringify({ type: 'tool_execution_end', toolName: 'spec_flow_status', result: { details: ${JSON.stringify(status)} } }) + '\\n');`,
    "      process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');",
    "    }",
    "  }",
    "});",
  ].join("\n"));
  await fs.chmod(command, 0o755);
  return command;
}

describe("Stonevik implementation observation loop", () => {
  it("keeps Work doing for a pending Spec Flow review and only advances when ticket status is complete", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "stonvik-implementation-e2e-"));
    expect((await cli(root, ["init", "--json"])).code).toBe(0);
    const created = await cli(root, ["work", "create", "--title", "Implement notifications", "--goal", "Implement notifications.", "--acceptance", "Notifications are delivered.", "--verify-command", "true", "--json"]);
    const work = JSON.parse(created.stdout) as { id: string; path: string };
    await fs.writeFile(path.join(work.path, "spec.md"), "# Notifications\n");
    await fs.mkdir(path.join(work.path, "tickets"));

    const pendingPi = await fakePi(root, { complete: false, total: 2, pending: 1, done: 1, checkpoints: { total: 1, pendingReview: 1 } });
    const pending = await cli(root, ["implement", work.id, "--json"], { ...process.env, STONVIK_PI_COMMAND: pendingPi });
    expect(pending.code).toBe(0);
    expect(JSON.parse(pending.stdout)).toMatchObject({
      outcome: "needs_human",
      feature: { state: "doing" },
      details: { specFlow: { complete: false, checkpoints: { pendingReview: 1 } } },
    });

    const receiptsPath = path.join(root, "features", "doing", "implement-notifications", "receipts");
    const pendingReceipts = await Promise.all((await fs.readdir(receiptsPath)).map(async (name) => YAML.parse(await fs.readFile(path.join(receiptsPath, name), "utf8")) as { kind: string; details?: { specFlow?: { complete?: boolean } }; outcome: string }));
    expect(pendingReceipts.some((receipt) => receipt.kind === "execution" && receipt.outcome === "needs_human" && receipt.details?.specFlow?.complete === false)).toBe(true);
    expect(pendingReceipts.some((receipt) => receipt.kind === "handoff" && receipt.outcome === "needs_human")).toBe(true);

    const completePi = await fakePi(root, { complete: true, total: 2, pending: 0, done: 2, checkpoints: { total: 1, completed: 1, pendingReview: 0 } });
    const complete = await cli(root, ["implement", work.id, "--json"], { ...process.env, STONVIK_PI_COMMAND: completePi });
    expect(complete.code).toBe(0);
    expect(JSON.parse(complete.stdout)).toMatchObject({ outcome: "completed", feature: { state: "review" }, details: { specFlow: { complete: true, done: 2 } } });

    const status = await cli(root, ["status", "--verbose", "--json"]);
    expect(JSON.parse(status.stdout)).toMatchObject({ implementations: [expect.objectContaining({ id: work.id, state: "review", observation: expect.objectContaining({ complete: true }), nextAction: "Review the completed Work." })] });

    const review = await cli(root, ["work-review", work.id, "--json"]);
    expect(review.code).toBe(0);
    expect(JSON.parse(review.stdout)).toMatchObject({ state: "done" });
  });
});

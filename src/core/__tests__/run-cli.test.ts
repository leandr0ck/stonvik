import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { FilesystemForgiumRepository } from "../../core/index.js";

async function runCli(root: string, args: string[], input = "", env: NodeJS.ProcessEnv = process.env) {
  const cliPath = path.resolve(process.cwd(), "src/cli/index.ts");
  const tsx = path.resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(process.execPath, [tsx, cliPath, "--root", root, ...args], { cwd: root, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin.end(input);
  });
}

async function fakePiWithClassification(root: string, classification: unknown): Promise<string> {
  const command = path.join(root, "fake-pi-classification");
  const assistantText = JSON.stringify(classification);
  await fs.writeFile(command, [
    "#!/usr/bin/env node",
    "if (process.argv.includes('--version')) process.exit(0);",
    "process.stdin.on('data', () => {",
    `  process.stdout.write(JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: ${JSON.stringify(assistantText)} }] }] }) + '\\n');`,
    "  process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');",
    "});",
  ].join("\n"));
  await fs.chmod(command, 0o755);
  return command;
}

describe("forgium run", () => {
  it("does not approve captured Inbox items in non-interactive mode", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-run-test-"));
    const repo = new FilesystemForgiumRepository(root);
    await repo.init();
    await repo.capture({ text: "Capture only" });

    const result = await runCli(root, ["run", "--non-interactive", "--json"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ stopReason: "human_input_required" });
    await expect(repo.listInbox()).resolves.toMatchObject([{ status: "captured" }]);
  });

  it("reports ready Work without starting implementation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-run-ready-test-"));
    const repo = new FilesystemForgiumRepository(root);
    await repo.init();
    const feature = await repo.createFeature({ title: "Ready work", goal: "Wait for an engine.", acceptance: ["It stays safe"], verification: { commands: [{ name: "pass", run: "true" }] } });

    const result = await runCli(root, ["run", "--json"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ stopReason: "ready_for_implementation", features: [{ id: feature.id, state: "ready", action: "ready_for_implementation" }] });
    await expect(repo.getFeature(feature.id)).resolves.toMatchObject({ state: "ready" });
    await expect(fs.stat(path.join(root, ".forgium/runtime"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not write during dry-run", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-run-dry-run-"));
    const repo = new FilesystemForgiumRepository(root);
    await repo.init();
    const feature = await repo.createFeature({ title: "Dry run work", goal: "Preview safely.", acceptance: ["No mutation"], verification: { commands: [{ name: "pass", run: "true" }] } });

    const result = await runCli(root, ["run", "--dry-run", "--json"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ stopReason: "dry_run" });
    await expect(repo.getFeature(feature.id)).resolves.toMatchObject({ state: "ready" });
  });

  it("stops instead of guessing when multiple Work items are active", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-run-multiple-active-"));
    const repo = new FilesystemForgiumRepository(root);
    await repo.init();
    const first = await repo.createFeature({ title: "First active", goal: "Keep the first active.", acceptance: ["It remains active"], verification: { commands: [{ name: "pass", run: "true" }] } });
    const second = await repo.createFeature({ title: "Second active", goal: "Keep the second active.", acceptance: ["It remains active"], verification: { commands: [{ name: "pass", run: "true" }] } });
    await repo.startFeature(first.id);
    await repo.startFeature(second.id);

    const result = await runCli(root, ["run", "--json"], "", { ...process.env, FORGIUM_PI_COMMAND: "unavailable-for-active-work-test" });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ stopReason: "multiple_active_work", nextAction: expect.stringContaining(first.id) });
    await expect(repo.getFeature(first.id)).resolves.toMatchObject({ state: "doing" });
    await expect(repo.getFeature(second.id)).resolves.toMatchObject({ state: "doing" });
  });

  it("fails closed and renders a classification gate without inventing a definition", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-run-invalid-classification-"));
    expect((await runCli(root, ["init", "--json"])).code).toBe(0);
    expect((await runCli(root, ["capture", "Create a names file", "--json"])).code).toBe(0);
    const fakePi = await fakePiWithClassification(root, {
      route: "direct",
      size: "xs",
      rationale: "One small file.",
      proposed: { verification: { commands: ["true"] } },
    });

    const result = await runCli(root, ["run"], "", { ...process.env, FORGIUM_PI_COMMAND: fakePi });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Stop: human_input_required");
    expect(result.stdout).toContain("Next: Review and classify Inbox item inbox-");
    expect(result.stdout).not.toContain("Definition required:");
    const inbox = JSON.parse((await runCli(root, ["inbox", "--json"])).stdout);
    expect(inbox).toMatchObject([{ status: "captured" }]);
    const events = (await fs.readFile(path.join(root, "product", "events", `${new Date().toISOString().slice(0, 10)}.ndjson`), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "gate", message: expect.stringContaining("Classification needs human attention"), nextAction: expect.stringContaining("Review and classify Inbox item") }),
    ]));
  }, 15_000);

});

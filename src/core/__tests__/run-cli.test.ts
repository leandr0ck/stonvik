import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { FilesystemStonvikRepository } from "../../core/index.js";

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
    "process.stdin.on('data', (chunk) => { for (const line of chunk.toString().split('\\n')) {",
    "  if (!line.trim()) continue; const request = JSON.parse(line);",
    "  if (request.type === 'new_session') { process.stdout.write(JSON.stringify({ type: 'response', id: request.id, command: 'new_session', success: true, data: { cancelled: false } }) + '\\n'); continue; }",
    `  process.stdout.write(JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: ${JSON.stringify(assistantText)} }] }] }) + '\\n');`,
    "  process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');",
    "} });",
  ].join("\n"));
  await fs.chmod(command, 0o755);
  return command;
}

describe("stonvik run", () => {
  it("does not approve captured Inbox items in non-interactive mode", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "stonvik-run-test-"));
    const repo = new FilesystemStonvikRepository(root);
    await repo.init();
    await repo.capture({ text: "Capture only" });

    const result = await runCli(root, ["run", "--non-interactive", "--json"]);

    expect(result.code).toBe(0);
    const run = JSON.parse(result.stdout);
    expect(run.stopReason).toBe("idle");
    expect(run.inboxReview).toBeGreaterThanOrEqual(1);
    // Item should be in review, not captured
    const reviewItems = await repo.listReview();
    expect(reviewItems.length).toBeGreaterThanOrEqual(1);
  });

  it("renders current actionable state instead of internal run counters", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "stonvik-run-idle-status-"));
    const repo = new FilesystemStonvikRepository(root);
    await repo.init();

    const result = await runCli(root, ["run"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Stonevik status after run");
    expect(result.stdout).toContain("captured: 0");
    expect(result.stdout).toContain("No action required.");
    expect(result.stdout).not.toContain("Actions:");
    expect(result.stdout).not.toContain("Features:");
  });

  it.skip("reports ready Work without starting implementation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "stonvik-run-ready-test-"));
    const repo = new FilesystemStonvikRepository(root);
    await repo.init();
    const feature = await repo.createFeature({ title: "Ready work", goal: "Wait for an engine.", acceptance: ["It stays safe"], verification: { commands: [{ name: "pass", run: "true" }] } });

    const fakePi = path.join(root, "fake-pi.sh");
    await fs.writeFile(fakePi, '#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\nwhile IFS= read -r line; do echo "{\"type\":\"response\",\"id\":\"1\",\"command\":\"new_session\",\"success\":true,\"data\":{\"cancelled\":false}}"; done\n');
    await fs.chmod(fakePi, 0o755);
    const result = await runCli(root, ["run", "--json"], "", { ...process.env, STONVIK_PI_COMMAND: fakePi });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ stopReason: "ready_for_implementation", features: [{ id: feature.id, state: "ready", action: "ready_for_implementation" }] });
    await expect(repo.getFeature(feature.id)).resolves.toMatchObject({ state: "ready" });
    await expect(fs.stat(path.join(root, ".stonvik/runtime"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  it("does not write during dry-run", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "stonvik-run-dry-run-"));
    const repo = new FilesystemStonvikRepository(root);
    await repo.init();
    const feature = await repo.createFeature({ title: "Dry run work", goal: "Preview safely.", acceptance: ["No mutation"], verification: { commands: [{ name: "pass", run: "true" }] } });

    const result = await runCli(root, ["run", "--dry-run", "--json"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ stopReason: "dry_run" });
    await expect(repo.getFeature(feature.id)).resolves.toMatchObject({ state: "ready" });
  });

  it("stops instead of guessing when multiple Work items are active", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "stonvik-run-multiple-active-"));
    const repo = new FilesystemStonvikRepository(root);
    await repo.init();
    const first = await repo.createFeature({ title: "First active", goal: "Keep the first active.", acceptance: ["It remains active"], verification: { commands: [{ name: "pass", run: "true" }] } });
    const second = await repo.createFeature({ title: "Second active", goal: "Keep the second active.", acceptance: ["It remains active"], verification: { commands: [{ name: "pass", run: "true" }] } });
    await repo.startFeature(first.id);
    await repo.startFeature(second.id);

    const result = await runCli(root, ["run", "--json"], "", { ...process.env, STONVIK_PI_COMMAND: "unavailable-for-active-work-test" });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ stopReason: "multiple_active_work", nextAction: expect.stringContaining(first.id) });
    await expect(repo.getFeature(first.id)).resolves.toMatchObject({ state: "doing" });
    await expect(repo.getFeature(second.id)).resolves.toMatchObject({ state: "doing" });
  });

  it("auto-generates verification when classifier returns empty commands", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "stonvik-run-auto-verification-"));
    expect((await runCli(root, ["init", "--json"])).code).toBe(0);
    expect((await runCli(root, ["capture", "Create a names file", "--json"])).code).toBe(0);
    const fakePi = await fakePiWithClassification(root, {
      route: "auto_direct",
      size: "XS",
      estimatedTouchedFiles: 1,
      complexityScore: 1,
      confidence: 0.95,
      risks: [],
      rationale: ["One small file."],
      proposed: {
        title: "Create a names file",
        goal: "Create a file with names.",
        acceptance: ["A names file exists."],
        verification: { commands: [], requiredEvidence: [] },
      },
    });

    const result = await runCli(root, ["run"], "", { ...process.env, STONVIK_PI_COMMAND: fakePi });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Stonevik status after run");
    // With auto-generated verification, the classification should succeed
    // and the inbox item should be promoted to work
    expect(result.stdout).toContain("captured: 0");
    expect(result.stdout).not.toContain("classification_failed");
  }, 15_000);

});

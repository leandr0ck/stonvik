import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { FilesystemForgiumRepository } from "../../core/index.js";

async function runCli(root: string, args: string[], input = "") {
  const cliPath = path.resolve(process.cwd(), "src/cli/index.ts");
  const tsx = path.resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(process.execPath, [tsx, cliPath, "--root", root, ...args], { cwd: root });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin.end(input);
  });
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

  it("stops before doing when no execution engine is configured", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-run-engine-test-"));
    const repo = new FilesystemForgiumRepository(root);
    await repo.init();
    const feature = await repo.createFeature({ title: "Ready work", goal: "Wait for an engine.", acceptance: ["It stays safe"] });

    const result = await runCli(root, ["run", "--json"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ stopReason: "engine_unavailable", features: [{ id: feature.id, state: "ready" }] });
    await expect(repo.getFeature(feature.id)).resolves.toMatchObject({ state: "ready" });
    await expect(fs.stat(path.join(root, ".forgium/runtime"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not write during dry-run", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-run-dry-run-"));
    const repo = new FilesystemForgiumRepository(root);
    await repo.init();
    const feature = await repo.createFeature({ title: "Dry run work", goal: "Preview safely.", acceptance: ["No mutation"] });

    const result = await runCli(root, ["run", "--dry-run", "--json"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ stopReason: "dry_run" });
    await expect(repo.getFeature(feature.id)).resolves.toMatchObject({ state: "ready" });
    await expect(repo.listDrafts()).resolves.toHaveLength(0);
  });

  it("rejects an invalid budget combination", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-run-options-test-"));
    const repo = new FilesystemForgiumRepository(root);
    await repo.init();

    const result = await runCli(root, ["run", "--until-empty", "--max-features", "2"]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("RUN_OPTIONS_INVALID");
  });
});


import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

async function cli(root: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  const cliPath = path.resolve(process.cwd(), "src/cli/index.ts");
  const tsx = path.resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
  return run(process.execPath, [tsx, cliPath, "--root", root, ...args], root);
}

function run(command: string, args: string[], cwd: string, input = ""): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} exited with ${code}: ${stderr}`)));
    child.stdin.end(input);
  });
}

describe("forgium triage", () => {
  it("does not approve captured Inbox items in non-interactive mode", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-triage-test-"));
    await cli(root, "init");
    await cli(root, "capture", "Add dark mode");

    const result = await cli(root, "triage", "--non-interactive", "--json");
    expect(JSON.parse(result.stdout)).toMatchObject({ stopReason: "human_input_required" });
    const inbox = JSON.parse((await cli(root, "--json", "inbox")).stdout);
    expect(inbox).toMatchObject([{ status: "captured" }]);
  });

  it("classifies an Inbox item into a ready implementation Work in one CLI session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-triage-e2e-"));
    await cli(root, "init");
    await cli(root, "capture", "Add dark mode");

    await run(process.execPath, [path.resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs"), path.resolve(process.cwd(), "src/cli/index.ts"), "--root", root, "triage"], root, "t\nLet users choose a theme.\nA theme toggle is visible\n\n\nA theme toggle is visible:browser-check\n\n");

    const inbox = JSON.parse((await cli(root, "--json", "inbox")).stdout)[0];
    const feature = JSON.parse((await cli(root, "--json", "work", "list", "--state", "ready")).stdout)[0];

    expect(inbox).toMatchObject({ status: "promoted", featureRef: feature.id });
    expect(feature.manifest).toMatchObject({ id: "feature-add-dark-mode", source: { type: "inbox", ref: inbox.id } });
  });

  it("marks an Inbox item needs-definition without creating executable Work", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-triage-spec-e2e-"));
    await cli(root, "init");
    await cli(root, "capture", "Add notifications");

    await run(process.execPath, [path.resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs"), path.resolve(process.cwd(), "src/cli/index.ts"), "--root", root, "triage"], root, "s\n");

    const inbox = JSON.parse((await cli(root, "--json", "inbox")).stdout)[0];
    const work = JSON.parse((await cli(root, "--json", "work", "list", "--state", "ready")).stdout);
    expect(inbox).toMatchObject({ status: "needs_definition", definitionKind: "spec", definitionRef: expect.stringMatching(/^docs\/specs\//) });
    expect(work).toEqual([]);
  });

  it("does not write during dry-run", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-triage-dry-run-"));
    await cli(root, "init");
    await cli(root, "capture", "Add dark mode");

    const result = await cli(root, "triage", "--dry-run", "--json");
    expect(JSON.parse(result.stdout)).toMatchObject({ stopReason: "dry_run" });
    const inbox = JSON.parse((await cli(root, "--json", "inbox")).stdout);
    expect(inbox).toMatchObject([{ status: "captured" }]);
  });
});

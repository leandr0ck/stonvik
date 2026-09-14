import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

async function cli(root: string, ...args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const cliPath = path.resolve(process.cwd(), "src/cli/index.ts");
  const tsx = path.resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsx, cliPath, "--root", root, ...args], { cwd: root });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, stderr, code }));
  });
}

async function json(root: string, ...args: string[]): Promise<any> {
  const result = await cli(root, "--json", ...args);
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout);
}

describe("stonvik triage and definition", () => {
  it("reads an Inbox item, records triage, and waits for a user-owned definition", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "stonvik-triage-cli-"));
    await json(root, "init");
    const captured = await json(root, "capture", "Add notifications");

    const shown = await json(root, "inbox", "show", captured.id);
    expect(shown).toMatchObject({ id: captured.id, status: "captured", title: "Add notifications" });

    const triaged = await json(root, "triage", captured.id, "--route", "adr", "--actor", "human:lean");
    expect(triaged).toMatchObject({ id: captured.id, status: "needs_definition", routingDecision: { route: "adr" } });
    expect(await json(root, "work", "list", "--state", "ready")).toEqual([]);
    await expect(fs.readdir(path.join(root, "features"))).resolves.toEqual(expect.arrayContaining(["blocked", "done", "doing", "ready", "review"]));
  });

  it("creates Work without imposing a spec or ADR format", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "stonvik-define-cli-"));
    await json(root, "init");
    const captured = await json(root, "capture", "Choose storage architecture");
    await json(root, "triage", captured.id, "--route", "adr", "--actor", "human:lean");

    await fs.mkdir(path.join(root, "decisions"));
    await fs.writeFile(path.join(root, "decisions", "storage.txt"), "Use the option selected by the team.\n");
    const work = await json(root, "define", captured.id,
      "--goal", "Record and implement the selected storage architecture.",
      "--acceptance", "The selected architecture is implemented.",
      "--adr", "decisions/storage.txt",
      "--verify-command", "true");

    expect(work).toMatchObject({ state: "ready", manifest: { definitions: [{ kind: "adr", path: "decisions/storage.txt" }] } });
    expect(await json(root, "inbox")).toEqual([]);
    expect((await json(root, "validate")).valid).toBe(true);
  });

  it("does not expose generated definition commands", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "stonvik-definition-command-"));
    const result = await cli(root, "definition", "edit", "inbox-missing");
    expect(result.code).not.toBe(0);
  });
});

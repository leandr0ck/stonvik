import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { FilesystemForgiumRepository } from "../../core/index.js";

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
    const repo = new FilesystemForgiumRepository(root);

    expect(JSON.parse(result.stdout)).toMatchObject({ stopReason: "human_input_required" });
    await expect(repo.listInbox()).resolves.toMatchObject([{ status: "captured" }]);
    await expect(repo.listDrafts()).resolves.toHaveLength(0);
  });

  it("runs the CLI flow from captured Inbox to a ready Feature", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-triage-e2e-"));
    await cli(root, "init");
    await cli(root, "capture", "Add dark mode");

    await run(process.execPath, [path.resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs"), path.resolve(process.cwd(), "src/cli/index.ts"), "--root", root, "triage"], root, "a\ns\n");
    const repo = new FilesystemForgiumRepository(root);
    const draft = (await repo.listDrafts())[0]!;
    await fs.writeFile(path.join(draft.path, "draft.md"), `---\n${YAML.stringify({
      ...draft.frontmatter,
      goal: "Let users choose a theme.",
      acceptance: ["A theme toggle is visible"]
    })}---\n\n# Context\n`);
    await cli(root, "triage", "--non-interactive");

    const inbox = (await repo.listInbox())[0]!;
    const feature = (await repo.listFeatures("ready"))[0]!;

    expect(inbox).toMatchObject({ status: "promoted", draftRef: "draft-add-dark-mode", featureRef: feature.id });
    expect(feature.manifest).toMatchObject({ id: "feature-add-dark-mode", source: { type: "inbox", ref: inbox.id } });
  });

  it("does not write during dry-run", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-triage-dry-run-"));
    await cli(root, "init");
    await cli(root, "capture", "Add dark mode");

    const result = await cli(root, "triage", "--dry-run", "--json");
    const repo = new FilesystemForgiumRepository(root);

    expect(JSON.parse(result.stdout)).toMatchObject({ stopReason: "dry_run" });
    await expect(repo.listInbox()).resolves.toMatchObject([{ status: "captured" }]);
    await expect(repo.listDrafts()).resolves.toHaveLength(0);
  });
});

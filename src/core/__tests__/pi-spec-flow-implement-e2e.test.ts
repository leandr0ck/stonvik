import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

const e2e = process.env.FORGIUM_E2E_PI === "1" ? it : it.skip;
const cliPath = path.resolve(process.cwd(), "dist/cli/index.js");

async function cli(root: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "--root", root, ...args], { cwd: root, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin.end();
  });
}

describe("Forgium implement + real Pi Spec Flow", () => {
  e2e("fails closed and leaves Work doing when Pi does not return a structured completion status", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-implement-pi-e2e-"));
    let passed = false;
    try {
      expect((await cli(root, ["init", "--json"])).code).toBe(0);
      const created = await cli(root, [
        "work", "create",
        "--title", "Pi Spec Flow Implementation",
        "--goal", "Validate observed Spec Flow implementation.",
        "--acceptance", "target.txt contains after as its only value.",
        "--verify-command", "test \"$(cat target.txt)\" = \"after\"",
        "--json",
      ]);
      expect(created.code).toBe(0);
      const work = JSON.parse(created.stdout) as { id: string; path: string };
      await fs.writeFile(path.join(root, "spec-flow.config.json"), JSON.stringify({ ticketsFolder: "./tickets", ticketsFolderBase: "spec" }));
      await fs.writeFile(path.join(root, "target.txt"), "before\n");
      await fs.writeFile(path.join(work.path, "spec.md"), "# Implementation\n\nSet target.txt to after.\n");
      await fs.mkdir(path.join(work.path, "tickets"));
      await fs.writeFile(path.join(work.path, "tickets", "001-update-target.md"), [
        "---",
        "id: 1",
        "title: Update target",
        "description: Change target.txt from before to after.",
        "status: pending",
        "source_section: Implementation",
        "feature_key: pi-spec-flow-implementation",
        `source_spec_path: ${path.relative(root, path.join(work.path, "spec.md"))}`,
        "acceptance_criteria: '- [ ] target.txt contains after as its only value'",
        "verification: '- [ ] test \"$(cat target.txt)\" = \"after\"'",
        "estimated_scope: XS",
        "phase: Foundation",
        "is_checkpoint: false",
        "order_index: 1",
        "---",
        "",
        "Edit only target.txt, verify it, fill all handoff fields, and close this ticket with the Spec Flow handoff tool.",
      ].join("\n"));

      const implementation = await cli(root, ["implement", work.id, "--json"]);
      expect(implementation.code).toBe(0);
      expect(JSON.parse(implementation.stdout)).toMatchObject({ outcome: "needs_human", feature: { state: "doing" } });
      const status = await cli(root, ["status", "--verbose", "--json"]);
      expect(JSON.parse(status.stdout)).toMatchObject({ implementations: [expect.objectContaining({ id: work.id, state: "doing", nextAction: expect.stringContaining("structured status") })] });
      expect(JSON.parse((await cli(root, ["validate", "--json"])).stdout)).toMatchObject({ valid: true });
      passed = true;
    } finally {
      if (!passed || process.env.FORGIUM_E2E_KEEP === "1") console.error(`Forgium implementation Pi E2E retained at: ${root}`);
      else await fs.rm(root, { recursive: true, force: true });
    }
  }, 150_000);
});

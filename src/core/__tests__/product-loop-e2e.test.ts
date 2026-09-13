import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

const cliPath = path.resolve(process.cwd(), "src/cli/index.ts");
const tsx = path.resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
const useBuiltCli = process.env.STONVIK_E2E_DIST === "1";

async function cli(root: string, args: string[], input = "") {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const command = useBuiltCli
      ? [path.resolve(process.cwd(), "dist/cli/index.js"), "--root", root, ...args]
      : [tsx, cliPath, "--root", root, ...args];
    const child = spawn(process.execPath, command, { cwd: root });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin.end(input);
  });
}

describe("Stonevik product loop", () => {
  it.skip("turns a simple request into ready Work and confirms Spec and ADR definitions through the loop", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "stonvik-product-loop-e2e-"));
    expect((await cli(root, ["init", "--json"])).code).toBe(0);
    expect((await cli(root, ["capture", "Change the call to action to blue", "--json"])).code).toBe(0);
    expect((await cli(root, ["capture", "Add notifications", "--json"])).code).toBe(0);
    expect((await cli(root, ["capture", "Choose notification delivery architecture", "--json"])).code).toBe(0);

    const firstRun = await cli(root, ["run", "--json"], [
      "t",
      "Use the approved blue action token.",
      "The primary CTA uses the approved blue token.",
      "",
      "",
      "The primary CTA uses the approved blue token.:browser-check",
      "",
      "s",
      "a",
    ].join("\n"));

    expect(firstRun.code).toBe(0);
    expect(JSON.parse(firstRun.stdout)).toMatchObject({
      stopReason: "human_definition_required",
      actions: expect.arrayContaining([
        expect.objectContaining({ action: "needs_definition", definitionKind: "spec", definitionRef: expect.stringMatching(/^docs\/specs\//) }),
        expect.objectContaining({ action: "needs_definition", definitionKind: "adr", definitionRef: expect.stringMatching(/^docs\/adr\//) }),
        expect.objectContaining({ action: expect.stringMatching(/^created:feature-change-the-call-to-action-to-blue$/) }),
      ]),
      features: [{ id: "feature-change-the-call-to-action-to-blue", state: "ready", action: "ready_for_implementation" }],
    });

    const inbox = JSON.parse((await cli(root, ["inbox", "--json"])).stdout) as Array<{ id: string; title: string; status: string; definitionRef?: string; definitionKind?: string }>;
    expect(inbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Add notifications", status: "needs_definition", definitionKind: "spec" }),
      expect.objectContaining({ title: "Choose notification delivery architecture", status: "needs_definition", definitionKind: "adr" }),
    ]));
    expect(inbox).toHaveLength(2);
    const notifications = inbox.find((item) => item.title === "Add notifications")!;
    const architecture = inbox.find((item) => item.title === "Choose notification delivery architecture")!;
    expect(notifications.definitionRef).toMatch(/^docs\/specs\//);
    expect(architecture.definitionRef).toMatch(/^docs\/adr\//);
    const firstStatus = JSON.parse((await cli(root, ["status", "--json"])).stdout);
    expect(firstStatus).toMatchObject({ inbox: { promoted: 0, needs_definition: 2 }, features: { ready: 1, doing: 0 } });
    await expect(fs.stat(path.join(root, ".stonvik", "runtime"))).rejects.toMatchObject({ code: "ENOENT" });

    await fs.writeFile(path.join(root, notifications.definitionRef!), [
      "---",
      "stonvik:",
      "  schemaVersion: 1",
      "  source:",
      "    type: inbox",
      `    ref: ${notifications.id}`,
      "  title: Implement notifications",
      "  goal: Implement the notification design approved in this Spec.",
      "  acceptance:",
      "    - Users can receive in-app notifications.",
      "  verification:",
      "    commands: []",
      "    requiredEvidence:",
      "      - criterion: Users can receive in-app notifications.",
      "        kind: browser-check",
      "---",
      "",
      "# Technical Spec — Notifications",
    ].join("\n"));
    await fs.writeFile(path.join(root, architecture.definitionRef!), [
      "---",
      "stonvik:",
      "  schemaVersion: 1",
      "  source:",
      "    type: inbox",
      `    ref: ${architecture.id}`,
      "  title: Implement notification delivery architecture",
      "  goal: Implement the delivery architecture selected in this ADR.",
      "  acceptance:",
      "    - Notification delivery uses the decision recorded in this ADR.",
      "  verification:",
      "    commands: []",
      "    requiredEvidence:",
      "      - criterion: Notification delivery uses the decision recorded in this ADR.",
      "        kind: architecture-review",
      "---",
      "",
      "# Architecture Decision — Notification delivery",
    ].join("\n"));

    const secondRun = await cli(root, ["run", "--json"], "c\nc\n");
    expect(secondRun.code).toBe(0);
    expect(JSON.parse(secondRun.stdout)).toMatchObject({
      stopReason: "ready_for_implementation",
      features: expect.arrayContaining([
        expect.objectContaining({ id: "feature-change-the-call-to-action-to-blue", state: "ready", action: "ready_for_implementation" }),
        expect.objectContaining({ id: "feature-implement-notifications", state: "ready", action: "ready_for_implementation" }),
        expect.objectContaining({ id: "feature-implement-notification-delivery-architecture", state: "ready", action: "ready_for_implementation" }),
      ]),
    });
    const finalStatus = JSON.parse((await cli(root, ["status", "--json"])).stdout);
    expect(finalStatus).toMatchObject({ inbox: { promoted: 0, needs_definition: 0 }, features: { ready: 3, doing: 0, review: 0, done: 0 } });
    expect(JSON.parse((await cli(root, ["inbox", "--json"])).stdout)).toEqual([]);
    expect(JSON.parse((await cli(root, ["validate", "--json"])).stdout)).toMatchObject({ valid: true });
    await expect(fs.stat(path.join(root, ".stonvik", "runtime"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

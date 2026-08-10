import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCompiledCli } from "./support/cli-harness.js";

const cli = runCompiledCli;

async function fakePi(root: string, mode: "valid" | "invalid" | "blocked" | "nochange" | "changes" = "valid"): Promise<string> {
  const command = path.join(root, `fake-pi-${mode}.mjs`);
  const classification = mode === "invalid" ? {
    route: "direct",
    size: "xs",
    rationale: "One small file.",
    proposed: { verification: { commands: ["true"] } },
  } : {
    route: "auto_direct",
    size: "XS",
    estimatedTouchedFiles: 1,
    complexityScore: 1,
    confidence: 0.99,
    risks: [],
    rationale: ["One low-risk file change."],
    proposed: {
      title: "Create target file",
      goal: "Create the requested target file.",
      acceptance: ["target.txt contains after."],
      verification: { commands: [{ name: "target-content", run: "test \"$(cat target.txt)\" = \"after\"" }] },
    },
  };
  const assistant = JSON.stringify(classification);
  await fs.writeFile(command, [
    "#!/usr/bin/env node",
    "import fs from 'node:fs';",
    "if (process.argv.includes('--version')) process.exit(0);",
    "process.stdin.on('data', (chunk) => {",
    "  for (const line of chunk.toString().split('\\n')) {",
    "    if (!line.trim()) continue;",
    "    let request; try { request = JSON.parse(line); } catch { continue; }",
    "    const prompt = String(request.message ?? '');",
    `    if (prompt.includes('Classify the untrusted Inbox')) emit(${JSON.stringify(assistant)});`,
    `    else if (prompt.includes('independent, read-only Forgium Work reviewer')) emit('FORGIUM_REVIEW: ${mode === "changes" ? '{"outcome":"changes_requested","summary":"Add more coverage.","findings":[],"evidence":[]}' : '{"outcome":"approved","summary":"Independent review approved.","findings":[],"evidence":[]}'}');`,
    `    else if (prompt.includes('execution engine for Forgium')) { ${mode === "blocked" ? "emit('FORGIUM_RESULT: blocked');" : mode === "nochange" ? "emit('FORGIUM_RESULT: completed');" : "fs.writeFileSync('target.txt', 'after\\n'); emit('FORGIUM_RESULT: completed');"} }`,
    "  }",
    "});",
    "function emit(text) { process.stdout.write(JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text }] }] }) + '\\n'); process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n'); }",
  ].join("\n"));
  await fs.chmod(command, 0o755);
  return command;
}

async function json(root: string, args: string[], env?: NodeJS.ProcessEnv): Promise<any> {
  const result = await cli(root, ["--json", ...args], env);
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout);
}

describe("Forgium autonomous CLI contract", () => {
  it("runs the compiled CLI from Inbox through implementation, verification, review, and done", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-cli-contract-"));
    await json(root, ["init"]);
    await json(root, ["capture", "Create target file"]);
    await fs.writeFile(path.join(root, "target.txt"), "before\n");
    const pi = await fakePi(root);

    const result = await cli(root, ["run", "--json"], { ...process.env, FORGIUM_PI_COMMAND: pi });
    expect(result.code).toBe(0);
    const run = JSON.parse(result.stdout);
    expect(run.stopReason).toBe("idle");
    expect(run.features).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "review", action: "completed" }),
      expect.objectContaining({ state: "done", action: "approved" }),
    ]));
    await expect(fs.readFile(path.join(root, "target.txt"), "utf8")).resolves.toBe("after\n");
    expect((await json(root, ["status"])).features).toMatchObject({ done: 1, ready: 0, doing: 0, review: 0 });
    expect((await json(root, ["validate"])).valid).toBe(true);
    const work = await json(root, ["work", "list", "--state", "done"]);
    expect(work).toHaveLength(1);
    const receipts = await fs.readdir(path.join(root, "features", "done", "create-target-file", "receipts"));
    expect(receipts.map((name) => name.split("-").at(-1)?.replace(".yaml", ""))).toEqual(expect.arrayContaining(["execution", "verification", "review"]));
  }, 30_000);

  it("fails closed for invalid classifier output without inventing a definition", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-cli-invalid-classification-"));
    await json(root, ["init"]);
    await json(root, ["capture", "Create names file"]);
    const pi = await fakePi(root, "invalid");

    const result = await cli(root, ["run"], { ...process.env, FORGIUM_PI_COMMAND: pi });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Forgium status after run");
    expect(result.stdout).toContain("captured: 1");
    expect(result.stdout).toContain("Forgium could not create a complete Work proposal after one automatic repair attempt. Your Inbox is unchanged.");
    expect(result.stdout).toContain("Next: Run `forgium triage` to create the Work manually. Your Inbox has not been changed.");
    expect(result.stdout).not.toContain("Definition required:");
    expect(await json(root, ["inbox"])).toMatchObject([{ status: "captured" }]);
    const date = new Date().toISOString().slice(0, 10);
    const events = (await fs.readFile(path.join(root, "product", "events", `${date}.ndjson`), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "gate",
        inboxId: expect.stringMatching(/^inbox-/),
        message: expect.stringContaining("Forgium could not create a complete Work proposal after one automatic repair attempt."),
        nextAction: expect.stringContaining("Run `forgium triage` to create the Work manually"),
      }),
    ]));
  }, 30_000);

  it("requires human classification for non-automatic work and creates no ready Work", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-cli-human-gate-"));
    await json(root, ["init"]);
    await json(root, ["capture", "Add notifications"]);
    const classification = JSON.parse(JSON.stringify({
      route: "ask_spec", size: "M", estimatedTouchedFiles: 3, complexityScore: 3, confidence: 0.99, risks: [], rationale: ["Requires a design decision."],
      proposed: { title: "Add notifications", goal: "Add notifications.", acceptance: ["Users see notifications."], verification: { commands: [{ name: "pass", run: "true" }] } },
    }));
    const customPi = await fakePiWithClassification(root, classification);
    const result = await cli(root, ["run"], { ...process.env, FORGIUM_PI_COMMAND: customPi }, "s\n");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("awaiting definition: 1");
    expect(await json(root, ["work", "list", "--state", "ready"])).toEqual([]);
    expect(await json(root, ["inbox"])).toMatchObject([{ status: "needs_definition", definitionKind: "spec" }]);
  }, 30_000);

  it("does not advance to review when verification fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-cli-verification-gate-"));
    await json(root, ["init"]);
    await json(root, ["capture", "Create target file"]);
    await fs.writeFile(path.join(root, "target.txt"), "before\n");
    const pi = await fakePi(root, "nochange");
    const result = await cli(root, ["run", "--json"], { ...process.env, FORGIUM_PI_COMMAND: pi });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ stopReason: "verification_failed", features: [expect.objectContaining({ state: "doing" })] });
    expect(await json(root, ["work", "list", "--state", "review"])).toEqual([]);
    expect(await json(root, ["work", "list", "--state", "done"])).toEqual([]);
  }, 30_000);

  it("stops and preserves evidence when the execution engine blocks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-cli-blocked-gate-"));
    await json(root, ["init"]);
    await json(root, ["capture", "Create target file"]);
    const pi = await fakePi(root, "blocked");
    const result = await cli(root, ["run", "--json"], { ...process.env, FORGIUM_PI_COMMAND: pi });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ stopReason: "feature_blocked", features: [expect.objectContaining({ state: "blocked", action: "blocked" })] });
    expect(await json(root, ["work", "list", "--state", "blocked"])).toHaveLength(1);
    expect(await json(root, ["work", "list", "--state", "done"])).toEqual([]);
  }, 30_000);

  it("requires an explicit split decision for XL work", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-cli-xl-gate-"));
    await json(root, ["init"]);
    await json(root, ["capture", "Refactor all packages"]);
    const pi = await fakePiWithClassification(root, {
      route: "split", size: "XL", estimatedTouchedFiles: 9, complexityScore: 5, confidence: 0.99, risks: [], rationale: ["More than eight files."],
      proposed: { title: "Refactor all packages", goal: "Refactor all packages.", acceptance: ["All packages are refactored."], verification: { commands: [{ name: "pass", run: "true" }] } },
    });
    const result = await cli(root, ["run"], { ...process.env, FORGIUM_PI_COMMAND: pi }, "p\n");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("captured: 1");
    expect(result.stdout).toContain("Split inbox-");
    expect(await json(root, ["work", "list", "--state", "ready"])).toEqual([]);
    expect(await json(root, ["inbox"])).toMatchObject([{ status: "captured" }]);
  }, 30_000);

  it("returns review changes to doing and resumes the same Work", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-cli-review-changes-"));
    await json(root, ["init"]);
    await json(root, ["capture", "Create target file"]);
    await fs.writeFile(path.join(root, "target.txt"), "before\n");
    const changesPi = await fakePi(root, "changes");
    const first = await cli(root, ["run", "--json"], { ...process.env, FORGIUM_PI_COMMAND: changesPi });
    expect(JSON.parse(first.stdout)).toMatchObject({ stopReason: "changes_requested", features: [expect.objectContaining({ state: "review", action: "completed" }), expect.objectContaining({ state: "doing", action: "changes_requested" })] });
    const approvedPi = await fakePi(root, "valid");
    const second = await cli(root, ["run", "--json"], { ...process.env, FORGIUM_PI_COMMAND: approvedPi });
    expect(JSON.parse(second.stdout)).toMatchObject({ stopReason: "idle", features: expect.arrayContaining([expect.objectContaining({ state: "done", action: "approved" })]) });
  }, 30_000);

  it("selects ready Work deterministically and does not start a second before the first completes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-cli-selection-"));
    await json(root, ["init"]);
    for (const title of ["First ready Work", "Second ready Work"]) {
      const created = await cli(root, ["--json", "work", "create", "--title", title, "--goal", `Implement ${title}.`, "--acceptance", "target.txt contains after.", "--verify-command", "test \"$(cat target.txt)\" = \"after\"", "--json"]);
      expect(created.code).toBe(0);
    }
    await fs.writeFile(path.join(root, "target.txt"), "before\n");
    const pi = await fakePi(root);
    const result = await cli(root, ["run", "--json"], { ...process.env, FORGIUM_PI_COMMAND: pi });
    const run = JSON.parse(result.stdout);
    expect(run.stopReason).toBe("idle");
    expect(run.features.filter((feature: { state: string }) => feature.state === "done").map((feature: { id: string }) => feature.id)).toEqual([
      "feature-first-ready-work",
      "feature-second-ready-work",
    ]);
    expect(await json(root, ["work", "list", "--state", "doing"])).toEqual([]);
  }, 30_000);

  it("edits and confirms a human definition through public CLI commands", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-cli-definition-"));
    await json(root, ["init"]);
    await json(root, ["capture", "Add notifications"]);
    const classifier = await fakePiWithClassification(root, {
      route: "ask_spec", size: "M", estimatedTouchedFiles: 3, complexityScore: 3, confidence: 0.99, risks: [], rationale: ["Requires a human specification."],
      proposed: { title: "Add notifications", goal: "Add notifications.", acceptance: ["Users see notifications."], verification: { commands: [{ name: "target-content", run: "test \"$(cat target.txt)\" = \"after\"" }] } },
    });
    const first = await cli(root, ["run"], { ...process.env, FORGIUM_PI_COMMAND: classifier }, "s\n");
    expect(first.stdout).toContain("awaiting definition: 1");
    const item = (await json(root, ["inbox"])).find((candidate: { status: string }) => candidate.status === "needs_definition") as { id: string };
    const editor = await definitionEditor(root, item.id);
    const edited = await cli(root, ["definition", "edit", item.id], { ...process.env, EDITOR: editor });
    expect(edited.code).toBe(0);
    await fs.writeFile(path.join(root, "target.txt"), "before\n");
    const executor = await fakePi(root);
    const second = await cli(root, ["run", "--json"], { ...process.env, FORGIUM_PI_COMMAND: executor }, "c\n");
    expect(JSON.parse(second.stdout)).toMatchObject({ stopReason: "idle", features: expect.arrayContaining([expect.objectContaining({ state: "done", action: "approved" })]) });
    expect(await json(root, ["inbox"])).toEqual([]);
  }, 30_000);
});

async function fakePiWithClassification(root: string, classification: object): Promise<string> {
  const command = path.join(root, "fake-pi-custom-classification.mjs");
  const assistant = JSON.stringify(classification);
  await fs.writeFile(command, [
    "#!/usr/bin/env node",
    "if (process.argv.includes('--version')) process.exit(0);",
    "process.stdin.on('data', () => {",
    `  process.stdout.write(JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: ${JSON.stringify(assistant)} }] }] }) + '\\n');`,
    "  process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');",
    "});",
  ].join("\n"));
  await fs.chmod(command, 0o755);
  return command;
}

async function definitionEditor(root: string, inboxId: string): Promise<string> {
  const command = path.join(root, "definition-editor.mjs");
  await fs.writeFile(command, [
    "#!/usr/bin/env node",
    "import fs from 'node:fs';",
    `const inboxId = ${JSON.stringify(inboxId)};`,
    "const document = `---\nforgium:\n  schemaVersion: 1\n  source:\n    type: inbox\n    ref: ${inboxId}\n  title: Add notifications\n  goal: Add notifications.\n  acceptance:\n    - Users see notifications.\n  verification:\n    commands:\n      - name: target-content\n        run: 'test \"$(cat target.txt)\" = \"after\"'\n---\n\n# Technical Spec — Add notifications\n`;",
    "fs.writeFileSync(process.argv[2], document);",
  ].join("\n"));
  await fs.chmod(command, 0o755);
  return command;
}

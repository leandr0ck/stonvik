import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { FilesystemStonvikRepository } from "../../core/index.js";

const execFile = promisify(execFileCallback);

async function tempRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stonvik-test-"));
  await fs.mkdir(path.join(root, ".git"));
  const repo = new FilesystemStonvikRepository(root);
  await repo.init();
  return { root, repo };
}

describe("FilesystemStonvikRepository", () => {
  it("initializes and captures work outside a Git repository", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "stonvik-no-git-test-"));
    const cli = path.resolve(process.cwd(), "src/cli/index.ts");
    const tsx = path.resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");

    await execFile(process.execPath, [tsx, cli, "init"], { cwd: root });
    const { stdout } = await execFile(process.execPath, [tsx, cli, "capture", "Create an example file"], { cwd: root });

    expect(stdout).toContain("Captured inbox-");
    await expect(fs.readdir(path.join(root, "product/inbox"))).resolves.toHaveLength(2); // item.md + review/
  });

  it("initializes required directories", async () => {
    const { root } = await tempRepo();
    await expect(fs.stat(path.join(root, "product/inbox"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(root, "features/ready"))).resolves.toBeTruthy();
    await expect(fs.readFile(path.join(root, ".gitignore"), "utf8")).resolves.toContain(".stonvik/runtime/");
    await expect(fs.stat(path.join(root, ".stonvik"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("captures and parses inbox items", async () => {
    const { repo } = await tempRepo();
    const item = await repo.capture({ text: "Add WhatsApp button\n\nUse configured number." });
    expect(item.id).toMatch(/^inbox-/);
    const inbox = await repo.listInbox();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.title).toBe("Add WhatsApp button");
    expect(inbox[0]?.body).toContain("configured number");
  });

  it("persists a typed clarification answer without changing raw Inbox intent", async () => {
    const { repo } = await tempRepo();
    const inbox = await repo.capture({ text: "Create a Markdown file" });
    const pending = await repo.requestInboxClarification(inbox.id, "output_path");
    expect(pending).toMatchObject({ status: "needs_clarification", clarification: { field: "output_path" } });

    const answered = await repo.answerInboxClarification(inbox.id, "people.md");
    expect(answered).toMatchObject({ status: "captured", clarification: { field: "output_path", answer: "people.md" }, title: "Create a Markdown file" });
    await expect(repo.validate()).resolves.toMatchObject({ valid: true });
  });

  it("creates features and transitions through the default lifecycle", async () => {
    const { root, repo } = await tempRepo();
    const feature = await repo.createFeature({ title: "Add WhatsApp Button", goal: "Add a storefront contact button.", acceptance: ["Button is visible"], verification: { commands: [{ name: "pass", run: "true" }] } });
    expect(feature.state).toBe("ready");
    expect((await repo.getStatus()).features.ready).toBe(1);

    const doing = await repo.startFeature(feature.id);
    expect(doing.state).toBe("doing");
    await expect(fs.readdir(path.join(root, ".stonvik/runtime/runs"))).resolves.toHaveLength(1);
    expect(await repo.inspectExecutionMode(feature.id)).toEqual({ kind: "direct" });

    const review = await repo.submitForReview(feature.id);
    expect(review.state).toBe("review");

    const done = await repo.reviewFeature(feature.id, "approved", "Reviewed in test.");
    expect(done.state).toBe("done");
  });

  it("moves Inbox provenance and classification evidence with its Work", async () => {
    const { root, repo } = await tempRepo();
    const inbox = await repo.capture({ text: "Add notifications\n\nNotify users about updates." });
    await repo.recordClassification(inbox, {
      route: "auto_direct",
      size: "S",
      estimatedTouchedFiles: 2,
      complexityScore: 2,
      confidence: 0.9,
      risks: [],
      rationale: ["Small isolated change."],
      proposed: {
        title: "Add notifications",
        goal: "Notify users about updates.",
        acceptance: ["Users see notifications."],
        verification: { commands: [{ name: "pass", run: "true" }] },
      },
    }, "run-test");

    const feature = await repo.createFeatureFromInbox(inbox.id, {
      title: "Add notifications",
      goal: "Notify users about updates.",
      acceptance: ["Users see notifications."],
      verification: { commands: [{ name: "pass", run: "true" }] },
    });

    expect(await repo.listInbox()).toEqual([]);
    await expect(fs.readFile(path.join(feature.path, "provenance", "inbox", path.basename(inbox.path)), "utf8")).resolves.toContain("status: promoted");
    await expect(fs.readdir(path.join(feature.path, "provenance", "classification"))).resolves.toEqual([`${inbox.id}-run-test.yaml`]);
    await expect(fs.readdir(path.join(root, "product", "inbox-receipts"))).resolves.toEqual([]);

    const done = await repo.startFeature(feature.id).then((item) => repo.submitForReview(item.id)).then((item) => repo.reviewFeature(item.id, "approved", "Reviewed."));
    await expect(fs.stat(path.join(done.path, "provenance", "inbox", path.basename(inbox.path)))).resolves.toBeTruthy();
    await expect(repo.validate()).resolves.toMatchObject({ valid: true });
  });

  it("rejects semantically invalid classifications before writing durable evidence", async () => {
    const { root, repo } = await tempRepo();
    const inbox = await repo.capture({ text: "Create names.md" });

    await expect(repo.recordClassification(inbox, {
      route: "auto_direct", size: "XS", estimatedTouchedFiles: 1, complexityScore: 2, confidence: 0.9, risks: [], rationale: ["Small change."],
      proposed: { title: "Create names.md", goal: "Create names.md.", acceptance: ["names.md exists."], verification: { commands: [{ name: "pass", run: "true" }] } },
    }, "run-invalid")).rejects.toThrow("complexityScore");

    await expect(fs.readdir(path.join(root, "product", "inbox-receipts"))).resolves.toEqual([]);
  });

  it("appends events to an isolated run stream that validates with historical event files", async () => {
    const { root, repo } = await tempRepo();
    const date = "2026-07-17";
    for (const sequence of [1, 2]) {
      await repo.persistEvent({
        schemaVersion: 2, eventId: `event-run-perf-${sequence}`, runId: "run/perf", sequence,
        at: `${date}T00:00:0${sequence}.000Z`, type: "status", kind: "classification.started", phase: "classification", severity: "info", message: "Classifying.",
      });
    }

    const eventPath = path.join(root, "product", "events", date, "run%2Fperf.ndjson");
    await expect(fs.readFile(eventPath, "utf8")).resolves.toMatch(/event-run-perf-1[\s\S]*event-run-perf-2/);
    await expect(repo.validate()).resolves.toMatchObject({ valid: true });
  });

  it("rejects duplicate or unordered event records before appending them", async () => {
    const { root, repo } = await tempRepo();
    const event = {
      schemaVersion: 2 as const, eventId: "event-once", runId: "run-ordered", sequence: 1,
      at: "2026-07-17T00:00:01.000Z", type: "status" as const, message: "Classifying.",
    };
    await repo.persistEvent(event);
    const eventPath = path.join(root, "product", "events", "2026-07-17", "run-ordered.ndjson");
    const persisted = await fs.readFile(eventPath, "utf8");

    await expect(repo.persistEvent({ ...event, at: "2026-07-17T00:00:02.000Z" })).rejects.toThrow("Duplicate run event ID");
    await expect(repo.persistEvent({ ...event, eventId: "event-out-of-order", sequence: 1, at: "2026-07-17T00:00:03.000Z" })).rejects.toThrow("sequence is not increasing");
    await expect(fs.readFile(eventPath, "utf8")).resolves.toBe(persisted);
    await expect(repo.validate()).resolves.toMatchObject({ valid: true });
  });

  it("migrates legacy promoted Inbox provenance without deleting evidence", async () => {
    const { root, repo } = await tempRepo();
    const inbox = await repo.capture({ text: "Add notifications" });
    const feature = await repo.createFeature({
      title: "Add notifications",
      goal: "Notify users about updates.",
      acceptance: ["Users see notifications."],
      source: { type: "inbox", ref: inbox.id },
      verification: { commands: [{ name: "pass", run: "true" }] },
    });
    await repo.recordClassification(inbox, {
      route: "auto_direct", size: "XS", estimatedTouchedFiles: 1, complexityScore: 1, confidence: 0.9, risks: [], rationale: ["Small change."],
      proposed: { title: "Add notifications", goal: "Notify users about updates.", acceptance: ["Users see notifications."], verification: { commands: [{ name: "pass", run: "true" }] } },
    }, "run-legacy");
    await fs.writeFile(inbox.path, (await fs.readFile(inbox.path, "utf8"))
      .replace("status: captured\n", `status: promoted\nfeatureRef: ${feature.id}\n`));

    await expect(repo.migrateInboxProvenance()).resolves.toEqual({ migrated: [inbox.id], skipped: [] });
    await expect(fs.readFile(path.join(root, "features", "ready", "add-notifications", "provenance", "inbox", path.basename(inbox.path)), "utf8")).resolves.toContain(`featureRef: ${feature.id}`);
    await expect(repo.validate()).resolves.toMatchObject({ valid: true });
  });

  it("detects spec-flow execution profiles", async () => {
    const { repo } = await tempRepo();
    const feature = await repo.createFeature({ title: "Progressive Web App", goal: "Make storefronts installable.", acceptance: ["Manifest exists"], verification: { commands: [{ name: "pass", run: "true" }] } });
    await fs.writeFile(path.join(feature.path, "spec.md"), "# Spec");
    const needsPlan = await repo.inspectExecutionMode(feature.id);
    expect(needsPlan.kind).toBe("spec-needs-plan");
    expect(needsPlan).toMatchObject({ commands: expect.objectContaining({ init: expect.stringContaining(feature.path), implement: expect.stringContaining(feature.path) }) });
    await fs.mkdir(path.join(feature.path, "tickets"));
    const specFlow = await repo.inspectExecutionMode(feature.id);
    expect(specFlow.kind).toBe("spec-flow");
    expect(specFlow).toMatchObject({ commands: expect.objectContaining({ implement: expect.stringContaining(feature.path), next: expect.stringContaining(feature.path) }) });
  });
});

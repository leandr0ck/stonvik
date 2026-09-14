import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FilesystemStonvikRepository, type ActorRef, type ExternalExecutionReport } from "../../core/index.js";

async function tempRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stonvik-phases-"));
  const repo = new FilesystemStonvikRepository(root);
  await repo.init();
  return { root, repo };
}

const triager: ActorRef = { type: "human", name: "product", role: "triager" };
const implementer: ActorRef = { type: "agent", name: "builder", role: "implementer" };
const reviewer: ActorRef = { type: "human", name: "reviewer", role: "reviewer" };

function completedReport(): ExternalExecutionReport {
  return { schemaVersion: 1, actor: implementer, outcome: "completed", summary: "Implementation completed." };
}

describe("Stonvik phase workflow", () => {
  it("keeps user-owned spec and ADR documents free-form and links them to Work", async () => {
    const { root, repo } = await tempRepo();
    const inbox = await repo.capture({ text: "Add notifications\nNotify users about important events." });

    const triaged = await repo.triageInbox(inbox.id, { route: "spec", actor: triager });
    expect(triaged.status).toBe("needs_definition");
    expect(await repo.listFeatures()).toEqual([]);
    await expect(fs.stat(path.join(root, "features", "definition"))).rejects.toMatchObject({ code: "ENOENT" });

    const specPath = path.join(root, "planning", "notifications.design");
    const adrPath = path.join(root, "architecture", "notifications.record");
    await fs.mkdir(path.dirname(specPath), { recursive: true });
    await fs.mkdir(path.dirname(adrPath), { recursive: true });
    await fs.writeFile(specPath, "This is a free-form design document.\n");
    await fs.writeFile(adrPath, "This is a free-form architecture decision record.\n");

    const work = await repo.defineWorkFromInbox(inbox.id, {
      title: inbox.title,
      goal: "Users receive important notifications.",
      acceptance: ["A notification is delivered for an important event."],
      definitions: [
        { kind: "spec", path: "planning/notifications.design" },
        { kind: "adr", path: "architecture/notifications.record" },
      ],
      verification: { commands: [{ name: "pass", run: "true" }] },
    });

    expect(work.state).toBe("ready");
    expect(work.manifest.definitions).toEqual([
      { kind: "spec", path: "planning/notifications.design" },
      { kind: "adr", path: "architecture/notifications.record" },
    ]);
    expect(await repo.listInbox()).toEqual([]);
    await expect(fs.readFile(specPath, "utf8")).resolves.toContain("free-form");
    await expect(repo.validate()).resolves.toMatchObject({ valid: true });
  });

  it("runs Triage, Implement, Verify, Review, and Ship as separate gates", async () => {
    const { root, repo } = await tempRepo();
    const inbox = await repo.capture({ text: "Create report.md" });
    await repo.triageInbox(inbox.id, { route: "direct", actor: triager });
    const work = await repo.defineWorkFromInbox(inbox.id, {
      title: inbox.title,
      goal: "Create the report file.",
      acceptance: ["report.md exists."],
      verification: { commands: [{ name: "report-exists", run: "test -f report.md" }] },
    });

    await repo.startWork(work.id, implementer);
    await fs.writeFile(path.join(root, "report.md"), "done\n");
    await repo.recordExternalExecutionReport(work.id, completedReport());
    const verification = await repo.verifyWork(work.id);
    expect(verification.outcome).toBe("passed");
    expect((await repo.getFeature(work.id))?.state).toBe("review");

    await expect(repo.shipWork(work.id)).rejects.toMatchObject({ code: "REVIEW_RECEIPT_REQUIRED" });
    const reviewed = await repo.reviewWork(work.id, reviewer, "approved", "The implementation meets the acceptance criteria.");
    expect(reviewed.state).toBe("review");

    const shipped = await repo.shipWork(work.id);
    expect(shipped.state).toBe("done");
    expect((await repo.listReceipts(work.id)).map((receipt) => receipt.kind)).toEqual(["execution", "execution", "verification", "review"]);
  });

  it("rejects missing or reserved definition documents", async () => {
    const { repo } = await tempRepo();
    const inbox = await repo.capture({ text: "Add architecture" });
    await repo.triageInbox(inbox.id, { route: "adr", actor: triager });

    await expect(repo.defineWorkFromInbox(inbox.id, {
      title: inbox.title,
      goal: "Record the architecture decision.",
      acceptance: ["The decision is documented."],
      definitions: [{ kind: "adr", path: "missing/decision.md" }],
      verification: { commands: [{ name: "pass", run: "true" }] },
    })).rejects.toThrow("does not exist");

    await expect(repo.defineWorkFromInbox(inbox.id, {
      title: inbox.title,
      goal: "Record the architecture decision.",
      acceptance: ["The decision is documented."],
      definitions: [{ kind: "adr", path: ".stonvik/runtime/internal.md" }],
      verification: { commands: [{ name: "pass", run: "true" }] },
    })).rejects.toThrow("user-owned repository file");
  });
});

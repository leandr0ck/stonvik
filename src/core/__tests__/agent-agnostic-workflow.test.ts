import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FilesystemStonvikRepository, type ActorRef, type ExternalExecutionReport } from "../../core/index.js";

async function tempRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stonvik-agent-agnostic-"));
  const repo = new FilesystemStonvikRepository(root);
  await repo.init();
  return { root, repo };
}

const triager: ActorRef = { type: "human", name: "lean", role: "triager" };
const implementer: ActorRef = { type: "agent", name: "codex", role: "implementer" };
const reviewer: ActorRef = { type: "human", name: "reviewer", role: "reviewer" };

function completedReport(): ExternalExecutionReport {
  return { schemaVersion: 1, actor: implementer, outcome: "completed", summary: "The external actor completed the requested work." };
}

describe("agent-agnostic workflow", () => {
  it("keeps triage, definition, execution, verification, review, and shipping independent", async () => {
    const { root, repo } = await tempRepo();
    const inbox = await repo.capture({ text: "Create report.md", source: "human:terminal" });
    const triaged = await repo.triageInbox(inbox.id, { route: "direct", actor: triager });
    expect(triaged.status).toBe("captured");

    const work = await repo.defineWorkFromInbox(inbox.id, {
      title: inbox.title,
      goal: "Create the report file.",
      acceptance: ["report.md exists."],
      verification: { commands: [{ name: "report-exists", run: "test -f report.md" }] },
    });
    expect(work.manifest.routingDecision?.decidedBy).toMatchObject({ type: "human", name: "lean" });
    expect(await repo.listInbox()).toEqual([]);

    await repo.startWork(work.id, implementer);
    await expect(repo.startWork(work.id, { type: "agent", name: "other", role: "implementer" })).rejects.toMatchObject({ code: "WORK_CLAIM_CONFLICT" });
    const handoff = await repo.createWorkHandoff(work.id);
    expect(JSON.stringify(handoff)).not.toMatch(/pi|spec flow|model/i);
    expect(handoff.work.definitions).toBeUndefined();
    expect(handoff.protocol.shipCommand).toBe(`stonvik ship ${work.id}`);

    await fs.writeFile(path.join(root, "report.md"), "ready\n");
    await repo.recordExternalExecutionReport(work.id, completedReport());
    const verification = await repo.verifyWork(work.id);
    expect(verification.outcome).toBe("passed");
    expect((await repo.getFeature(work.id))?.state).toBe("review");

    const reviewed = await repo.reviewWork(work.id, reviewer, "approved", "The implementation satisfies the contract.");
    expect(reviewed.state).toBe("review");
    const shipped = await repo.shipWork(work.id);
    expect(shipped.state).toBe("done");
  });

  it("requires a matching user-owned definition for spec and ADR triage", async () => {
    const { root, repo } = await tempRepo();
    const inbox = await repo.capture({ text: "Change the public API authentication layer" });
    await repo.triageInbox(inbox.id, { route: "spec", actor: triager });

    await expect(repo.defineWorkFromInbox(inbox.id, {
      title: inbox.title,
      goal: "Implement the approved change.",
      acceptance: ["The approved behavior is implemented."],
      verification: { commands: [{ name: "pass", run: "true" }] },
    })).rejects.toThrow("requires a matching user-owned definition");

    const document = path.join(root, "design", "api.md");
    await fs.mkdir(path.dirname(document), { recursive: true });
    await fs.writeFile(document, "The team defines this format, not Stonvik.\n");
    const work = await repo.defineWorkFromInbox(inbox.id, {
      title: inbox.title,
      goal: "Implement the approved change.",
      acceptance: ["The approved behavior is implemented."],
      definitions: [{ kind: "spec", path: "design/api.md" }],
      verification: { commands: [{ name: "pass", run: "true" }] },
    });
    expect(work.manifest.definitions).toEqual([{ kind: "spec", path: "design/api.md" }]);
  });
});

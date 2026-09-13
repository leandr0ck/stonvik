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
const productOwner: ActorRef = { type: "human", name: "owner", role: "product-owner" };

function completedReport(actor: ActorRef = implementer): ExternalExecutionReport {
  return {
    schemaVersion: 1,
    actor,
    outcome: "completed",
    summary: "The external actor completed the requested work.",
    evidence: [],
  };
}

describe("agent-agnostic workflow", () => {
  it("runs a direct Work through external execution, verification, and independent review", async () => {
    const { root, repo } = await tempRepo();
    const inbox = await repo.capture({ text: "Create report.md", source: "human:terminal" });

    const prepared = await repo.prepareWork(inbox.id, { route: "direct", actor: triager });
    expect(prepared.manifest.kind).toBe("implementation");
    expect(prepared.manifest.routingDecision?.decidedBy).toMatchObject({ type: "human", name: "lean" });
    expect(await repo.listInbox()).toEqual([]);

    const started = await repo.startWork(prepared.id, implementer);
    expect(started.state).toBe("doing");
    await expect(repo.startWork(prepared.id, { type: "agent", name: "other", role: "implementer" })).rejects.toMatchObject({ code: "WORK_CLAIM_CONFLICT" });
    const handoff = await repo.createWorkHandoff(prepared.id);
    expect(JSON.stringify(handoff)).not.toMatch(/pi|spec flow|model/i);
    expect(handoff.work.kind).toBe("implementation");

    await fs.writeFile(path.join(root, "report.md"), "ready\n");
    await repo.recordExternalExecutionReport(prepared.id, completedReport());
    expect((await repo.getFeature(prepared.id))?.state).toBe("doing");

    const verification = await repo.verifyWork(prepared.id);
    expect(verification.outcome).toBe("passed");
    expect((await repo.getFeature(prepared.id))?.state).toBe("review");

    const done = await repo.reviewWork(prepared.id, reviewer, "approved", "The implementation satisfies the contract.");
    expect(done.state).toBe("done");
    expect((await repo.listReceipts(prepared.id)).some((receipt) => receipt.kind === "review" && receipt.actor.name === "reviewer")).toBe(true);
  });

  it("rejects self-review and direct routing for risky work", async () => {
    const { root, repo } = await tempRepo();
    const inbox = await repo.capture({ text: "Change the public API authentication persistence layer" });

    await expect(repo.prepareWork(inbox.id, { route: "direct", actor: triager })).rejects.toMatchObject({ code: "ROUTING_POLICY_VIOLATION" });
    const approvedException = await repo.prepareWork(inbox.id, { route: "direct", actor: productOwner });
    expect(approvedException.manifest.routingDecision?.decidedBy.role).toBe("product-owner");

    const safeInbox = await repo.capture({ text: "Create notes.md" });
    const work = await repo.prepareWork(safeInbox.id, { route: "direct", actor: triager });
    await repo.startWork(work.id, implementer);
    await fs.writeFile(path.join(root, "notes.md"), "ready\n");
    await repo.recordExternalExecutionReport(work.id, completedReport());
    await repo.verifyWork(work.id);

    await expect(repo.reviewWork(work.id, implementer, "approved", "I approve my own work.")).rejects.toMatchObject({ code: "REVIEW_SELF_APPROVAL" });
  });

  it("supports spec-first Work and creates implementation from an approved specification", async () => {
    const { root, repo } = await tempRepo();
    const inbox = await repo.capture({ text: "Add CSV export" });
    const specification = await repo.prepareWork(inbox.id, { route: "spec-first", actor: triager });

    expect(specification.manifest.kind).toBe("specification");
    expect(specification.artifacts.spec).toBeDefined();
    await repo.startWork(specification.id, { type: "agent", name: "specifier", role: "specifier" });
    await fs.writeFile(path.join((await repo.getFeature(specification.id))!.path, "spec.md"), [
      "# Add CSV export",
      "",
      "## Problem",
      "Users need portable report data.",
      "",
      "## Scope",
      "Export the current report as CSV.",
      "",
      "## Acceptance",
      "- A CSV export is available.",
      "",
      "## Constraints",
      "- Preserve existing report behavior.",
      "",
      "## Verification",
      "- `true`",
      "",
    ].join("\n"));
    await repo.recordExternalExecutionReport(specification.id, completedReport({ type: "agent", name: "specifier", role: "specifier" }));
    await repo.verifyWork(specification.id);
    await repo.reviewWork(specification.id, reviewer, "approved", "The specification is complete.");

    const implementation = await repo.createImplementationFromSpecification(specification.id);
    expect(implementation.state).toBe("ready");
    expect(implementation.manifest.kind).toBe("implementation");
    expect(implementation.manifest.specificationRef).toBe(specification.id);
    expect(implementation.artifacts.spec).toBeUndefined();
    await expect(fs.stat(path.join(root, "features", "done", path.basename(specification.path), "spec.md"))).resolves.toBeTruthy();
  });
});

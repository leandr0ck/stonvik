import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { FilesystemStonvikRepository } from "../../core/index.js";

async function tempRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stonvik-receipts-test-"));
  const repo = new FilesystemStonvikRepository(root);
  await repo.init();
  return { root, repo };
}

describe("verification receipts and review", () => {
  it("records a passing verification and requires an explicit review", async () => {
    const { repo } = await tempRepo();
    const feature = await repo.createFeature({
      title: "Run checks",
      goal: "Verify the implementation.",
      acceptance: ["Checks are recorded"],
      verification: { commands: [{ name: "pass", run: `${process.execPath} -e "process.stdout.write('ok')"` }] }
    });
    await repo.startWork(feature.id, { type: "agent", name: "builder", role: "implementer" });
    await repo.recordExternalExecutionReport(feature.id, {
      schemaVersion: 1,
      actor: { type: "agent", name: "builder", role: "implementer" },
      outcome: "completed",
      summary: "Implementation completed.",
    });

    const verification = await repo.verifyWork(feature.id);

    expect(verification.outcome).toBe("passed");
    expect((await repo.getFeature(feature.id))?.state).toBe("review");
    await expect(repo.shipWork(feature.id)).rejects.toMatchObject({ code: "REVIEW_RECEIPT_REQUIRED" });

    const reviewed = await repo.reviewWork(feature.id, { type: "human", name: "reviewer", role: "reviewer" }, "approved", "Checks passed and acceptance reviewed.");
    const done = await repo.shipWork(reviewed.id);
    const receipts = await repo.listReceipts(done.id);

    expect(done.state).toBe("done");
    expect(receipts.map((receipt) => receipt.kind)).toEqual(["execution", "execution", "verification", "review"]);
  });

  it("keeps a Feature doing and records a handoff when verification fails", async () => {
    const { repo } = await tempRepo();
    const feature = await repo.createFeature({
      title: "Failing checks",
      goal: "Expose failed verification.",
      acceptance: ["The failure is durable"],
      verification: { commands: [{ name: "fail", run: `${process.execPath} -e "process.exit(2)"` }] }
    });
    await repo.startWork(feature.id, { type: "agent", name: "builder", role: "implementer" });

    const verification = await repo.verifyFeature(feature.id);
    const receipts = await repo.listReceipts(feature.id);

    expect(verification.outcome).toBe("failed");
    expect((await repo.getFeature(feature.id))?.state).toBe("doing");
    expect(receipts.map((receipt) => receipt.kind)).toEqual(["execution", "verification", "handoff"]);
  });

  it("moves review back to doing when changes are requested", async () => {
    const { repo } = await tempRepo();
    const feature = await repo.createFeature({ title: "Review me", goal: "Review the change.", acceptance: ["A reviewer decides"], verification: { commands: [{ name: "pass", run: "true" }] } });
    await repo.startWork(feature.id, { type: "agent", name: "builder", role: "implementer" });
    await repo.recordExternalExecutionReport(feature.id, {
      schemaVersion: 1,
      actor: { type: "agent", name: "builder", role: "implementer" },
      outcome: "completed",
      summary: "Implementation completed.",
    });
    await repo.verifyWork(feature.id);

    const result = await repo.reviewWork(feature.id, { type: "human", name: "reviewer", role: "reviewer" }, "changes_requested", "Add missing coverage.");

    expect(result.state).toBe("doing");
    await expect(repo.listReceipts(feature.id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "review", outcome: "changes_requested" })
    ]));
  });

  it("reports receipts with broken local references during validation", async () => {
    const { repo } = await tempRepo();
    const feature = await repo.createFeature({ title: "Broken evidence", goal: "Validate receipts.", acceptance: ["Invalid references are visible"], verification: { commands: [{ name: "pass", run: "true" }] } });
    const receiptsPath = path.join(feature.path, "receipts");
    await fs.mkdir(receiptsPath);
    await fs.writeFile(path.join(receiptsPath, "receipt-bad.yaml"), YAML.stringify({
      schemaVersion: 1,
      id: "receipt-20260712T100000Z-a8f4-review",
      kind: "review",
      created: "2026-07-12T10:00:00.000Z",
      feature: { id: feature.id, manifestPath: "missing-manifest.yaml" },
      runId: "review-test",
      actor: { type: "reviewer", name: "test" },
      outcome: "approved",
      summary: "Invalid reference",
      decision: "approved"
    }));

    const report = await repo.validate();

    expect(report.valid).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "INVALID_RECEIPT", path: feature.path })]));
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { FilesystemForgiumRepository } from "../../core/index.js";

async function tempRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-receipts-test-"));
  const repo = new FilesystemForgiumRepository(root);
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
    await repo.startFeature(feature.id);

    const verification = await repo.verifyFeature(feature.id);

    expect(verification.outcome).toBe("passed");
    expect((await repo.getFeature(feature.id))?.state).toBe("review");
    await expect(repo.completeFeature(feature.id)).rejects.toMatchObject({ code: "REVIEW_RECEIPT_REQUIRED" });

    const done = await repo.reviewFeature(feature.id, "approved", "Checks passed and acceptance reviewed.");
    const receipts = await repo.listReceipts(done.id);

    expect(done.state).toBe("done");
    expect(receipts.map((receipt) => receipt.kind)).toEqual(["verification", "review"]);
  });

  it("keeps a Feature doing and records a handoff when verification fails", async () => {
    const { repo } = await tempRepo();
    const feature = await repo.createFeature({
      title: "Failing checks",
      goal: "Expose failed verification.",
      acceptance: ["The failure is durable"],
      verification: { commands: [{ name: "fail", run: `${process.execPath} -e "process.exit(2)"` }] }
    });
    await repo.startFeature(feature.id);

    const verification = await repo.verifyFeature(feature.id);
    const receipts = await repo.listReceipts(feature.id);

    expect(verification.outcome).toBe("failed");
    expect((await repo.getFeature(feature.id))?.state).toBe("doing");
    expect(receipts.map((receipt) => receipt.kind)).toEqual(["verification", "handoff"]);
  });

  it("moves review back to doing when changes are requested", async () => {
    const { repo } = await tempRepo();
    const feature = await repo.createFeature({ title: "Review me", goal: "Review the change.", acceptance: ["A reviewer decides"] });
    await repo.startFeature(feature.id);
    await repo.submitForReview(feature.id);

    const result = await repo.reviewFeature(feature.id, "changes_requested", "Add missing coverage.");

    expect(result.state).toBe("doing");
    await expect(repo.listReceipts(feature.id)).resolves.toMatchObject([
      expect.objectContaining({ kind: "review", outcome: "changes_requested" })
    ]);
  });

  it("reports receipts with broken local references during validation", async () => {
    const { repo } = await tempRepo();
    const feature = await repo.createFeature({ title: "Broken evidence", goal: "Validate receipts.", acceptance: ["Invalid references are visible"] });
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

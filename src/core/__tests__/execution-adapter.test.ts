import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DeterministicExecutionAdapter, ExecutionAdapterRegistry, FilesystemForgiumRepository } from "../../core/index.js";

async function tempRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-adapter-test-"));
  const repo = new FilesystemForgiumRepository(root);
  await repo.init();
  return { root, repo };
}

describe("execution adapters", () => {
  it("executes a completed result, verifies it, and stops at review", async () => {
    const { repo } = await tempRepo();
    const feature = await repo.createFeature({ title: "Adapter work", goal: "Run through an adapter.", acceptance: ["The adapter result is recorded"] });
    const registry = new ExecutionAdapterRegistry([new DeterministicExecutionAdapter()]);

    const result = await repo.executeFeature(feature.id, registry);
    const receipts = await repo.listReceipts(feature.id);

    expect(result.outcome).toBe("completed");
    expect(result.feature.state).toBe("review");
    expect(receipts.map((receipt) => receipt.kind)).toEqual(["execution", "verification"]);
  });

  it("maps a blocked adapter result to blocked with a handoff", async () => {
    const { repo } = await tempRepo();
    const feature = await repo.createFeature({ title: "Blocked adapter work", goal: "Expose a blocker.", acceptance: ["The blocker is durable"] });
    const registry = new ExecutionAdapterRegistry([new DeterministicExecutionAdapter({ outcome: "blocked", summary: "Needs credentials.", reason: "Credentials are unavailable." })]);

    const result = await repo.executeFeature(feature.id, registry);

    expect(result.feature.state).toBe("blocked");
    expect((await repo.listReceipts(feature.id)).map((receipt) => receipt.kind)).toEqual(["execution", "handoff"]);
  });

  it("does not move a Feature when no adapter is available", async () => {
    const { repo } = await tempRepo();
    const feature = await repo.createFeature({ title: "No adapter", goal: "Remain safe.", acceptance: ["It stays ready"] });

    const result = await repo.executeFeature(feature.id, new ExecutionAdapterRegistry());

    expect(result.outcome).toBe("needs_human");
    expect(result.feature.state).toBe("ready");
    await expect(repo.listReceipts(feature.id)).resolves.toHaveLength(0);
  });
});


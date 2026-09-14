import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DeterministicExecutionAdapter, ExecutionAdapterRegistry, FilesystemStonvikRepository, type ExecutionProfile, type ExecutionRequest } from "../../core/index.js";

async function tempRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stonvik-adapter-test-"));
  const repo = new FilesystemStonvikRepository(root);
  await repo.init();
  return { root, repo };
}

describe("execution adapters", () => {
  it("executes a completed result, verifies it, and stops at review", async () => {
    const { repo } = await tempRepo();
    const feature = await repo.createFeature({ title: "Adapter work", goal: "Run through an adapter.", acceptance: ["The adapter result is recorded"], verification: { commands: [{ name: "pass", run: "true" }] } });
    const registry = new ExecutionAdapterRegistry([new DeterministicExecutionAdapter()]);

    const result = await repo.executeFeature(feature.id, registry);
    const receipts = await repo.listReceipts(feature.id);

    expect(result.outcome).toBe("completed");
    expect(result.feature.state).toBe("review");
    expect(receipts.map((receipt) => receipt.kind)).toEqual(["execution", "execution", "verification"]);
  });

  it("maps a blocked adapter result to blocked with a handoff", async () => {
    const { repo } = await tempRepo();
    const feature = await repo.createFeature({ title: "Blocked adapter work", goal: "Expose a blocker.", acceptance: ["The blocker is durable"], verification: { commands: [{ name: "pass", run: "true" }] } });
    const registry = new ExecutionAdapterRegistry([new DeterministicExecutionAdapter({ outcome: "blocked", summary: "Needs credentials.", reason: "Credentials are unavailable." })]);

    const result = await repo.executeFeature(feature.id, registry);

    expect(result.feature.state).toBe("blocked");
    expect((await repo.listReceipts(feature.id)).map((receipt) => receipt.kind)).toEqual(["execution", "execution", "handoff"]);
  });

  it("does not move a Feature when no adapter is available", async () => {
    const { repo } = await tempRepo();
    const feature = await repo.createFeature({ title: "No adapter", goal: "Remain safe.", acceptance: ["It stays ready"], verification: { commands: [{ name: "pass", run: "true" }] } });

    const result = await repo.executeFeature(feature.id, new ExecutionAdapterRegistry());

    expect(result.outcome).toBe("needs_human");
    expect(result.feature.state).toBe("ready");
    await expect(repo.listReceipts(feature.id)).resolves.toHaveLength(0);
  });

  it("does not infer an execution adapter from document filenames", async () => {
    const { root, repo } = await tempRepo();
    const feature = await repo.createFeature({ title: "User-defined process", goal: "Keep implementation choices explicit.", acceptance: ["The chosen process is respected"], verification: { commands: [{ name: "pass", run: "true" }] } });
    await fs.writeFile(path.join(root, "implementation.md"), "The team owns this format.\n");
    await fs.mkdir(path.join(root, "tickets"));

    let seenRequest: ExecutionRequest | undefined;
    const adapter = {
      id: "recording-direct",
      supports: (profile: ExecutionProfile) => profile.kind === "direct",
      isAvailable: async () => true,
      execute: async (request: ExecutionRequest) => {
        seenRequest = request;
        return { outcome: "completed" as const, summary: "Implementation completed." };
      },
    };

    const result = await repo.executeFeature(feature.id, new ExecutionAdapterRegistry([adapter]));

    expect(result.feature.state).toBe("review");
    expect(seenRequest?.feature.state).toBe("doing");
    expect(seenRequest?.profile).toEqual({ kind: "direct" });
  });
});

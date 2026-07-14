import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DeterministicExecutionAdapter, ExecutionAdapterRegistry, FilesystemForgiumRepository, type ExecutionProfile, type ExecutionRequest } from "../../core/index.js";

async function tempRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-adapter-test-"));
  const repo = new FilesystemForgiumRepository(root);
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
    expect(receipts.map((receipt) => receipt.kind)).toEqual(["execution", "verification"]);
  });

  it("maps a blocked adapter result to blocked with a handoff", async () => {
    const { repo } = await tempRepo();
    const feature = await repo.createFeature({ title: "Blocked adapter work", goal: "Expose a blocker.", acceptance: ["The blocker is durable"], verification: { commands: [{ name: "pass", run: "true" }] } });
    const registry = new ExecutionAdapterRegistry([new DeterministicExecutionAdapter({ outcome: "blocked", summary: "Needs credentials.", reason: "Credentials are unavailable." })]);

    const result = await repo.executeFeature(feature.id, registry);

    expect(result.feature.state).toBe("blocked");
    expect((await repo.listReceipts(feature.id)).map((receipt) => receipt.kind)).toEqual(["execution", "handoff"]);
  });

  it("does not move a Feature when no adapter is available", async () => {
    const { repo } = await tempRepo();
    const feature = await repo.createFeature({ title: "No adapter", goal: "Remain safe.", acceptance: ["It stays ready"], verification: { commands: [{ name: "pass", run: "true" }] } });

    const result = await repo.executeFeature(feature.id, new ExecutionAdapterRegistry());

    expect(result.outcome).toBe("needs_human");
    expect(result.feature.state).toBe("ready");
    await expect(repo.listReceipts(feature.id)).resolves.toHaveLength(0);
  });

  it("refreshes path-bound execution profiles after ready moves to doing", async () => {
    const { repo } = await tempRepo();
    const feature = await repo.createFeature({ title: "Spec Flow adapter", goal: "Keep paths valid after transition.", acceptance: ["The active spec path is used"], verification: { commands: [{ name: "pass", run: "true" }] } });
    await fs.writeFile(path.join(feature.path, "spec.md"), "# Spec Flow\n");
    await fs.mkdir(path.join(feature.path, "tickets"));

    let seenRequest: ExecutionRequest | undefined;
    const adapter = {
      id: "recording-spec-flow",
      supports: (profile: ExecutionProfile) => profile.kind === "spec-flow",
      isAvailable: async () => true,
      execute: async (request: ExecutionRequest) => {
        seenRequest = request;
        return { outcome: "completed" as const, summary: "Spec Flow completed." };
      },
    };

    const result = await repo.executeFeature(feature.id, new ExecutionAdapterRegistry([adapter]));

    expect(result.feature.state).toBe("review");
    expect(seenRequest?.feature.state).toBe("doing");
    expect(seenRequest?.profile.kind).toBe("spec-flow");
    if (seenRequest?.profile.kind === "spec-flow") {
      expect(seenRequest.profile.specPath).toContain(`${path.sep}features${path.sep}doing${path.sep}`);
      expect(seenRequest.profile.ticketsPath).toContain(`${path.sep}features${path.sep}doing${path.sep}`);
    }
  });
});

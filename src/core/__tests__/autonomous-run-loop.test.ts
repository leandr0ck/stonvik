import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentLoop, DeterministicExecutionAdapter, DeterministicWorkReviewAdapter, ExecutionAdapterRegistry, FilesystemForgiumRepository, calculateComplexityScore } from "../../core/index.js";

describe("autonomous run loop", () => {
  it("classifies, implements, verifies, independently reviews, and completes one Work", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-autonomous-loop-"));
    const repo = new FilesystemForgiumRepository(root);
    await repo.init();
    const inbox = await repo.capture({ text: "Add a small button" });
    const classification = {
      route: "auto_direct" as const,
      size: "XS" as const,
      estimatedTouchedFiles: 1,
      complexityScore: calculateComplexityScore("XS", []),
      confidence: 0.99,
      risks: [] as never[],
      rationale: ["One low-risk file change."],
      proposed: { title: inbox.title, goal: "Add the button.", acceptance: ["The button exists."], verification: { commands: [{ name: "pass", run: "true" }] } },
    };
    const loop = new AgentLoop(repo);
    const result = await loop.run({
      classify: async () => classification,
      registry: new ExecutionAdapterRegistry([new DeterministicExecutionAdapter()]),
      reviewer: new DeterministicWorkReviewAdapter(),
    });
    expect(result.stopReason).toBe("idle");
    expect((await repo.getStatus()).features.done).toBe(1);
    expect(await repo.listInbox()).toEqual([]);
    const done = (await repo.listFeatures("done"))[0]!;
    await expect(fs.readdir(path.join(done.path, "provenance", "inbox"))).resolves.toHaveLength(1);
    await expect(fs.readdir(path.join(done.path, "provenance", "classification"))).resolves.toHaveLength(1);
    expect((await repo.validate()).valid).toBe(true);
  });
});

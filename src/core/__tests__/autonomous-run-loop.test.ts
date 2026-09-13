import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentLoop, DeterministicExecutionAdapter, DeterministicWorkReviewAdapter, ExecutionAdapterRegistry, FilesystemStonvikRepository, calculateComplexityScore } from "../../core/index.js";

describe("autonomous run loop", () => {
  it("classifies, implements, verifies, independently reviews, and completes one Work", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "stonvik-autonomous-loop-"));
    const repo = new FilesystemStonvikRepository(root);
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

  it("repairs one incomplete automatic classification before creating Work", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "stonvik-classification-repair-"));
    const repo = new FilesystemStonvikRepository(root);
    await repo.init();
    const inbox = await repo.capture({ text: "Create people.md" });
    let calls = 0;
    const result = await new AgentLoop(repo).run({
      classify: async (_item, _signal, _progress, repairReason) => {
        calls += 1;
        if (!repairReason) return {
          route: "auto_direct", size: "XS", estimatedTouchedFiles: 1, complexityScore: 1, confidence: 0.95, risks: [], rationale: ["One file."],
          proposed: { title: "Create people.md", goal: "Create people.md.", acceptance: ["The file exists."] },
        };
        return {
          route: "auto_direct", size: "XS", estimatedTouchedFiles: 1, complexityScore: 1, confidence: 0.95, risks: [], rationale: ["One file."],
          proposed: { title: "Create people.md", goal: "Create people.md.", acceptance: ["The file exists."], verification: { commands: [{ name: "contract-check", run: "true" }] } },
        };
      },
      registry: new ExecutionAdapterRegistry([new DeterministicExecutionAdapter()]),
      reviewer: new DeterministicWorkReviewAdapter(),
    });

    expect(calls).toBe(2);
    expect(result.stopReason).toBe("idle");
    expect((await repo.getStatus()).features.done).toBe(1);
    expect(await repo.listInbox()).toEqual([]);
    expect(inbox.id).toMatch(/^inbox-/);
  });

  it("moves ask_direct items to review with the clarification question", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "stonvik-direct-clarification-"));
    const repo = new FilesystemStonvikRepository(root);
    await repo.init();
    await repo.capture({ text: "Create a Markdown file with three names" });
    const result = await new AgentLoop(repo).run({
      classify: async () => ({
        route: "ask_direct", size: "XS", estimatedTouchedFiles: 1, complexityScore: 1, confidence: 0.8, risks: [], rationale: ["The output file name is not specified."],
        clarification: { field: "output_path" },
        proposed: { title: "Create a Markdown file", goal: "Create a Markdown file with three names.", acceptance: ["The file contains three names."] },
      }),
      registry: new ExecutionAdapterRegistry([new DeterministicExecutionAdapter()]),
      reviewer: new DeterministicWorkReviewAdapter(),
    });

    expect(result.stopReason).toBe("idle");
    expect(result.inboxReview).toBe(1);
    expect((await repo.listReview()).length).toBe(1);
    expect((await repo.getStatus()).inbox.needs_review).toBe(1);
  });
});

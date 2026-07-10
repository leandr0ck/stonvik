import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FilesystemForgiumRepository } from "../../core/index.js";

async function tempRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-test-"));
  await fs.mkdir(path.join(root, ".git"));
  const repo = new FilesystemForgiumRepository(root);
  await repo.init();
  return { root, repo };
}

describe("FilesystemForgiumRepository", () => {
  it("initializes required directories", async () => {
    const { root } = await tempRepo();
    await expect(fs.stat(path.join(root, "product/inbox"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(root, "features/ready"))).resolves.toBeTruthy();
  });

  it("captures and parses inbox items", async () => {
    const { repo } = await tempRepo();
    const item = await repo.capture({ text: "Add WhatsApp button\n\nUse configured number." });
    expect(item.id).toMatch(/^inbox-/);
    const inbox = await repo.listInbox();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.title).toBe("Add WhatsApp button");
    expect(inbox[0]?.body).toContain("configured number");
  });

  it("creates features and transitions through the default lifecycle", async () => {
    const { repo } = await tempRepo();
    const feature = await repo.createFeature({ title: "Add WhatsApp Button", goal: "Add a storefront contact button.", acceptance: ["Button is visible"] });
    expect(feature.state).toBe("ready");
    expect((await repo.getStatus()).features.ready).toBe(1);

    const doing = await repo.startFeature(feature.id);
    expect(doing.state).toBe("doing");
    expect(await repo.inspectExecutionMode(feature.id)).toEqual({ kind: "direct" });

    const review = await repo.submitForReview(feature.id);
    expect(review.state).toBe("review");

    const done = await repo.completeFeature(feature.id);
    expect(done.state).toBe("done");
  });

  it("detects spec-flow execution profiles", async () => {
    const { repo } = await tempRepo();
    const feature = await repo.createFeature({ title: "Progressive Web App", goal: "Make storefronts installable.", acceptance: ["Manifest exists"] });
    await fs.writeFile(path.join(feature.path, "spec.md"), "# Spec");
    const needsPlan = await repo.inspectExecutionMode(feature.id);
    expect(needsPlan.kind).toBe("spec-needs-plan");
    expect(needsPlan).toMatchObject({ commands: expect.objectContaining({ init: expect.stringContaining(feature.path), implement: expect.stringContaining(feature.path) }) });
    await fs.mkdir(path.join(feature.path, "tickets"));
    const specFlow = await repo.inspectExecutionMode(feature.id);
    expect(specFlow.kind).toBe("spec-flow");
    expect(specFlow).toMatchObject({ commands: expect.objectContaining({ implement: expect.stringContaining(feature.path), next: expect.stringContaining(feature.path) }) });
  });
});

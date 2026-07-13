import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import {
  DraftSchema,
  FilesystemForgiumRepository,
  InvalidDraftError
} from "../../core/index.js";

async function tempRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-draft-test-"));
  const repo = new FilesystemForgiumRepository(root);
  await repo.init();
  return { root, repo };
}

describe("Drafts", () => {
  it("validates the permissive Draft frontmatter contract", () => {
    const result = DraftSchema.safeParse({
      schemaVersion: 1,
      id: "draft-add-whatsapp-button",
      created: "2026-07-12T10:00:00.000Z",
      source: { type: "inbox", ref: "inbox-20260712T095500Z-a8f4" },
      title: "Add WhatsApp button",
      goal: "",
      acceptance: []
    });

    expect(result.success).toBe(true);
  });

  it("creates a Draft from Inbox without making it executable", async () => {
    const { root, repo } = await tempRepo();
    const inbox = await repo.capture({
      text: "Add WhatsApp button\n\nUse the configured number.",
      source: "cli"
    });

    const draft = await repo.createDraftFromInbox(inbox.id);
    const drafts = await repo.listDrafts();
    const updatedInbox = (await repo.listInbox())[0]!;
    const status = await repo.getStatus();

    expect(draft.frontmatter.title).toBe("Add WhatsApp button");
    expect(draft.frontmatter.source).toEqual({ type: "inbox", ref: inbox.id });
    expect(draft.body).toContain("Use the configured number.");
    expect(drafts.map((item) => item.id)).toEqual([draft.id]);
    expect(updatedInbox).toMatchObject({ status: "drafted", draftRef: draft.id });
    expect(status.drafts).toBe(1);
    expect(status.features.ready).toBe(0);
    await expect(fs.stat(path.join(root, "features/draft"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(draft.path, "manifest.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects promotion of an incomplete Draft without creating a Feature", async () => {
    const { repo, root } = await tempRepo();
    const inbox = await repo.capture({ text: "Add a button" });
    const draft = await repo.createDraftFromInbox(inbox.id);

    await expect(repo.promoteDraft(draft.id)).rejects.toBeInstanceOf(InvalidDraftError);

    await expect(repo.getDraft(draft.id)).resolves.toMatchObject({ id: draft.id });
    await expect(fs.readdir(path.join(root, "features/ready"))).resolves.toHaveLength(0);
    await expect(fs.stat(path.join(draft.path, "manifest.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(repo.listInbox()).resolves.toMatchObject([{ status: "drafted", draftRef: draft.id }]);
  });

  it("promotes a valid Draft atomically into a ready Feature", async () => {
    const { repo, root } = await tempRepo();
    const inbox = await repo.capture({ text: "Add a button\n\nA prominent CTA." });
    const draft = await repo.createDraftFromInbox(inbox.id);
    const draftPath = path.join(draft.path, "draft.md");
    const frontmatter = {
      ...draft.frontmatter,
      goal: "Help visitors contact the store.",
      acceptance: ["The CTA is visible"]
    };
    await fs.writeFile(draftPath, `---\n${YAML.stringify(frontmatter)}---\n\n# Context\n\nA prominent CTA.\n`);

    const feature = await repo.promoteDraft(draft.id);
    const readyPath = path.join(root, "features/ready", draft.slug);
    const manifest = YAML.parse(await fs.readFile(path.join(readyPath, "manifest.yaml"), "utf8"));
    const updatedInbox = (await repo.listInbox())[0]!;

    expect(feature.state).toBe("ready");
    expect(feature.manifest).toMatchObject({
      id: `feature-${draft.slug}`,
      title: "Add a button",
      goal: "Help visitors contact the store.",
      acceptance: ["The CTA is visible"],
      source: { type: "inbox", ref: inbox.id }
    });
    expect(manifest).toEqual(feature.manifest);
    expect(await fs.readFile(path.join(readyPath, "draft.md"), "utf8")).toContain("A prominent CTA.");
    expect(updatedInbox).toMatchObject({
      status: "promoted",
      draftRef: draft.id,
      featureRef: feature.id
    });
    await expect(repo.getDraft(draft.id)).resolves.toBeNull();
  });

  it("does not consume a Draft when its Feature slug collides", async () => {
    const { repo } = await tempRepo();
    const inbox = await repo.capture({ text: "Add a button" });
    const draft = await repo.createDraftFromInbox(inbox.id);
    await repo.createFeature({ title: "Add a button", goal: "Existing goal", acceptance: ["Already exists"] });
    await fs.writeFile(path.join(draft.path, "draft.md"), `---\n${YAML.stringify({
      ...draft.frontmatter,
      goal: "A different goal",
      acceptance: ["A different criterion"]
    })}---\n\n# Context\n`);

    await expect(repo.promoteDraft(draft.id)).rejects.toMatchObject({ code: "FEATURE_ALREADY_EXISTS" });
    await expect(repo.getDraft(draft.id)).resolves.toMatchObject({ id: draft.id });
    await expect(repo.listInbox()).resolves.toMatchObject([{ status: "drafted", draftRef: draft.id }]);
  });

  it("reports malformed Drafts during validation", async () => {
    const { repo, root } = await tempRepo();
    const draftPath = path.join(root, "features/draft/broken");
    await fs.mkdir(draftPath, { recursive: true });
    await fs.writeFile(path.join(draftPath, "draft.md"), "not markdown frontmatter");

    const report = await repo.validate();

    expect(report.valid).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "INVALID_DRAFT" })
    ]));
    await expect(repo.getStatus()).resolves.toMatchObject({ drafts: 1 });
  });
});

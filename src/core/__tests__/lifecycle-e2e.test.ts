import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { DeterministicExecutionAdapter, ExecutionAdapterRegistry, FilesystemForgiumRepository } from "../../core/index.js";

async function tempRepo(withGit = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-e2e-test-"));
  if (withGit) await fs.mkdir(path.join(root, ".git"));
  const repo = new FilesystemForgiumRepository(root);
  await repo.init();
  return { root, repo };
}

describe("Forgium lifecycle end-to-end", () => {
  it("walks Inbox → Draft → ready → doing → review → done", async () => {
    const { root, repo } = await tempRepo();
    const inbox = await repo.capture({ text: "Add account export\n\nUsers need a portable copy." });
    const draft = await repo.createDraftFromInbox(inbox.id);
    await fs.writeFile(path.join(draft.path, "draft.md"), `---\n${YAML.stringify({
      ...draft.frontmatter,
      goal: "Let users download their account data.",
      acceptance: ["A JSON export can be downloaded"]
    })}---\n\n# Definition\n`);

    const ready = await repo.promoteDraft(draft.id);
    const execution = await repo.executeFeature(ready.id, new ExecutionAdapterRegistry([new DeterministicExecutionAdapter()]));
    const done = await repo.reviewFeature(ready.id, "approved", "Acceptance and receipts reviewed.");
    const status = await repo.getStatus();

    expect(execution.feature.state).toBe("review");
    expect(done.state).toBe("done");
    expect(status.inbox.promoted).toBe(1);
    expect(status.features.done).toBe(1);
    await expect(fs.stat(path.join(root, "features/done", ready.slug, "receipts"))).resolves.toBeTruthy();
  });

  it("initializes correctly in a repository with Git", async () => {
    const { repo, root } = await tempRepo(true);
    const item = await repo.capture({ text: "Git-backed request" });

    expect(item.status).toBe("captured");
    await expect(fs.stat(path.join(root, "features/draft"))).resolves.toBeTruthy();
    await expect(repo.validate()).resolves.toMatchObject({ valid: true });
  });
});


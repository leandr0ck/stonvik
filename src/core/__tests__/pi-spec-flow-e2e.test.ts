import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FilesystemForgiumRepository,
  ExecutionAdapterRegistry,
  SpecFlowExecutionAdapter,
} from "../../core/index.js";

const e2e = process.env.FORGIUM_E2E_PI === "1" ? it : it.skip;

describe("Pi + pi-spec-flow end-to-end", () => {
  e2e("executes one real spec-flow ticket with the configured Pi model", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-pi-spec-flow-e2e-"));
    try {
      const repo = new FilesystemForgiumRepository(root);
      await repo.init();
      await fs.writeFile(
        path.join(root, "spec-flow.config.json"),
        JSON.stringify({ ticketsFolder: "./tickets", ticketsFolderBase: "spec" }),
      );

      const feature = await repo.createFeature({
        title: "Pi Spec Flow Smoke Test",
        goal: "Validate the real Pi and pi-spec-flow integration.",
        acceptance: ["target.txt contains exactly after."],
      });
      const specPath = path.join(feature.path, "spec.md");
      await fs.writeFile(
        specPath,
        [
          "# Pi Spec Flow Smoke Test",
          "",
          "Edit `target.txt` at the repository root so it contains exactly `after`.",
        ].join("\n"),
      );
      await fs.writeFile(path.join(root, "target.txt"), "before\n");
      await fs.mkdir(path.join(feature.path, "tickets"));
      await fs.writeFile(
        path.join(feature.path, "tickets", "001-update-text.md"),
        [
          "---",
          "id: 1",
          "title: Update one text file",
          "description: Replace the only value in target.txt from before to after.",
          "status: pending",
          "source_section: Pi Spec Flow Smoke Test",
          "feature_key: pi-spec-flow-smoke-test",
          `source_spec_path: ${path.relative(root, specPath)}`,
          "acceptance_criteria: '- [ ] target.txt contains exactly after'",
          "verification: '- [ ] test \"$(cat target.txt)\" = \"after\"'",
          "estimated_scope: XS",
          "phase: Foundation",
          "is_checkpoint: false",
          "order_index: 1",
          "---",
          "",
          "Edit only target.txt, verify it, fill all handoff fields, and close this ticket with the Spec Flow handoff tool.",
          "",
        ].join("\n"),
      );

      const execution = await repo.executeFeature(
        feature.id,
        new ExecutionAdapterRegistry([
          new SpecFlowExecutionAdapter(process.env.FORGIUM_PI_COMMAND ?? "pi", 3 * 60 * 1000),
        ]),
      );

      expect(execution.outcome).toBe("completed");
      expect(execution.feature.state).toBe("review");
      expect((await fs.readFile(path.join(root, "target.txt"), "utf8")).trim()).toBe("after");
      await expect(repo.listReceipts(feature.id)).resolves.toHaveLength(2);

      const completed = await repo.reviewFeature(feature.id, "approved", "Approved after real Pi smoke test.");
      expect(completed.state).toBe("done");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 3 * 60 * 1000);
});

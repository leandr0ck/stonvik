import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FilesystemForgiumRepository,
  SpecFlowExecutionAdapter,
  buildSpecFlowSafetyPrompt,
  parseSpecFlowStatusResult,
} from "../../core/index.js";

async function specFlowFixture(status: object) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgium-spec-flow-adapter-test-"));
  const fakePi = path.join(root, "fake-pi");
  const fakeSource = [
    "#!/usr/bin/env node",
    "if (process.argv.includes('--version')) { console.log('0.80.6'); process.exit(0); }",
    "let promptCount = 0;",
    "process.stdin.on('data', (chunk) => {",
    "  for (const line of chunk.toString().split('\\n')) {",
    "    if (!line.trim() || line.includes('extension_ui_response')) continue;",
    "    promptCount += 1;",
    "    if (promptCount === 1) {",
    "      process.stdout.write(JSON.stringify({ type: 'extension_ui_request', id: 'ui-1', method: 'select', title: 'Proceed with this ticket?', options: ['Yes, proceed', 'No, cancel'] }) + '\\n');",
    "      process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');",
    "      continue;",
    "    }",
    `    process.stdout.write(JSON.stringify({ type: 'tool_execution_end', toolName: 'spec_flow_status', result: { details: ${JSON.stringify(status)} }, isError: false }) + '\\n');`,
    "    process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');",
    "  }",
    "});",
    "",
  ].join("\n");
  await fs.writeFile(fakePi, fakeSource);
  await fs.chmod(fakePi, 0o755);

  const repo = new FilesystemForgiumRepository(root);
  await repo.init();
  const feature = await repo.createFeature({
    title: "Spec Flow work",
    goal: "Run the checked-in implementation plan.",
    acceptance: ["All planned tickets are complete"],
    verification: { commands: [{ name: "pass", run: "true" }] },
  });
  await fs.writeFile(path.join(feature.path, "spec.md"), "# Spec Flow\n");
  await fs.mkdir(path.join(feature.path, "tickets"));
  const profile = await repo.inspectExecutionMode(feature.id);
  if (profile.kind !== "spec-flow") throw new Error("Expected spec-flow profile");

  return { root, fakePi, feature, profile };
}

describe("Spec Flow execution adapter", () => {
  it("runs the public implementation command and completes only after status says complete", async () => {
    const fixture = await specFlowFixture({
      sourceSpecPath: "spec.md",
      featureKey: "spec-flow",
      total: 2,
      pending: 0,
      inProgress: 0,
      done: 2,
      checkpoints: { total: 1, completed: 1, pendingReview: 0 },
      complete: true,
      issues: [],
    });
    const adapter = new SpecFlowExecutionAdapter(fixture.fakePi, 5_000);

    await expect(adapter.execute({
      root: fixture.root,
      feature: fixture.feature,
      profile: fixture.profile,
      runId: "run-spec-flow-test",
      permissions: "repository",
    })).resolves.toMatchObject({ outcome: "completed" });
  }, 15_000);

  it("fails closed when the status reports a checkpoint review or unfinished tickets", async () => {
    const fixture = await specFlowFixture({
      sourceSpecPath: "spec.md",
      featureKey: "spec-flow",
      total: 2,
      pending: 1,
      inProgress: 0,
      done: 1,
      checkpoints: { total: 1, completed: 1, pendingReview: 1 },
      complete: false,
      issues: [],
    });
    const adapter = new SpecFlowExecutionAdapter(fixture.fakePi, 5_000);

    await expect(adapter.execute({
      root: fixture.root,
      feature: fixture.feature,
      profile: fixture.profile,
      runId: "run-spec-flow-test",
      permissions: "repository",
    })).resolves.toMatchObject({ outcome: "needs_human" });
  }, 15_000);

  it("maps malformed or incomplete status payloads to needs_human", () => {
    expect(parseSpecFlowStatusResult({ complete: false })).toMatchObject({ outcome: "needs_human" });
    expect(parseSpecFlowStatusResult({ complete: true, total: 0 })).toMatchObject({ outcome: "needs_human" });
    expect(parseSpecFlowStatusResult(null)).toBeNull();
  });

  it("builds a safety boundary around Forgium-owned state", async () => {
    const fixture = await specFlowFixture({ complete: true, total: 1 });

    expect(buildSpecFlowSafetyPrompt({
      root: fixture.root,
      feature: fixture.feature,
      profile: fixture.profile,
      runId: "run-spec-flow-test",
      permissions: "repository",
    })).toContain("Never modify, move, delete, or create files under product/, features/, or .forgium/");
  });
});

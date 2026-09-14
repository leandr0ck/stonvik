import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FilesystemStonvikRepository } from "../../core/index.js";
import { PiRpcExecutionAdapter, buildPiPrompt, parsePiResult } from "../../integrations/pi/pi-rpc-execution-adapter.js";

describe("Pi RPC execution adapter", () => {
  it("maps the documented RPC event stream to a typed result", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "stonvik-pi-rpc-test-"));
    const fakePi = path.join(root, "fake-pi");
    const fakeSource = [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) { console.log('0.80.6'); process.exit(0); }",
      "process.stdin.on('data', () => {",
      "  process.stdout.write(JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'STONVIK_RESULT: completed' }] }] }) + '\\n');",
      "  process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');",
      "});",
      ""
    ].join("\n");
    await fs.writeFile(fakePi, fakeSource);
    await fs.chmod(fakePi, 0o755);
    const repo = new FilesystemStonvikRepository(root);
    await repo.init();
    const feature = await repo.createFeature({ title: "Pi work", goal: "Run Pi safely.", acceptance: ["The result is typed"], verification: { commands: [{ name: "pass", run: "true" }] } });
    const adapter = new PiRpcExecutionAdapter(fakePi, 5_000);
    const profile = await repo.inspectExecutionMode(feature.id);

    expect(await adapter.isAvailable({ root, feature, profile, runId: "run-test", permissions: "repository" })).toBe(true);
    await expect(adapter.execute({ root, feature, profile, runId: "run-test", permissions: "repository" })).resolves.toMatchObject({ outcome: "completed" });
  });

  it("fails closed when Pi omits the result marker", () => {
    expect(parsePiResult("I changed some files.")).toMatchObject({ outcome: "needs_human" });
  });

  it("includes the Feature contract in the prompt", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "stonvik-pi-prompt-test-"));
    const repo = new FilesystemStonvikRepository(root);
    await repo.init();
    const feature = await repo.createFeature({ title: "Prompt work", goal: "Provide context.", acceptance: ["Context is present"], verification: { commands: [{ name: "pass", run: "true" }] } });
    const profile = await repo.inspectExecutionMode(feature.id);

    const prompt = buildPiPrompt({ root, feature, profile, runId: "run-test", permissions: "repository" });

    expect(prompt).toContain(feature.manifest.goal);
    expect(prompt).toContain("STONVIK_RESULT");
  });
});

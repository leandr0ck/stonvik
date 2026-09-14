import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PiClassificationAdapter } from "../../integrations/pi/pi-classification-adapter.js";

describe("PiClassificationAdapter", () => {
  it("reuses one ephemeral RPC process and resets it between Inbox items", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "stonvik-pi-classification-"));
    const counter = path.join(root, "starts");
    const args = path.join(root, "args");
    const command = path.join(root, "fake-pi.mjs");
    const classification = JSON.stringify({
      route: "auto_direct", size: "XS", estimatedTouchedFiles: 1, complexityScore: 1, confidence: 1, risks: [], rationale: ["One file."],
      proposed: { title: "Create names.md", goal: "Create names.md.", acceptance: ["names.md exists."], verification: { commands: [{ name: "pass", run: "true" }] } },
    });
    await fs.writeFile(command, [
      "#!/usr/bin/env node",
      "import fs from 'node:fs';",
      `fs.appendFileSync(${JSON.stringify(counter)}, '1');`,
      `fs.writeFileSync(${JSON.stringify(args)}, process.argv.slice(2).join('\\n'));`,
      "process.stdin.on('data', (chunk) => { for (const line of chunk.toString().split('\\n')) {",
      "  if (!line.trim()) continue; const request = JSON.parse(line);",
      "  if (request.type === 'new_session') process.stdout.write(JSON.stringify({ type: 'response', id: request.id, command: 'new_session', success: true, data: { cancelled: false } }) + '\\n');",
      `  if (request.type === 'prompt') { process.stdout.write(JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: ${JSON.stringify(classification)} }] }] }) + '\\n'); process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n'); }`,
      "} });",
    ].join("\n"));
    await fs.chmod(command, 0o755);
    const adapter = new PiClassificationAdapter(command);
    const item = { id: "inbox-2026-07-17T00:00:00+00:00-abc12", source: "test", created: "2026-07-17T00:00:00.000Z", status: "captured" as const, title: "Create names.md", path: path.join(root, "names.md") };

    await adapter.classify(item);
    await adapter.classify({ ...item, id: "inbox-2026-07-17T00:00:01+00:00-def34" });
    adapter.close();

    await expect(fs.readFile(counter, "utf8")).resolves.toBe("1");
    await expect(fs.readFile(args, "utf8")).resolves.toContain("--no-tools\n--no-extensions\n--no-skills\n--no-prompt-templates\n--no-context-files");
  });

  it("fails closed when Pi cancels the required fresh session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "stonvik-pi-classification-cancelled-"));
    const command = path.join(root, "fake-pi.mjs");
    await fs.writeFile(command, [
      "#!/usr/bin/env node",
      "let prompts = 0; process.stdin.on('data', (chunk) => { for (const line of chunk.toString().split('\\n')) {",
      "  if (!line.trim()) continue; const request = JSON.parse(line);",
      "  if (request.type === 'new_session') process.stdout.write(JSON.stringify({ type: 'response', id: request.id, command: 'new_session', success: true, data: { cancelled: true } }) + '\\n');",
      "  if (request.type === 'prompt') { prompts += 1; process.stdout.write(JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', content: JSON.stringify({ route: 'auto_direct', size: 'XS', estimatedTouchedFiles: 1, complexityScore: 1, confidence: 1, risks: [], rationale: ['One file.'], proposed: { title: 'x', goal: 'x', acceptance: ['x'], verification: { commands: [{ name: 'pass', run: 'true' }] } } }) }] }) + '\\n'); process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n'); }",
      "} });",
    ].join("\n"));
    await fs.chmod(command, 0o755);
    const adapter = new PiClassificationAdapter(command);
    const item = { id: "inbox-one", source: "test", created: "2026-07-17T00:00:00.000Z", status: "captured" as const, title: "Create names.md", path: path.join(root, "names.md") };

    await adapter.classify(item);
    await expect(adapter.classify({ ...item, id: "inbox-two" })).rejects.toThrow("cancelled the classification session reset");
    adapter.close();
  });

  it("times out instead of hanging when Pi does not acknowledge a session reset", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "stonvik-pi-classification-timeout-"));
    const command = path.join(root, "fake-pi.mjs");
    await fs.writeFile(command, [
      "#!/usr/bin/env node",
      "process.stdin.on('data', (chunk) => { for (const line of chunk.toString().split('\\n')) {",
      "  if (!line.trim()) continue; const request = JSON.parse(line);",
      "  if (request.type === 'prompt') { process.stdout.write(JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', content: JSON.stringify({ route: 'auto_direct', size: 'XS', estimatedTouchedFiles: 1, complexityScore: 1, confidence: 1, risks: [], rationale: ['One file.'], proposed: { title: 'x', goal: 'x', acceptance: ['x'], verification: { commands: [{ name: 'pass', run: 'true' }] } } }) }] }) + '\\n'); process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n'); }",
      "} });",
    ].join("\n"));
    await fs.chmod(command, 0o755);
    const adapter = new PiClassificationAdapter(command, 1_000);
    const item = { id: "inbox-one", source: "test", created: "2026-07-17T00:00:00.000Z", status: "captured" as const, title: "Create names.md", path: path.join(root, "names.md") };

    await adapter.classify(item);
    await expect(adapter.classify({ ...item, id: "inbox-two" })).rejects.toThrow("session reset timed out");
  });
});

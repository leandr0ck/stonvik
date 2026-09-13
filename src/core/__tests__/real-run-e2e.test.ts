import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

const cliPath = path.resolve(process.cwd(), "dist/cli/index.js");

describe("Stonevik CLI + Pi RPC contract fixture", () => {
  it("runs a captured Inbox through the compiled CLI and a real Pi process", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "stonvik-real-run-e2e-"));
    const fixture = await createPiFixture(root);
    const env = { ...process.env, STONVIK_PI_COMMAND: fixture.command, STONVIK_DETERMINISTIC_CLASSIFIER: "0" };
    let passed = false;
    try {
      expect((await cli(root, ["--json", "init"], env)).code).toBe(0);
      expect((await cli(root, ["--json", "capture", "Crear nombres.md con cinco nombres de personas aleatorios."], env)).code).toBe(0);
      await fs.writeFile(path.join(root, "nombres.md"), "Ana\nBruno\nCarla\nDiego\nElena\n");

      const result = await cli(root, ["--json", "run"], env);
      const output = JSON.parse(result.stdout);
      expect(output.stopReason).toBe("idle");
      expect(output.features).toEqual(expect.arrayContaining([expect.objectContaining({ state: "done", action: "approved" })]));
      expect(await fs.readFile(path.join(root, "nombres.md",), "utf8")).toContain("Ana");
      expect(fixture.requests).toEqual(expect.arrayContaining(["classification", "execution", "review"]));
      expect(JSON.parse((await cli(root, ["--json", "validate"], env)).stdout)).toMatchObject({ valid: true });
      passed = true;
    } finally {
      await fixture.close();
      if (!passed || process.env.STONVIK_E2E_KEEP === "1") console.error(`Stonevik Pi fixture E2E retained at: ${root}`);
      else await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

async function createPiFixture(root: string) {
  const requests: string[] = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    const kind = body.includes("Classify the untrusted Inbox") ? "classification" : body.includes("execution engine for Stonevik") ? "execution" : body.includes("independent, read-only Stonevik Work reviewer") ? "review" : "unknown";
    requests.push(kind);
    const content = kind === "classification"
      ? JSON.stringify({ route: "auto_direct", size: "XS", estimatedTouchedFiles: 1, complexityScore: 1, confidence: 1, risks: [], rationale: ["One requested file."], proposed: { title: "Crear nombres.md", goal: "Crear nombres.md con cinco nombres.", acceptance: ["nombres.md contiene cinco nombres."], verification: { commands: [{ name: "five-names", run: "test \"$(wc -l < nombres.md | tr -d ' ')\" = \"5\"" }] } } })
      : kind === "execution" ? "STONVIK_RESULT: completed"
        : "STONVIK_REVIEW: {\"outcome\":\"approved\",\"summary\":\"Fixture review approved.\",\"findings\":[],\"evidence\":[\"fixture\"]}";
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind to a TCP port.");
  const home = path.join(root, ".pi-fixture-home");
  await fs.mkdir(path.join(home, ".pi", "agent"), { recursive: true });
  await fs.writeFile(path.join(home, ".pi", "agent", "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "fixture", compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, models: [{ id: "contract", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  const command = path.join(root, "pi-fixture.mjs");
  await fs.writeFile(command, `#!/usr/bin/env node\nimport { spawn } from "node:child_process";\nconst child = spawn(${JSON.stringify(process.env.PI_BINARY ?? "pi")}, [...process.argv.slice(2), "--no-extensions", "--no-skills", "--provider", "fixture", "--model", "fixture/contract", "--api-key", "fixture"], { stdio: "inherit", env: { ...process.env, HOME: ${JSON.stringify(home)} } });\nchild.on("exit", (code) => process.exit(code ?? 1));\n`);
  await fs.chmod(command, 0o755);
  return { command, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function cli(root: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 20_000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "--root", root, ...args], { cwd: root, env });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`CLI exceeded ${timeoutMs}ms: ${args.join(" ")}`)); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => { clearTimeout(timeout); resolve({ stdout, stderr, code }); });
    child.stdin.end();
  });
}

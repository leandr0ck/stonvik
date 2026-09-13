import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { compiledCliPath, runCompiledCli, waitFor } from "./support/cli-harness.js";

describe("Stonevik watch CLI contract", () => {
  it("emits NDJSON, waits for a durable capture, and exits on SIGTERM", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "stonvik-watch-e2e-"));
    const init = await runCompiledCli(root, ["--json", "init"]);
    expect(init.code).toBe(0);
    const watch = spawn(process.execPath, [compiledCliPath, "--root", root, "--json", "run", "--watch", "--non-interactive"], { cwd: root, env: process.env });
    const lines: string[] = [];
    let buffer = "";
    watch.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        if (line) lines.push(line);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    });
    watch.stdin.end();

    await waitFor(() => lines.some((line) => line.includes('"stopReason":"idle"')));
    const capture = await runCompiledCli(root, ["capture", "A durable watch event"]);
    expect(capture.code).toBe(0);
    await waitFor(() => lines.some((line) => line.includes('"stopReason":"idle"') && line.includes('Loop stopped')));
    watch.kill("SIGTERM");
    const exit = await new Promise<number | null>((resolve) => watch.once("close", resolve));

    expect(exit === 0 || exit === null).toBe(true);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(lines.some((line) => line.includes("idle"))).toBe(true);
    expect((await runCompiledCli(root, ["--json", "validate"])).code).toBe(0);
  }, 30_000);
});

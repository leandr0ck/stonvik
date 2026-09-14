import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const cliPath = `${process.cwd()}/src/cli/index.ts`;
const tsx = `${process.cwd()}/node_modules/tsx/dist/cli.mjs`;

describe("CLI command surface", () => {
  it("exposes the five workflow phases without implementation-specific commands", async () => {
    const { stdout } = await execFile(process.execPath, [tsx, cliPath, "--help"], { cwd: process.cwd() });

    expect(stdout).toContain("capture");
    expect(stdout).toContain("triage");
    expect(stdout).toContain("define");
    expect(stdout).toContain("verify");
    expect(stdout).toContain("ship");
    expect(stdout).toContain("work");
    expect(stdout).not.toContain("run");
    expect(stdout).not.toContain("implement");
  });

  it("exposes user-owned spec and ADR references during definition", async () => {
    const { stdout } = await execFile(process.execPath, [tsx, cliPath, "define", "--help"], { cwd: process.cwd() });

    expect(stdout).toContain("--spec");
    expect(stdout).toContain("--adr");
    expect(stdout).toContain("--verify-command");
  });
});

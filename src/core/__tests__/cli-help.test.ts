import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);

describe("CLI command surface", () => {
  it("exposes the phase workflow commands", async () => {
    const cliPath = `${process.cwd()}/src/cli/index.ts`;
    const tsx = `${process.cwd()}/node_modules/tsx/dist/cli.mjs`;
    const { stdout } = await execFile(process.execPath, [tsx, cliPath, "--help"], { cwd: process.cwd() });

    expect(stdout).toContain("triage");
    expect(stdout).toContain("run");
    expect(stdout).toContain("work");
    expect(stdout).toContain("implement");
    expect(stdout).toContain("definition");

    const { stdout: runHelp } = await execFile(process.execPath, [tsx, cliPath, "run", "--help"], { cwd: process.cwd() });
    expect(runHelp).not.toContain("--engine");
  });

  it("exposes Work creation", async () => {
    const cliPath = `${process.cwd()}/src/cli/index.ts`;
    const tsx = `${process.cwd()}/node_modules/tsx/dist/cli.mjs`;
    const { stdout } = await execFile(process.execPath, [tsx, cliPath, "work", "create", "--help"], { cwd: process.cwd() });

    expect(stdout).toContain("--verify-command");
  });
});

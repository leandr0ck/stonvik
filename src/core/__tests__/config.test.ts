import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadStonvikConfig, resolvePiCommand, buildModelArgs } from "../../core/services/config.js";

describe("loadStonvikConfig", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "stonvik-config-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns undefined when no config file exists", async () => {
    const config = await loadStonvikConfig(root);
    expect(config).toBeUndefined();
  });

  it("loads valid config with classification model", async () => {
    const configContent = {
      pi: {
        classificationModel: "openai/gpt-4o-mini",
        implementationModel: "anthropic/claude-sonnet-4-20250514",
      },
    };
    await fs.writeFile(path.join(root, "stonvik.json"), JSON.stringify(configContent));

    const config = await loadStonvikConfig(root);
    expect(config).toEqual(configContent);
  });

  it("loads config with all options", async () => {
    const configContent = {
      pi: {
        command: "/custom/pi",
        classificationModel: "openai/gpt-4o-mini",
        implementationModel: "anthropic/claude-sonnet-4-20250514",
        reviewModel: "google/gemini-2.5-pro",
      },
      classification: {
        timeoutMs: 60000,
        heartbeatIntervalMs: 5000,
      },
      execution: {
        timeoutMs: 600000,
        heartbeatIntervalMs: 15000,
      },
      review: {
        timeoutMs: 90000,
      },
    };
    await fs.writeFile(path.join(root, "stonvik.json"), JSON.stringify(configContent));

    const config = await loadStonvikConfig(root);
    expect(config).toEqual(configContent);
  });

  it("rejects invalid config", async () => {
    const invalidConfig = {
      pi: {
        classificationModel: 123,
      },
    };
    await fs.writeFile(path.join(root, "stonvik.json"), JSON.stringify(invalidConfig));

    await expect(loadStonvikConfig(root)).rejects.toThrow();
  });

  it("handles empty config file", async () => {
    const configContent = {};
    await fs.writeFile(path.join(root, "stonvik.json"), JSON.stringify(configContent));

    const config = await loadStonvikConfig(root);
    expect(config).toEqual({});
  });
});

describe("resolvePiCommand", () => {
  const originalEnv = process.env.STONVIK_PI_COMMAND;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.STONVIK_PI_COMMAND;
    } else {
      process.env.STONVIK_PI_COMMAND = originalEnv;
    }
  });

  it("returns env var when set", () => {
    process.env.STONVIK_PI_COMMAND = "/env/pi";
    expect(resolvePiCommand()).toBe("/env/pi");
  });

  it("returns config command when no env var", () => {
    delete process.env.STONVIK_PI_COMMAND;
    expect(resolvePiCommand({ pi: { command: "/config/pi" } })).toBe("/config/pi");
  });

  it("returns default 'pi' when no config or env", () => {
    delete process.env.STONVIK_PI_COMMAND;
    expect(resolvePiCommand()).toBe("pi");
  });

  it("prefers env over config", () => {
    process.env.STONVIK_PI_COMMAND = "/env/pi";
    expect(resolvePiCommand({ pi: { command: "/config/pi" } })).toBe("/env/pi");
  });
});

describe("buildModelArgs", () => {
  it("returns empty array when no model", () => {
    expect(buildModelArgs()).toEqual([]);
    expect(buildModelArgs(undefined)).toEqual([]);
  });

  it("returns model args when model specified", () => {
    expect(buildModelArgs("openai/gpt-4o")).toEqual(["--model", "openai/gpt-4o"]);
  });

  it("handles provider/id format", () => {
    expect(buildModelArgs("anthropic/claude-sonnet-4-20250514")).toEqual(["--model", "anthropic/claude-sonnet-4-20250514"]);
  });
});

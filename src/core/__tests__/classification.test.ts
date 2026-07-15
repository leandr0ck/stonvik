import { describe, expect, it } from "vitest";
import { classificationPrompt } from "../../core/index.js";

describe("classificationPrompt", () => {
  it("states the complete machine-readable classifier contract", () => {
    const prompt = classificationPrompt("Create names file", "Create names.md with five random names.");

    expect(prompt).toContain('"route": "auto_direct" | "ask_direct" | "ask_spec" | "ask_adr" | "split"');
    expect(prompt).toContain('"size": "XS" | "S" | "M" | "L" | "XL"');
    expect(prompt).toContain('"rationale": ["reason"]');
    expect(prompt).toContain('"commands": [{ "name": "check", "run": "command" }]');
    expect(prompt).toContain('"requiredEvidence", if present, is an array of { "criterion": string, "kind": string } objects');
    expect(prompt).toContain("Return the object itself, not a tool action or a description of work to do.");
    expect(prompt).toContain('REQUIRED LITERAL PATHS: ["names.md"]');
  });
});

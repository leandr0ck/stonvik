import { describe, expect, it } from "vitest";
import { classificationPrompt, generateVerificationFromContext } from "../../core/index.js";

describe("classificationPrompt", () => {
  it("states the complete machine-readable classifier contract", () => {
    const prompt = classificationPrompt("Create names file", "Create names.md with five random names.");

    expect(prompt).toContain('"route": "auto_direct" | "ask_direct" | "ask_spec" | "ask_adr" | "split"');
    expect(prompt).toContain('"size": "XS" | "S" | "M" | "L" | "XL"');
    expect(prompt).toContain('"rationale": ["reason"]');
    // Verification is now auto-generated, not in the prompt
    expect(prompt).toContain("IMPORTANT: Do NOT include verification in your response");
    expect(prompt).toContain('clarification: { field: "output_path" | "verification" | "scope" }');
    expect(prompt).toContain("Return the object itself, not a tool action or a description of work to do.");
    expect(prompt).toContain('REQUIRED LITERAL PATHS: ["names.md"]. Copy every listed path byte-for-byte into proposed.goal and proposed.acceptance.');
  });
});

describe("generateVerificationFromContext", () => {
  it("generates file existence check for single file", () => {
    const verification = generateVerificationFromContext(["comics.md"], [], "Create comics", "Create comics.md");
    expect(verification.commands.length).toBeGreaterThanOrEqual(1);
    expect(verification.commands[0].run).toBe("test -f comics.md");
  });

  it("generates content check when acceptance mentions content", () => {
    const verification = generateVerificationFromContext(
      ["actrices.md"],
      ["actrices.md contains 5 actresses"],
      "Create actresses list",
      "Create actrices.md with 5 famous actresses"
    );
    expect(verification.commands.length).toBeGreaterThanOrEqual(2);
    expect(verification.commands.some(c => c.run === "cat actrices.md")).toBe(true);
  });

  it("generates count check when acceptance mentions a number", () => {
    const verification = generateVerificationFromContext(
      ["cats.md"],
      ["cats.md contains exactly 3 pet names"],
      "Create cats",
      "Create cats.md with 3 pet names"
    );
    // The regex should match "3 pet names" or "3 names"
    const hasCountCheck = verification.commands.some(c => c.run.includes("wc -l") || c.name.includes("3"));
    expect(hasCountCheck).toBe(true);
  });

  it("generates fallback check when no paths provided", () => {
    const verification = generateVerificationFromContext([], [], "Do something", "Do something");
    expect(verification.commands.length).toBeGreaterThanOrEqual(1);
  });
});

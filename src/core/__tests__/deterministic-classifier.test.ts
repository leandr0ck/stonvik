import { describe, expect, it } from "vitest";
import { classifyDeterministically } from "../../core/index.js";

describe("classifyDeterministically", () => {
  it("classifies the user's slow case in <1ms", () => {
    const start = performance.now();
    const result = classifyDeterministically(
      "agregar nueva funcionalidad a las Secciones",
      "Se deberia poder seleccionar facilmente los ultimos 20 productos cargados. Tambien se deberian poder seleccionar los productos que estan en las promociones activas. Tambien se deberian poder seleccionar los productos de una categoria X"
    );
    const elapsed = performance.now() - start;

    expect(result).toBeDefined();
    expect(result!.size).toBe("M");
    expect(result!.route).toBe("ask_spec");
    expect(elapsed).toBeLessThan(5); // should be <5ms, not 110s
  });

  it("fast-tracks single file creation", () => {
    const result = classifyDeterministically(
      "Create names.md",
      "Create names.md with five random names"
    );

    expect(result).toBeDefined();
    expect(result!.route).toBe("auto_direct");
    expect(result!.size).toBe("XS");
    expect(result!.complexityScore).toBe(1);
    expect(result!.risks).toEqual([]);
    expect(result!.proposed.verification?.commands.some(c => c.run === "test -f names.md")).toBe(true);
  });

  it("detects security risks and routes to ask_direct", () => {
    const result = classifyDeterministically(
      "Add authentication",
      "Add password hashing and token validation to the login endpoint"
    );

    expect(result).toBeDefined();
    expect(result!.risks).toContain("security");
    expect(result!.route).toBe("ask_direct");
    expect(result!.complexityScore).toBeGreaterThanOrEqual(4); // S=2 + security=3
  });

  it("returns undefined for XL work", () => {
    const result = classifyDeterministically(
      "Rewrite the entire application",
      Array.from({ length: 15 }, (_, i) => `file${i}.ts`).join(", ") + " and more"
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined for very long M/L requests", () => {
    const longBody = Array.from({ length: 250 }, (_, i) => `word${i}`).join(" ");
    const result = classifyDeterministically("Refactor module", longBody);
    expect(result).toBeUndefined();
  });

  it("routes M work with security to ask_adr", () => {
    const result = classifyDeterministically(
      "Update auth middleware",
      "Change the role-based permission system for the admin API endpoints in src/auth.ts, src/middleware.ts, src/routes/admin.ts"
    );

    expect(result).toBeDefined();
    expect(result!.size).toBe("M");
    expect(result!.route).toBe("ask_adr");
    expect(result!.risks).toContain("security");
  });
});

import type { Classification, ClassificationRisk, WorkSize } from "../domain/types.js";

const RISK_KEYWORDS: Record<ClassificationRisk, RegExp[]> = {
  security: [/\bauth\b/i, /\bpassword\b/i, /\btoken\b/i, /\bsecret\b/i, /\bcrypto\b/i, /\bcrypt\b/i, /\bxss\b/i, /\bcsrf\b/i, /\binjection\b/i, /\bsanitiz/i, /\bpermission/i, /\brole\b/i, /\bacceso\b/i],
  public_api: [/\bapi\b/i, /\bendpoint\b/i, /\broute\b/i, /\brest\b/i, /\bgraphql\b/i, /\bwebhook\b/i],
  persistence: [/\bdatabase\b/i, /\bmigrat/i, /\bschema\b/i, /\btabla\b/i, /\bcolumna\b/i, /\bquery\b/i, /\bsql\b/i, /\bprisma\b/i, /\bdrizzle\b/i],
  external_integration: [/\bthird.party\b/i, /\bintegraci/i, /\bwebhook\b/i, /\bsdk\b/i, /\bapi\s+extern/i, /\bcurl\b/i],
  multi_package: [/\bmonorepo\b/i, /\bworkspace/i, /\bpackage.json\b/i, /\bdependenc/i],
  unknown_impact: [/\brefactor/i, /\brestructur/i, /\bmigrat/i, /\breaking\b/i, /\bdeprecat/i],
};

const RISK_COST: Record<ClassificationRisk, number> = {
  security: 3,
  public_api: 2,
  persistence: 2,
  external_integration: 2,
  multi_package: 2,
  unknown_impact: 2,
};

const SIZE_BASE: Record<WorkSize, number> = { XS: 1, S: 2, M: 3, L: 4, XL: 5 };

/**
 * Pure deterministic classifier. No LLM, no I/O.
 * Returns a Classification or undefined if the request is too complex to classify without LLM.
 */
export function classifyDeterministically(title: string, body?: string): Classification | undefined {
  const text = `${title}\n${body ?? ""}`.trim();
  const words = text.split(/\s+/).length;
  const paths = extractLiteralPaths(text);

  // Detect risks
  const risks = detectRisks(text);

  // Estimate size
  const size = estimateSize(paths.length, words, text);

  // XL must be split — never fast-track
  if (size === "XL") return undefined;

  // M/L need spec or Adr — can still classify deterministically
  // but only if the request is clear enough
  if ((size === "M" || size === "L") && words > 200) return undefined;

  // Determine route
  const route = determineRoute(size, risks);
  if (!route) return undefined;

  // Calculate complexity
  const complexityScore = SIZE_BASE[size] + risks.reduce((sum, r) => sum + RISK_COST[r], 0);

  // Estimate touched files
  const estimatedTouchedFiles = paths.length > 0
    ? paths.length
    : size === "XS" ? 1 : size === "S" ? 2 : size === "M" ? 4 : size === "L" ? 6 : 10;

  // Build proposed work
  const proposed = buildProposed(title, body, paths, route);

  return {
    route,
    size,
    estimatedTouchedFiles,
    complexityScore,
    confidence: paths.length > 0 ? 0.85 : 0.7,
    risks,
    rationale: [
      `Deterministic classification: ${size}, ${route}.`,
      paths.length > 0 ? `Detected ${paths.length} file path(s).` : "No explicit file paths detected.",
      risks.length > 0 ? `Detected risks: ${risks.join(", ")}.` : "No risks detected.",
    ],
    proposed,
    ...(route === "ask_direct" ? { clarification: { field: "scope" as const } } : {}),
  };
}

function extractLiteralPaths(text: string): string[] {
  const matches = text.match(/\b(?:[\w./-]+\/)*[\w-]+\.[A-Za-z0-9]{1,10}\b/g) ?? [];
  // Filter out common false positives
  return [...new Set(matches.filter(p =>
    !p.startsWith("http") &&
    !p.includes("://") &&
    !p.endsWith(".com") &&
    !p.endsWith(".org") &&
    !p.endsWith(".io") &&
    !p.endsWith(".net") &&
    p.length < 200
  ))];
}

function detectRisks(text: string): ClassificationRisk[] {
  const found: ClassificationRisk[] = [];
  for (const [risk, patterns] of Object.entries(RISK_KEYWORDS)) {
    if (patterns.some((p) => p.test(text))) {
      found.push(risk as ClassificationRisk);
    }
  }
  return found;
}

function estimateSize(fileCount: number, wordCount: number, text: string): WorkSize {
  // If we can count files, use that as primary signal
  if (fileCount >= 9) return "XL";
  if (fileCount >= 5) return "L";
  if (fileCount >= 3) return "M";

  // Count distinct requirements/features mentioned
  const requirementCount = countRequirements(text);
  if (requirementCount >= 5) return "XL";
  if (requirementCount >= 3 && fileCount <= 2) return "M";

  // Short text with few files = small work
  if (wordCount <= 30 && fileCount <= 2) return "XS";
  if (wordCount <= 80 && fileCount <= 2) return "S";

  // Medium text
  if (wordCount <= 200) return fileCount <= 2 ? "S" : "M";

  // Long text
  return fileCount <= 2 ? "M" : "L";
}

/**
 * Count distinct requirements by looking for repeated patterns like
 * "tambien", "ademas", "also", "additionally", numbered lists, etc.
 */
function countRequirements(text: string): number {
  const lower = text.toLowerCase();
  // Count "también/tambien/además/ademas/also/additionally" as requirement separators
  const tambienMatches = lower.match(/\btambi[eé]n\b/g) ?? [];
  const ademasMatches = lower.match(/\badem[aá]s\b/g) ?? [];
  const alsoMatches = /\balso\b/g.test(lower) ? 1 : 0;
  const additionallyMatches = /\badditionally\b/g.test(lower) ? 1 : 0;
  // Count numbered items (1. 2. 3. or 1) 2) 3))
  const numberedMatches = text.match(/\b\d+[.)]\s/g) ?? [];
  // Count bullet points
  const bulletMatches = text.match(/^[\s]*[-*•]\s/gm) ?? [];

  return 1 + tambienMatches.length + ademasMatches.length + alsoMatches + additionallyMatches + numberedMatches.length + bulletMatches.length;
}

function determineRoute(size: WorkSize, risks: ClassificationRisk[]): Classification["route"] | undefined {
  // XL must split
  if (size === "XL") return "split";

  // XS/S with no risks → auto_direct
  if ((size === "XS" || size === "S") && risks.length === 0) return "auto_direct";

  // XS/S with risks → ask_direct (need human to confirm scope)
  if (size === "XS" || size === "S") return "ask_direct";

  // M/L → needs spec or adr
  if (size === "M" || size === "L") {
    if (risks.includes("security") || risks.includes("public_api")) return "ask_adr";
    return "ask_spec";
  }

  return undefined;
}

function buildProposed(
  title: string,
  body: string | undefined,
  paths: string[],
  route: Classification["route"],
): Classification["proposed"] {
  const goal = body?.trim() || title;
  const acceptance = buildAcceptance(title, body, paths);

  return {
    title: title.slice(0, 120),
    goal: goal.slice(0, 500),
    acceptance,
    verification: buildVerification(paths, acceptance),
  };
}

function buildAcceptance(title: string, body: string | undefined, paths: string[]): string[] {
  const text = `${title} ${body ?? ""}`.trim();
  const criteria: string[] = [];

  // File existence criteria
  for (const p of paths) {
    criteria.push(`File ${p} exists and is valid`);
  }

  // Extract intent-based criteria from the text
  const sentences = text.split(/[.!]\s+/).filter((s) => s.trim().length > 10);
  for (const sentence of sentences.slice(0, 3)) {
    const cleaned = sentence.replace(/^["']|["']$/g, "").trim();
    if (cleaned.length > 10 && cleaned.length < 200) {
      criteria.push(cleaned);
    }
  }

  // Fallback
  if (criteria.length === 0) {
    criteria.push(title.slice(0, 150));
  }

  return criteria.slice(0, 5);
}

function buildVerification(paths: string[], acceptance: string[]): NonNullable<Classification["proposed"]["verification"]> {
  const commands: Array<{ name: string; run: string }> = [];
  const seen = new Set<string>();

  for (const p of paths) {
    const cmd = `test -f ${p}`;
    if (!seen.has(cmd)) {
      seen.add(cmd);
      commands.push({ name: `verify ${p} exists`, run: cmd });
    }
  }

  // Content check if acceptance mentions content
  if (paths.length > 0 && acceptance.some((a) => /contain|has|include|with/i.test(a))) {
    const cmd = `cat ${paths[0]}`;
    if (!seen.has(cmd)) {
      seen.add(cmd);
      commands.push({ name: "check content", run: cmd });
    }
  }

  // Fallback
  if (commands.length === 0) {
    commands.push({ name: "verify completion", run: "echo 'Manual verification required'" });
  }

  return { commands, requiredEvidence: [] };
}

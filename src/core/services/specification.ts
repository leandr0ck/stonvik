import type { CreateFeatureInput, FeatureManifest, ValidationIssue } from "../domain/types.js";

export interface SpecificationValidation {
  valid: boolean;
  issues: ValidationIssue[];
  sections: Map<string, string>;
}

const REQUIRED_SECTIONS: Array<{ name: string; aliases: string[] }> = [
  { name: "problem", aliases: ["problem", "context", "problema", "contexto"] },
  { name: "scope", aliases: ["scope", "alcance", "objective", "objetivo"] },
  { name: "acceptance", aliases: ["acceptance", "acceptance criteria", "criterios de aceptación", "criterios de aceptacion"] },
  { name: "constraints", aliases: ["constraints", "restrictions", "restricciones"] },
  { name: "verification", aliases: ["verification", "verificación", "verificacion", "validation", "validación", "validacion"] },
];

export function validateSpecificationDocument(content: string, documentPath = "spec.md"): SpecificationValidation {
  const sections = parseSections(content);
  const issues: ValidationIssue[] = [];
  if (!/^\s*#\s+\S+/m.test(content)) issues.push({ severity: "error", code: "SPEC_TITLE_REQUIRED", message: "Specification requires an H1 title.", path: documentPath });
  for (const required of REQUIRED_SECTIONS) {
    const section = required.aliases.map((alias) => sections.get(normalizeHeading(alias))).find((value) => value !== undefined);
    if (!section || !meaningful(section)) {
      issues.push({ severity: "error", code: "SPEC_SECTION_REQUIRED", message: `Specification requires a non-empty ${required.name} section.`, path: documentPath });
    }
  }
  if (/_TBD_|\bTBD\b/i.test(content)) issues.push({ severity: "error", code: "SPEC_INCOMPLETE", message: "Specification still contains TBD placeholders.", path: documentPath });
  return { valid: issues.length === 0, issues, sections };
}

export function renderSpecificationTemplate(title: string, body: string | undefined): string {
  return [
    `# ${title}`,
    "",
    "## Problem",
    "",
    body?.trim() || "_TBD_",
    "",
    "## Scope",
    "",
    "_TBD_",
    "",
    "## Acceptance",
    "",
    "- _TBD_",
    "",
    "## Constraints",
    "",
    "- _TBD_",
    "",
    "## Verification",
    "",
    "- _TBD_",
    "",
  ].join("\n");
}

export function deriveImplementationFromSpecification(
  specification: FeatureManifest,
  content: string,
): Omit<CreateFeatureInput, "source" | "kind" | "specificationRef" | "routingDecision" | "routingDecisionRef"> {
  const validation = validateSpecificationDocument(content);
  const title = implementationTitle(specification.title);
  const scope = sectionFor(validation.sections, ["scope", "alcance"]);
  const acceptanceSection = sectionFor(validation.sections, ["acceptance", "acceptance criteria", "criterios de aceptación", "criterios de aceptacion"]);
  const constraintsSection = sectionFor(validation.sections, ["constraints", "restrictions", "restricciones"]);
  const verificationSection = sectionFor(validation.sections, ["verification", "verificación", "verificacion", "validation", "validación", "validacion"]);
  const acceptance = bulletValues(acceptanceSection).length
    ? bulletValues(acceptanceSection)
    : specification.acceptance.length ? [...specification.acceptance] : ["The approved specification is implemented."];
  const constraints = bulletValues(constraintsSection);
  const commands = verificationCommands(verificationSection);
  return {
    title,
    goal: meaningful(scope) ? scope!.trim() : `Implement the approved specification: ${specification.title}.`,
    acceptance,
    constraints: constraints.length ? constraints : undefined,
    verification: commands.length
      ? { commands, review: "required" }
      : { commands: [], requiredEvidence: [{ criterion: acceptance[0]!, kind: "implementation-review" }], review: "required" },
  };
}

export function parseSections(content: string): Map<string, string> {
  const sections = new Map<string, string>();
  const matches = [...content.matchAll(/^##\s+(.+)\s*$/gm)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? content.length;
    const heading = normalizeHeading(match[1]!);
    sections.set(heading, content.slice(start, end).trim());
  }
  return sections;
}

function normalizeHeading(value: string): string {
  return value.toLowerCase().replace(/[：:]/g, "").replace(/\s+/g, " ").trim();
}

function sectionFor(sections: Map<string, string>, aliases: string[]): string | undefined {
  for (const alias of aliases) {
    const section = sections.get(normalizeHeading(alias));
    if (section !== undefined) return section;
  }
  return undefined;
}

function meaningful(value: string | undefined): boolean {
  if (!value) return false;
  const cleaned = value.replace(/[-*_`\s]/g, "").trim();
  return cleaned.length > 0 && !/^tbd$/i.test(cleaned);
}

function bulletValues(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/\r?\n/)
    .map((line) => line.match(/^\s*[-*+]\s+(.+?)\s*$/)?.[1] ?? line.match(/^\s*\d+[.)]\s+(.+?)\s*$/)?.[1])
    .filter((line): line is string => Boolean(line && meaningful(line)))
    .map((line) => line.replace(/^`|`$/g, "").trim());
}

function verificationCommands(value: string | undefined): Array<{ name: string; run: string }> {
  if (!value) return [];
  const commands: Array<{ name: string; run: string }> = [];
  for (const line of value.split(/\r?\n/)) {
    const candidate = line.match(/^\s*[-*+]\s+(?:`([^`]+)`|\$\s+(.+)|(.+))\s*$/)?.slice(1).find(Boolean)?.trim();
    if (!candidate || /^tbd$/i.test(candidate) || /\b(manual|evidencia|evidence)\b/i.test(candidate)) continue;
    commands.push({ name: `spec-verification-${commands.length + 1}`, run: candidate });
  }
  return commands;
}

function implementationTitle(title: string): string {
  const cleaned = title.replace(/\s+(?:specification|technical spec|spec)$/i, "").replace(/^specification\s*[:—-]\s*/i, "").trim();
  return cleaned || `Implement ${title}`;
}

import type { InboxItem, RoutingDecision, RoutingPolicy, WorkSize } from "../domain/types.js";
import { RoutingDecisionSchema } from "../schemas/routing.schema.js";
import type { CoreConfig } from "./config.js";
import { classifyDeterministically } from "./deterministic-classifier.js";
import { RoutingPolicyViolationError } from "../errors/stonvik-errors.js";

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  requireSpecWhen: {
    risks: ["public_api", "persistence", "security", "external_integration", "multi_package"],
  },
  direct: {
    maximumSize: "S",
    maximumTouchedFiles: 3,
  },
  ambiguity: {
    requireRole: "product-owner",
  },
};

const SIZE_ORDER: Record<WorkSize, number> = { XS: 1, S: 2, M: 3, L: 4, XL: 5 };

export interface RoutingSignalOverrides {
  size?: WorkSize;
  estimatedTouchedFiles?: number;
  risks?: string[];
  rationale?: string[];
}

export function routingPolicyFromConfig(config?: CoreConfig): RoutingPolicy {
  const configured = config?.routing;
  return {
    requireSpecWhen: {
      risks: configured?.requireSpecWhen?.risks !== undefined
        ? [...configured.requireSpecWhen.risks]
        : [...DEFAULT_ROUTING_POLICY.requireSpecWhen.risks],
    },
    direct: {
      maximumSize: configured?.direct?.maximumSize ?? DEFAULT_ROUTING_POLICY.direct.maximumSize,
      maximumTouchedFiles: configured?.direct?.maximumTouchedFiles ?? DEFAULT_ROUTING_POLICY.direct.maximumTouchedFiles,
    },
    ambiguity: {
      requireRole: configured?.ambiguity?.requireRole ?? DEFAULT_ROUTING_POLICY.ambiguity.requireRole,
    },
  };
}

/** Validate shape and size/file coherence independently of the active policy. */
export function validateRoutingDecisionShape(value: unknown): RoutingDecision {
  let decision: RoutingDecision;
  try { decision = RoutingDecisionSchema.parse(value) as RoutingDecision; }
  catch (error) { throw new RoutingPolicyViolationError(`Invalid routing decision: ${String((error as Error).message)}`); }
  const size = decision.signals.size;
  const touchedFiles = decision.signals.estimatedTouchedFiles;
  if (size && touchedFiles !== undefined && !sizeMatchesTouchedFiles(size, touchedFiles)) {
    throw new RoutingPolicyViolationError(`Routing size ${size} disagrees with estimated touched files ${touchedFiles}.`);
  }
  if (decision.route === "direct" && (!size || touchedFiles === undefined)) {
    throw new RoutingPolicyViolationError("Direct routing requires size and estimatedTouchedFiles signals.");
  }
  return decision;
}

/** Validate a route against the deterministic policy selected for the decision. */
export function validateRoutingDecision(value: unknown, policy: RoutingPolicy = DEFAULT_ROUTING_POLICY): RoutingDecision {
  const decision = validateRoutingDecisionShape(value);
  const size = decision.signals.size;
  const touchedFiles = decision.signals.estimatedTouchedFiles;
  if (decision.route !== "direct") return decision;

  if (!size || touchedFiles === undefined) {
    throw new RoutingPolicyViolationError("Direct routing requires size and estimatedTouchedFiles signals.");
  }
  const authority = decision.decidedBy.role === policy.ambiguity.requireRole;
  if (SIZE_ORDER[size] > SIZE_ORDER[policy.direct.maximumSize] && !authority) {
    throw new RoutingPolicyViolationError(`Direct routing is limited to ${policy.direct.maximumSize}; received ${size}.`);
  }
  if (touchedFiles > policy.direct.maximumTouchedFiles && !authority) {
    throw new RoutingPolicyViolationError(`Direct routing is limited to ${policy.direct.maximumTouchedFiles} touched files; received ${touchedFiles}.`);
  }
  const requiredRisk = decision.signals.risks.find((risk) => policy.requireSpecWhen.risks.includes(risk));
  if (requiredRisk && !authority) {
    throw new RoutingPolicyViolationError(`Risk \`${requiredRisk}\` requires a spec or ADR route.`);
  }
  if (decision.signals.risks.includes("unknown_impact") && decision.decidedBy.role !== policy.ambiguity.requireRole) {
    throw new RoutingPolicyViolationError(`Ambiguous work requires actor role ${policy.ambiguity.requireRole}.`);
  }
  return decision;
}

/** Build a routing decision from observable Inbox text and optional actor-declared signals. */
export function buildRoutingDecision(
  item: Pick<InboxItem, "id" | "title" | "body">,
  route: RoutingDecision["route"],
  decidedBy: RoutingDecision["decidedBy"],
  overrides: RoutingSignalOverrides = {},
  policy: RoutingPolicy = DEFAULT_ROUTING_POLICY,
): RoutingDecision {
  const inferred = classifyDeterministically(item.title, item.body);
  const fallbackSize = inferSize(item.title, item.body);
  const risks = overrides.risks ?? inferred?.risks ?? inferRisks(item.title, item.body);
  const size = overrides.size ?? inferred?.size ?? fallbackSize;
  const estimatedTouchedFiles = overrides.estimatedTouchedFiles
    ?? (inferred?.size === size ? inferred.estimatedTouchedFiles : undefined)
    ?? inferTouchedFiles(item.title, item.body, size);
  const rationale = overrides.rationale?.filter(Boolean) ?? [
    inferred ? `Observed deterministic signals: ${size}, ${estimatedTouchedFiles} touched file(s).` : `Declared conservative signals: ${size}, ${estimatedTouchedFiles} touched file(s).`,
    risks.length ? `Declared risks: ${risks.join(", ")}.` : "No routing risks were declared.",
  ];
  const policyException = route === "direct"
    && decidedBy.role === policy.ambiguity.requireRole
    && (SIZE_ORDER[size] > SIZE_ORDER[policy.direct.maximumSize]
      || estimatedTouchedFiles > policy.direct.maximumTouchedFiles
      || risks.some((risk) => policy.requireSpecWhen.risks.includes(risk))
      || risks.includes("unknown_impact"));
  if (policyException) rationale.push(`Policy exception confirmed by actor role ${policy.ambiguity.requireRole}.`);
  const decision: RoutingDecision = {
    schemaVersion: 1,
    inboxId: item.id,
    route,
    signals: { size, estimatedTouchedFiles, risks },
    rationale: rationale.length ? rationale : ["Routing decision recorded by the declared actor."],
    decidedBy,
    created: new Date().toISOString(),
  };
  return validateRoutingDecision(decision, policy);
}

function sizeMatchesTouchedFiles(size: WorkSize, files: number): boolean {
  return size === "XS" ? files === 1
    : size === "S" ? files >= 1 && files <= 2
      : size === "M" ? files >= 3 && files <= 5
        : size === "L" ? files >= 5 && files <= 8
          : files > 8;
}

function inferTouchedFiles(title: string, body: string | undefined, size: WorkSize): number {
  const paths = extractPaths(`${title}\n${body ?? ""}`);
  if (paths.length) return paths.length;
  return size === "XS" ? 1 : size === "S" ? 2 : size === "M" ? 4 : size === "L" ? 6 : 9;
}

function inferSize(title: string, body: string | undefined): WorkSize {
  const text = `${title}\n${body ?? ""}`;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const paths = extractPaths(text).length;
  if (paths >= 9 || words > 300) return "XL";
  if (paths >= 5 || words > 150) return "L";
  if (paths >= 3 || words > 70) return "M";
  if (words <= 30 && paths <= 1) return "XS";
  return "S";
}

function inferRisks(title: string, body: string | undefined): string[] {
  const text = `${title}\n${body ?? ""}`;
  const risks: string[] = [];
  const checks: Array<[string, RegExp]> = [
    ["security", /\b(auth|password|token|secret|crypto|permission|role|xss|csrf|injection)\b/i],
    ["public_api", /\b(api|endpoint|route|rest|graphql|webhook)\b/i],
    ["persistence", /\b(database|migration|schema|table|column|query|sql|prisma|drizzle)\b/i],
    ["external_integration", /\b(integration|third[ -]?party|sdk|external api|curl)\b/i],
    ["multi_package", /\b(monorepo|workspace|package\.json|dependency|dependencies)\b/i],
  ];
  for (const [risk, pattern] of checks) if (pattern.test(text)) risks.push(risk);
  return risks;
}

function extractPaths(text: string): string[] {
  return [...new Set(text.match(/\b(?:[\w.-]+\/)*[\w-]+\.[A-Za-z0-9]{1,12}\b/g) ?? [])]
    .filter((value) => !value.startsWith("http") && !value.includes("://"));
}

import type { Feature, WorkHandoff } from "../domain/types.js";
import { WorkHandoffSchema } from "../schemas/handoff.schema.js";

export function createWorkHandoff(feature: Feature, generated = new Date().toISOString()): WorkHandoff {
  const manifest = feature.manifest;
  const handoff: WorkHandoff = {
    schemaVersion: 1,
    generated,
    work: {
      id: feature.id,
      kind: manifest.kind ?? "implementation",
      title: manifest.title,
      goal: manifest.goal,
      acceptance: [...manifest.acceptance],
      constraints: [...(manifest.constraints ?? [])],
      source: manifest.source,
      specificationRef: manifest.specificationRef,
    },
    execution: {
      allowedPaths: ["repository files required by the Work; never product/, features/, or .stonvik/"],
      verification: manifest.verification,
    },
    protocol: {
      reportCommand: `stonvik work report ${feature.id} --receipt <path>`,
      requestReviewCommand: `stonvik work review ${feature.id} --actor <reviewer> --decision <decision>`,
    },
  };
  return WorkHandoffSchema.parse(handoff) as WorkHandoff;
}

export function renderWorkHandoffMarkdown(handoff: WorkHandoff): string {
  const lines = [
    `# Work handoff — ${handoff.work.title}`,
    "",
    `- **ID:** \`${handoff.work.id}\``,
    `- **Kind:** \`${handoff.work.kind}\``,
    `- **Generated:** ${handoff.generated}`,
    ...(handoff.work.source ? [`- **Source:** ${handoff.work.source.type}:${handoff.work.source.ref}`] : []),
    ...(handoff.work.specificationRef ? [`- **Specification:** \`${handoff.work.specificationRef}\``] : []),
    "",
    "## Goal",
    "",
    handoff.work.goal,
    "",
    "## Acceptance",
    "",
    ...handoff.work.acceptance.map((criterion) => `- ${criterion}`),
    "",
    "## Constraints",
    "",
    ...(handoff.work.constraints.length ? handoff.work.constraints.map((constraint) => `- ${constraint}`) : ["- None declared"]),
    "",
    "## Allowed paths",
    "",
    ...(handoff.execution.allowedPaths ?? ["No explicit path restriction declared"]).map((allowedPath) => `- ${allowedPath}`),
    "",
    "## Verification",
    "",
    ...(handoff.execution.verification.commands.length
      ? handoff.execution.verification.commands.map((command) => `- **${command.name}:** \`${command.run}\``)
      : ["- Manual evidence required"]),
    ...(handoff.execution.verification.requiredEvidence ?? []).map((evidence) => `- Evidence: **${evidence.criterion}** (${evidence.kind})`),
    "",
    "## Protocol",
    "",
    `1. Report the external result with \`${handoff.protocol.reportCommand}\`.`,
    `2. Run \`stonvik verify ${handoff.work.id}\`, then request independent review with \`${handoff.protocol.requestReviewCommand}\`.`,
    "",
  ];
  return lines.join("\n");
}

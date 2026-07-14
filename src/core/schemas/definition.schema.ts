import { z } from "zod";

export const DefinitionMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  inboxRef: z.string().min(1),
  kind: z.enum(["spec", "adr"]),
  created: z.string().datetime({ offset: true }),
  document: z.string().min(1),
}).strict();

export const DefinitionDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  inboxRef: z.string().min(1),
  kind: z.enum(["spec", "adr"]),
  title: z.string().min(1),
  goal: z.string().min(1),
  acceptance: z.array(z.string().min(1)).min(1),
  verification: z.object({
    commands: z.array(z.object({ name: z.string().min(1), run: z.string().min(1), timeoutMs: z.number().int().positive().optional() })),
    requiredEvidence: z.array(z.object({ criterion: z.string().min(1), kind: z.string().min(1) })).optional(),
  }).refine((policy) => policy.commands.length > 0 || (policy.requiredEvidence?.length ?? 0) > 0),
}).strict();

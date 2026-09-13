import { z } from "zod";
import { ActorRefSchema } from "./actor.schema.js";

export const ExternalExecutionReportSchema = z.object({
  schemaVersion: z.literal(1),
  actor: ActorRefSchema,
  outcome: z.enum(["completed", "blocked", "needs_human", "cancelled"]),
  summary: z.string().min(1).max(10_000),
  artifacts: z.array(z.string().min(1).max(500)).max(500).optional(),
  evidence: z.array(z.object({
    criterion: z.string().min(1),
    kind: z.string().min(1),
    ref: z.string().min(1).optional(),
  }).strict()).max(500).optional(),
  details: z.record(z.unknown()).optional(),
}).strict();

export type ExternalExecutionReportPayload = z.infer<typeof ExternalExecutionReportSchema>;

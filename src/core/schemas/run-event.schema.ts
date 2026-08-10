import { z } from "zod";

const LegacyRunEventSchema = z.object({
  at: z.string().datetime({ offset: true }),
  type: z.enum(["status", "classification", "transition", "receipt", "gate", "stop"]),
  workId: z.string().optional(),
  inboxId: z.string().optional(),
  state: z.string().optional(),
  message: z.string().min(1),
  nextAction: z.string().optional(),
}).strict();

const V2RunEventSchema = z.object({
  schemaVersion: z.literal(2),
  eventId: z.string().min(1),
  runId: z.string().min(1),
  sequence: z.number().int().positive(),
  at: z.string().datetime({ offset: true }),
  type: z.enum(["status", "classification", "transition", "receipt", "gate", "stop"]),
  kind: z.string().min(1).optional(),
  phase: z.enum(["preflight", "classification", "definition", "execution", "verification", "review"]).optional(),
  severity: z.enum(["info", "warning", "error"]).optional(),
  workId: z.string().optional(),
  inboxId: z.string().optional(),
  state: z.string().optional(),
  message: z.string().min(1).max(500),
  nextAction: z.string().max(300).optional(),
  stopReason: z.string().min(1).optional(),
  elapsedMs: z.number().int().nonnegative().optional(),
}).strict();

export const RunEventSchema = z.union([V2RunEventSchema, LegacyRunEventSchema]);

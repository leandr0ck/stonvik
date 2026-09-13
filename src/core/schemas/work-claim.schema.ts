import { z } from "zod";
import { ActorRefSchema } from "./actor.schema.js";

export const WorkClaimSchema = z.object({
  schemaVersion: z.literal(1),
  workId: z.string().min(1),
  runId: z.string().min(1),
  actor: ActorRefSchema,
  claimedAt: z.string().datetime({ offset: true }),
  host: z.string().min(1),
  pid: z.number().int().positive(),
}).strict();

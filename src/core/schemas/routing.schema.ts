import { z } from "zod";
import { ActorRefSchema } from "./actor.schema.js";

export const RoutingDecisionSchema = z.object({
  schemaVersion: z.literal(1),
  inboxId: z.string().min(1),
  route: z.enum(["direct", "spec", "adr"]),
  signals: z.object({
    size: z.enum(["XS", "S", "M", "L", "XL"]).optional(),
    estimatedTouchedFiles: z.number().int().nonnegative().optional(),
    risks: z.array(z.string().min(1).max(80)).max(50),
  }).strict(),
  rationale: z.array(z.string().min(1).max(500)).min(1),
  proposedBy: ActorRefSchema.optional(),
  decidedBy: ActorRefSchema,
  created: z.string().datetime({ offset: true }),
}).strict();

export type RoutingDecisionPayload = z.infer<typeof RoutingDecisionSchema>;

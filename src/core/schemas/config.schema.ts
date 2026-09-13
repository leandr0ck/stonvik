import { z } from "zod";

export const RoutingPolicySchema = z.object({
  requireSpecWhen: z.object({ risks: z.array(z.string().min(1)).optional() }).optional(),
  direct: z.object({
    maximumSize: z.enum(["XS", "S", "M", "L", "XL"]).optional(),
    maximumTouchedFiles: z.number().int().positive().optional(),
  }).optional(),
  ambiguity: z.object({
    requireRole: z.enum(["triager", "implementer", "specifier", "verifier", "reviewer", "product-owner"]).optional(),
  }).optional(),
}).strict();

/** Only configuration understood by the agent-neutral core. */
export const CoreConfigSchema = z.object({
  routing: RoutingPolicySchema.optional(),
}).strict();

export type CoreConfigPayload = z.infer<typeof CoreConfigSchema>;

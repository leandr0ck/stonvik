import { z } from "zod";
import { ClassificationSchema } from "./classification.schema.js";
import { VerificationPolicySchema } from "./verification.schema.js";
import { RoutingDecisionSchema } from "./routing.schema.js";
export const ManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1).regex(/^feature-[a-z0-9][a-z0-9-]*$/),
  // Optional on disk for backwards compatibility; parsing supplies the legacy default.
  kind: z.enum(["implementation", "specification"]).default("implementation"),
  title: z.string().min(1),
  created: z.string().datetime({ offset: true }),
  source: z.object({ type: z.string().min(1), ref: z.string().min(1) }).optional(),
  goal: z.string().min(1),
  acceptance: z.array(z.string().min(1)).min(1),
  constraints: z.array(z.string().min(1)).optional(),
  verification: VerificationPolicySchema,
  classification: ClassificationSchema.optional(),
  routingDecision: RoutingDecisionSchema.optional(),
  routingDecisionRef: z.string().min(1).optional(),
  specificationRef: z.string().min(1).optional(),
  deliverables: z.array(z.string().min(1)).min(1).optional(),
}).strict();

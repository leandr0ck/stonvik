import { z } from "zod";
import { ClassificationSchema } from "./classification.schema.js";
import { RoutingDecisionSchema } from "./routing.schema.js";
export const InboxFrontmatterSchema = z.object({
  id: z.string().min(1).regex(/^inbox-[A-Za-z0-9T:+-]+-[a-z0-9]+$/),
  // Sources may be actor-qualified values such as human:terminal.
  source: z.string().min(1).max(200).refine((value) => !/[\r\n]/.test(value), "Source cannot contain newlines."),
  created: z.string().datetime({ offset: true }),
  status: z.enum(["captured", "needs_clarification", "needs_definition", "needs_review", "promoted", "merged", "deferred", "rejected"]),
  clarification: z.object({
    field: z.enum(["output_path", "verification", "scope"]),
    answer: z.string().min(1).optional(),
  }).strict().optional(),
  // Kept so Inbox files created before the agent-neutral flow remain readable.
  definitionRef: z.string().optional(),
  definitionKind: z.enum(["spec", "adr"]).optional(),
  featureRef: z.string().optional(),
  classification: ClassificationSchema.optional(),
  routingDecision: RoutingDecisionSchema.optional(),
}).strict();

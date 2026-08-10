import { z } from "zod";
import { ClassificationSchema } from "./classification.schema.js";
export const InboxFrontmatterSchema = z.object({
  id: z.string().min(1).regex(/^inbox-[A-Za-z0-9T:+-]+-[a-z0-9]+$/),
  source: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/),
  created: z.string().datetime({ offset: true }),
  status: z.enum(["captured", "needs_clarification", "needs_definition", "promoted", "merged", "deferred", "rejected"]),
  clarification: z.object({
    field: z.enum(["output_path", "verification", "scope"]),
    answer: z.string().min(1).optional(),
  }).strict().optional(),
  definitionRef: z.string().optional(),
  definitionKind: z.enum(["spec", "adr"]).optional(),
  featureRef: z.string().optional(),
  classification: ClassificationSchema.optional(),
}).strict();

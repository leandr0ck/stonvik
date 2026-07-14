import { z } from "zod";
import { ClassificationSchema } from "./classification.schema.js";

export const ClassificationReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("classification"),
  inboxId: z.string().min(1),
  runId: z.string().min(1),
  created: z.string().datetime({ offset: true }),
  outcome: z.literal("classified"),
  classification: ClassificationSchema,
}).strict();

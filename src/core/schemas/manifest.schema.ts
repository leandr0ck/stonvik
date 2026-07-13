import { z } from "zod";
export const ManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1).regex(/^feature-[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1),
  created: z.string().datetime({ offset: true }),
  source: z.object({ type: z.string().min(1), ref: z.string().min(1) }).optional(),
  goal: z.string().min(1),
  acceptance: z.array(z.string().min(1)).min(1),
  constraints: z.array(z.string().min(1)).optional(),
  verification: z.object({
    commands: z.array(z.object({
      name: z.string().min(1),
      run: z.string().min(1),
      timeoutMs: z.number().int().positive().optional()
    })),
    requiredEvidence: z.array(z.object({ criterion: z.string().min(1), kind: z.string().min(1) })).optional(),
    review: z.literal("required").optional()
  }).optional()
});

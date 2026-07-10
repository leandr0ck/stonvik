import { z } from "zod";
export const ManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1).regex(/^feature-[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1),
  created: z.string().datetime({ offset: true }),
  source: z.object({ type: z.string().min(1), ref: z.string().min(1) }).optional(),
  goal: z.string().min(1),
  acceptance: z.array(z.string().min(1)).min(1),
  constraints: z.array(z.string().min(1)).optional()
});

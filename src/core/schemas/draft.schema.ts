import { z } from "zod";

export const DraftSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1).regex(/^draft-[a-z0-9][a-z0-9-]*$/),
  created: z.string().datetime({ offset: true }),
  source: z.object({ type: z.string().min(1), ref: z.string().min(1) }),
  title: z.string().min(1),
  goal: z.string(),
  acceptance: z.array(z.string()),
  constraints: z.array(z.string()).optional()
});

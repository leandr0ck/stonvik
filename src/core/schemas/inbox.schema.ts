import { z } from "zod";
export const InboxFrontmatterSchema = z.object({
  id: z.string().min(1).regex(/^inbox-[A-Za-z0-9T:+-]+-[a-z0-9]+$/),
  source: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/),
  created: z.string().datetime({ offset: true }),
  status: z.enum(["captured", "promoted", "merged", "deferred"]),
  featureRef: z.string().optional()
});

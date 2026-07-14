import { z } from "zod";

export const WorkReviewDecisionSchema = z.object({
  outcome: z.enum(["approved", "changes_requested", "blocked", "needs_human"]),
  summary: z.string().min(1),
  findings: z.array(z.object({ severity: z.enum(["critical", "major", "minor"]), message: z.string().min(1), reference: z.string().optional() })),
  evidence: z.array(z.string()),
}).strict();

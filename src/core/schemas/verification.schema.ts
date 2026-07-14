import { z } from "zod";

export const VerificationPolicySchema = z.object({
  commands: z.array(z.object({
    name: z.string().min(1),
    run: z.string().min(1),
    timeoutMs: z.number().int().positive().optional(),
  })),
  requiredEvidence: z.array(z.object({ criterion: z.string().min(1), kind: z.string().min(1) })).optional(),
  review: z.literal("required").optional(),
}).strict().refine((policy) => policy.commands.length > 0 || (policy.requiredEvidence?.length ?? 0) > 0, {
  message: "Verification requires at least one command or manual evidence requirement.",
});

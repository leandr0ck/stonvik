import { z } from "zod";
import { VerificationPolicySchema } from "./verification.schema.js";

export const ClassificationSchema = z.object({
  route: z.enum(["auto_direct", "ask_direct", "ask_spec", "ask_adr", "split"]),
  size: z.enum(["XS", "S", "M", "L", "XL"]),
  estimatedTouchedFiles: z.number().int().nonnegative(),
  complexityScore: z.number().int().positive(),
  confidence: z.number().min(0).max(1),
  risks: z.array(z.enum(["public_api", "persistence", "security", "external_integration", "multi_package", "unknown_impact"])),
  rationale: z.array(z.string().min(1)).min(1),
  proposed: z.object({
    title: z.string().min(1),
    goal: z.string().min(1),
    acceptance: z.array(z.string().min(1)).min(1),
    verification: VerificationPolicySchema,
  }),
}).strict();

export type ClassificationPayload = z.infer<typeof ClassificationSchema>;

import { z } from "zod";
import { VerificationPolicySchema } from "./verification.schema.js";

const RepositoryPathSchema = z.string().min(1).max(500).refine((value) => {
  return !value.includes("\0") && !value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value) && !value.split(/[\\/]/).includes("..");
}, "Path must be relative to the repository and cannot escape it.");

export const WorkHandoffSchema = z.object({
  schemaVersion: z.literal(1),
  generated: z.string().datetime({ offset: true }),
  work: z.object({
    id: z.string().min(1),
    kind: z.enum(["implementation", "specification"]),
    title: z.string().min(1),
    goal: z.string().min(1),
    acceptance: z.array(z.string().min(1)).min(1),
    constraints: z.array(z.string().min(1)),
    source: z.object({ type: z.string().min(1), ref: z.string().min(1) }).optional(),
    specificationRef: z.string().min(1).optional(),
  }).strict(),
  execution: z.object({
    allowedPaths: z.array(RepositoryPathSchema).optional(),
    verification: VerificationPolicySchema,
  }).strict(),
  protocol: z.object({
    reportCommand: z.string().min(1),
    requestReviewCommand: z.string().min(1),
  }).strict(),
}).strict();

export { RepositoryPathSchema };

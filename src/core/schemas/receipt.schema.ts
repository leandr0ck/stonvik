import { z } from "zod";

const ReceiptBaseSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1).regex(/^receipt-[A-Za-z0-9T:+-]+-[a-z0-9]+-[a-z-]+$/),
  kind: z.enum(["execution", "verification", "review", "handoff"]),
  created: z.string().datetime({ offset: true }),
  feature: z.object({ id: z.string().min(1), manifestPath: z.string().min(1) }),
  runId: z.string().min(1),
  actor: z.object({ type: z.string().min(1), name: z.string().min(1), role: z.enum(["triager", "implementer", "specifier", "verifier", "reviewer", "product-owner"]).optional(), version: z.string().optional() }),
  outcome: z.string().min(1),
  summary: z.string().min(1)
});

const VerificationReceiptSchema = ReceiptBaseSchema.extend({
  kind: z.literal("verification"),
  outcome: z.enum(["passed", "failed", "manual_required", "not_configured", "cancelled"]),
  checks: z.array(z.object({
    name: z.string().min(1),
    command: z.string().min(1),
    cwd: z.string().min(1),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().nonnegative(),
    status: z.enum(["passed", "failed", "cancelled"]),
    outputSummary: z.string()
  })),
  evidence: z.array(z.object({
    criterion: z.string().min(1),
    kind: z.string().min(1),
    status: z.enum(["passed", "failed", "pending"]),
    ref: z.string().optional()
  })).optional()
});

const ReviewReceiptSchema = ReceiptBaseSchema.extend({
  kind: z.literal("review"),
  outcome: z.enum(["approved", "changes_requested", "blocked", "needs_human"]),
  decision: z.enum(["approved", "changes_requested", "blocked", "needs_human"]),
  findings: z.array(z.string().min(1)).optional()
});

const HandoffReceiptSchema = ReceiptBaseSchema.extend({
  kind: z.literal("handoff"),
  outcome: z.enum(["failed", "blocked", "needs_human", "cancelled"]),
  reason: z.string().min(1),
  relatedReceipt: z.string().optional()
});

const ExecutionReceiptSchema = ReceiptBaseSchema.extend({
  kind: z.literal("execution"),
  engine: z.string().optional(),
  artifacts: z.array(z.string().min(1)).optional(),
  evidence: z.array(z.object({ criterion: z.string().min(1), kind: z.string().min(1), ref: z.string().min(1).optional() }).strict()).optional(),
  details: z.record(z.unknown()).optional()
});

export const ReceiptSchema = z.discriminatedUnion("kind", [
  ExecutionReceiptSchema,
  VerificationReceiptSchema,
  ReviewReceiptSchema,
  HandoffReceiptSchema
]);

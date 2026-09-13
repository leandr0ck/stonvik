import { z } from "zod";

/**
 * Schema for stonvik.json configuration file.
 *
 * All fields are optional. Environment variables override file values.
 * The file lives at the repository root (next to .git).
 */
export const StonvikConfigSchema = z.object({
  pi: z
    .object({
      /** Command or path to the Pi binary. Default: "pi". */
      command: z.string().min(1).optional(),
      /** Model pattern for classification (lightweight, fast). Supports "provider/id" format. */
      classificationModel: z.string().min(1).optional(),
      /** Model pattern for implementation (full-featured). Supports "provider/id" format. */
      implementationModel: z.string().min(1).optional(),
      /** Model pattern for review (independent reviewer). Supports "provider/id" format. */
      reviewModel: z.string().min(1).optional(),
    })
    .optional(),
  classification: z
    .object({
      /** Timeout in milliseconds for classification. Default: 120000. */
      timeoutMs: z.number().int().positive().optional(),
      /** Heartbeat interval in milliseconds. Default: 10000. */
      heartbeatIntervalMs: z.number().int().positive().optional(),
    })
    .optional(),
  execution: z
    .object({
      /** Timeout in milliseconds for implementation. Default: 1800000 (30 min). */
      timeoutMs: z.number().int().positive().optional(),
      /** Heartbeat interval in milliseconds. Default: 10000. */
      heartbeatIntervalMs: z.number().int().positive().optional(),
    })
    .optional(),
  review: z
    .object({
      /** Timeout in milliseconds for review. Default: 120000. */
      timeoutMs: z.number().int().positive().optional(),
      /** Heartbeat interval in milliseconds. Default: 10000. */
      heartbeatIntervalMs: z.number().int().positive().optional(),
    })
    .optional(),
});

export type StonvikConfig = z.infer<typeof StonvikConfigSchema>;

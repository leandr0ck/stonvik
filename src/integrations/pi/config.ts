import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { RoutingPolicySchema } from "../../core/schemas/config.schema.js";

const CONFIG_FILENAME = "stonvik.json";

/** Historical configuration shape consumed only by the optional Pi integration. */
export const StonvikConfigSchema = z.object({
  pi: z.object({
    command: z.string().min(1).optional(),
    classificationModel: z.string().min(1).optional(),
    implementationModel: z.string().min(1).optional(),
    reviewModel: z.string().min(1).optional(),
  }).optional(),
  classification: z.object({
    timeoutMs: z.number().int().positive().optional(),
    heartbeatIntervalMs: z.number().int().positive().optional(),
  }).optional(),
  execution: z.object({
    timeoutMs: z.number().int().positive().optional(),
    heartbeatIntervalMs: z.number().int().positive().optional(),
  }).optional(),
  review: z.object({
    timeoutMs: z.number().int().positive().optional(),
    heartbeatIntervalMs: z.number().int().positive().optional(),
  }).optional(),
  routing: RoutingPolicySchema.optional(),
}).strict();

export type StonvikConfig = z.infer<typeof StonvikConfigSchema>;

export async function loadStonvikConfig(root: string): Promise<StonvikConfig | undefined> {
  const configPath = path.join(root, CONFIG_FILENAME);
  try {
    const raw = await fs.readFile(configPath, "utf8");
    return StonvikConfigSchema.parse(JSON.parse(raw) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function resolvePiCommand(config?: StonvikConfig): string {
  return process.env.STONVIK_PI_COMMAND ?? config?.pi?.command ?? "pi";
}

export function buildModelArgs(model?: string): string[] {
  return model ? ["--model", model] : [];
}

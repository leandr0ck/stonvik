import fs from "node:fs/promises";
import path from "node:path";
import { StonvikConfigSchema, type StonvikConfig } from "../schemas/config.schema.js";

export type { StonvikConfig };

const CONFIG_FILENAME = "stonvik.json";

/**
 * Load stonvik.json from the repository root.
 * Returns undefined if the file doesn't exist.
 * Throws if the file exists but is invalid.
 */
export async function loadStonvikConfig(root: string): Promise<StonvikConfig | undefined> {
  const configPath = path.join(root, CONFIG_FILENAME);
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return StonvikConfigSchema.parse(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Resolve the Pi command from config + env.
 * Priority: STONVIK_PI_COMMAND env > config.pi.command > "pi".
 */
export function resolvePiCommand(config?: StonvikConfig): string {
  return process.env.STONVIK_PI_COMMAND ?? config?.pi?.command ?? "pi";
}

/**
 * Build Pi CLI args array for model selection.
 * Returns an array like ["--model", "openai/gpt-4o"] or [] if no model specified.
 */
export function buildModelArgs(model?: string): string[] {
  if (!model) return [];
  return ["--model", model];
}

import fs from "node:fs/promises";
import path from "node:path";
import { CoreConfigSchema, type CoreConfigPayload } from "../schemas/config.schema.js";
import { ConfigInvalidError } from "../errors/stonvik-errors.js";

export type CoreConfig = CoreConfigPayload;

const CONFIG_FILENAME = "stonvik.json";

/**
 * Load only core-owned configuration. Historical agent-specific keys are
 * ignored rather than exposed to core services.
 */
export async function loadCoreConfig(root: string): Promise<CoreConfig | undefined> {
  const configPath = path.join(root, CONFIG_FILENAME);
  try {
    const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Configuration must be a JSON object.");
    const raw = parsed as { routing?: unknown };
    return CoreConfigSchema.parse({ routing: raw.routing });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigInvalidError(String((error as Error).message ?? error));
  }
}

/** @deprecated Compatibility exports for consumers of the historical Pi path. */
export { StonvikConfigSchema, loadStonvikConfig, resolvePiCommand, buildModelArgs } from "../../integrations/pi/config.js";
export type { StonvikConfig } from "../../integrations/pi/config.js";

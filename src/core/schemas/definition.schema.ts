import { z } from "zod";

const RepositoryRelativePathSchema = z.string().min(1).max(500).refine((value) => {
  return !value.includes("\0")
    && !value.startsWith("/")
    && !/^[A-Za-z]:[\\/]/.test(value)
    && !value.split(/[\\/]/).includes("..");
}, "Definition path must be relative to the repository and cannot escape it.");

/** Metadata Stonvik stores for a user-owned spec or ADR reference. */
export const DefinitionRefSchema = z.object({
  kind: z.enum(["spec", "adr"]),
  path: RepositoryRelativePathSchema,
}).strict();

export const DefinitionRefsSchema = z.array(DefinitionRefSchema).max(20);

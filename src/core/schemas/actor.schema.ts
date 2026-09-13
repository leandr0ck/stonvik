import { z } from "zod";

export const ActorTypeSchema = z.enum(["human", "agent", "ci", "process"]);
export const ActorRoleSchema = z.enum(["triager", "implementer", "specifier", "verifier", "reviewer", "product-owner"]);

/** Declarative provenance only; this schema does not authenticate an actor. */
export const ActorRefSchema = z.object({
  type: ActorTypeSchema,
  name: z.string().min(1).max(120).refine((value) => !/[\r\n]/.test(value), "Actor name cannot contain newlines."),
  role: ActorRoleSchema.optional(),
  version: z.string().min(1).max(120).optional(),
}).strict();

export type ActorRefPayload = z.infer<typeof ActorRefSchema>;

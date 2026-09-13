import { ActorRefSchema } from "../schemas/actor.schema.js";
import type { ActorRef, ActorRole } from "../domain/types.js";

/** Parse the public actor syntax: human:lean, agent:codex, ci:github, or process:runner. */
export function parseActor(value: unknown, role?: ActorRole): ActorRef {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Actor is required. Use <human|agent|ci|process>:<name>.");
  }
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`Invalid actor \`${value}\`. Use <human|agent|ci|process>:<name>.`);
  }
  const actor = ActorRefSchema.parse({
    type: value.slice(0, separator).trim(),
    name: value.slice(separator + 1).trim(),
    ...(role ? { role } : {}),
  }) as ActorRef;
  return actor;
}

export function actorFromInput(value: unknown, role: ActorRole, fallback?: string): ActorRef {
  if (value === undefined || value === null || value === "") {
    if (fallback) return parseActor(fallback, role);
    throw new Error("Actor is required. Pass --actor or set STONVIK_ACTOR.");
  }
  if (typeof value === "object" && value !== null) return ActorRefSchema.parse({ ...value, role: (value as { role?: ActorRole }).role ?? role }) as ActorRef;
  return parseActor(value, role);
}

export function actorKey(actor: { type: string; name: string }): string {
  return `${actor.type}:${actor.name}`;
}

export function sameActor(left: { type: string; name: string }, right: { type: string; name: string }): boolean {
  return actorKey(left) === actorKey(right);
}

export function actorSource(actor: ActorRef): string {
  return `${actor.type}:${actor.name}`;
}

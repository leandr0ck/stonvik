import { randomUUID } from "node:crypto";
import type { RunEvent } from "../domain/types.js";
import { RunEventSchema } from "../schemas/run-event.schema.js";

export type RunEventInput = Omit<RunEvent, "at" | "schemaVersion" | "eventId" | "runId" | "sequence">;
export type RunEventSubscriber = (event: RunEvent) => Promise<void> | void;

const MAX_MESSAGE_LENGTH = 500;
const MAX_NEXT_ACTION_LENGTH = 300;

export interface RunEventSinkOptions {
  runId: string;
  persist?: (event: RunEvent) => Promise<void>;
  subscribe?: RunEventSubscriber;
}

/** A single ordered, validated event stream for one autonomous run. */
export class RunEventSink {
  private sequence = 0;

  constructor(private readonly options: RunEventSinkOptions) {}

  async emit(input: RunEventInput, options: { durable?: boolean } = {}): Promise<RunEvent> {
    const event: RunEvent = {
      ...input,
      schemaVersion: 2,
      eventId: `event-${this.options.runId}-${this.sequence + 1}-${randomUUID().slice(0, 8)}`,
      runId: this.options.runId,
      sequence: ++this.sequence,
      at: new Date().toISOString(),
      severity: input.severity ?? "info",
      message: sanitize(input.message, MAX_MESSAGE_LENGTH),
      ...(input.nextAction ? { nextAction: sanitize(input.nextAction, MAX_NEXT_ACTION_LENGTH) } : {}),
    };
    RunEventSchema.parse(event);

    if (options.durable !== false) await this.options.persist?.(event);
    // Rendering and future integrations are observers. They must never change
    // the workflow result when they fail.
    try {
      await this.options.subscribe?.(event);
    } catch {
      // Best effort delivery is intentional; durable domain state remains authoritative.
    }
    return event;
  }
}

function sanitize(value: string, maxLength: number): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(sk|pk|api|token|secret)[_-]?[A-Za-z0-9_-]{12,}\b/gi, "[redacted]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, maxLength);
}

import type { ExecutionProfile, Feature } from "../domain/types.js";

export type ExecutionOutcome = "completed" | "verification_failed" | "blocked" | "needs_human" | "cancelled";

export interface AdapterProgress {
  kind: "agent.activity" | "execution.heartbeat";
  phase: "classification" | "execution" | "review";
  message: string;
  elapsedMs?: number;
  severity?: "info" | "warning" | "error";
  durable?: boolean;
}

export type AdapterProgressCallback = (progress: AdapterProgress) => Promise<void> | void;

export interface ExecutionRequest {
  root: string;
  feature: Feature;
  profile: ExecutionProfile;
  runId: string;
  permissions: "repository";
  allowedPaths?: string[];
  signal?: AbortSignal;
  onProgress?: AdapterProgressCallback;
}

export interface ExecutionResult {
  outcome: ExecutionOutcome;
  summary: string;
  artifacts?: string[];
  reason?: string;
  details?: Record<string, unknown>;
}

export interface ExecutionAdapter {
  readonly id: string;
  supports(profile: ExecutionProfile): boolean;
  isAvailable(request: ExecutionRequest): Promise<boolean>;
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
}

export class ExecutionAdapterRegistry {
  constructor(private readonly adapters: ExecutionAdapter[] = []) {}

  async resolve(request: ExecutionRequest): Promise<ExecutionAdapter | null> {
    for (const adapter of this.adapters) {
      if (adapter.supports(request.profile) && await adapter.isAvailable(request)) return adapter;
    }
    return null;
  }
}

export function startHeartbeat(
  callback: AdapterProgressCallback | undefined,
  phase: "classification" | "execution" | "review",
  label: string,
  intervalMs = 10_000,
): () => void {
  if (!callback) return () => undefined;
  const startedAt = Date.now();
  let first = true;
  const timer = setInterval(() => {
    const elapsedMs = Date.now() - startedAt;
    void Promise.resolve(callback({
      kind: "execution.heartbeat",
      phase,
      message: `${label} sigue trabajando (${Math.round(elapsedMs / 1000)} s).`,
      elapsedMs,
      durable: first,
    })).catch(() => undefined);
    first = false;
  }, intervalMs);
  return () => clearInterval(timer);
}

const lastActivityAt = new WeakMap<AdapterProgressCallback, number>();

export function reportAgentActivity(callback: AdapterProgressCallback | undefined, phase: "classification" | "execution" | "review", message: string): void {
  if (!callback) return;
  const now = Date.now();
  if (now - (lastActivityAt.get(callback) ?? 0) < 250) return;
  lastActivityAt.set(callback, now);
  void Promise.resolve(callback({ kind: "agent.activity", phase, message })).catch(() => undefined);
}

export class DeterministicExecutionAdapter implements ExecutionAdapter {
  readonly id = "deterministic-test";
  constructor(private readonly result: ExecutionResult | ((request: ExecutionRequest) => ExecutionResult | Promise<ExecutionResult>) = { outcome: "completed", summary: "Deterministic execution completed." }) {}

  supports(_profile: ExecutionProfile): boolean { return true; }
  async isAvailable(_request: ExecutionRequest): Promise<boolean> { return true; }
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    return typeof this.result === "function" ? this.result(request) : this.result;
  }
}

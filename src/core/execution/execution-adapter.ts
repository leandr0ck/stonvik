import type { ExecutionProfile, Feature } from "../domain/types.js";

export type ExecutionOutcome = "completed" | "verification_failed" | "blocked" | "needs_human" | "cancelled";

export interface ExecutionRequest {
  root: string;
  feature: Feature;
  profile: ExecutionProfile;
  runId: string;
  permissions: "repository";
  signal?: AbortSignal;
}

export interface ExecutionResult {
  outcome: ExecutionOutcome;
  summary: string;
  artifacts?: string[];
  reason?: string;
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

export class DeterministicExecutionAdapter implements ExecutionAdapter {
  readonly id = "deterministic-test";
  constructor(private readonly result: ExecutionResult | ((request: ExecutionRequest) => ExecutionResult | Promise<ExecutionResult>) = { outcome: "completed", summary: "Deterministic execution completed." }) {}

  supports(_profile: ExecutionProfile): boolean { return true; }
  async isAvailable(_request: ExecutionRequest): Promise<boolean> { return true; }
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    return typeof this.result === "function" ? this.result(request) : this.result;
  }
}

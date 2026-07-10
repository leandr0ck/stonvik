export type FeatureState = "ready" | "doing" | "review" | "blocked" | "done";

export const FEATURE_STATES: FeatureState[] = ["ready", "doing", "review", "blocked", "done"];

export interface InboxItem {
  id: string;
  source: string;
  created: string;
  status: "captured" | "promoted" | "merged" | "deferred";
  title: string;
  body?: string;
  path: string;
  featureRef?: string;
}

export interface FeatureManifest {
  schemaVersion: 1;
  id: string;
  title: string;
  created: string;
  source?: { type: string; ref: string };
  goal: string;
  acceptance: string[];
  constraints?: string[];
}

export interface FeatureArtifacts {
  spec?: string;
  ticketsDirectory?: string;
  notes?: string;
  research?: string;
}

export interface Feature {
  id: string;
  slug: string;
  state: FeatureState;
  path: string;
  manifest: FeatureManifest;
  artifacts: FeatureArtifacts;
}

export type ExecutionProfile =
  | { kind: "direct" }
  | { kind: "spec-flow"; specPath: string; ticketsPath: string; commands: { implement: string; next: string } }
  | { kind: "spec-needs-plan"; specPath: string; commands: { init: string; implement: string; next: string } };

export interface RepositoryStatus {
  inbox: Record<string, number>;
  features: Record<FeatureState, number>;
}

export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  path?: string;
}

export interface ValidationReport {
  valid: boolean;
  issues: ValidationIssue[];
}

export interface CaptureInput { text: string; source?: string }
export interface CreateFeatureInput {
  id?: string;
  slug?: string;
  title: string;
  goal: string;
  acceptance: string[];
  constraints?: string[];
  source?: { type: string; ref: string };
}

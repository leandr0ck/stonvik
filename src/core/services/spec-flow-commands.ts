export interface SpecFlowCommandHints {
  init: string;
  implement: string;
  next: string;
}

export function specFlowCommandsForSpec(specPath: string): SpecFlowCommandHints {
  return {
    init: `/spec-flow-init ${specPath}`,
    implement: `/spec-flow-implement ${specPath}`,
    next: `/spec-flow-next ${specPath}`
  };
}

import type { FeatureState } from "../domain/types.js";
export const allowedTransitions: Record<FeatureState, FeatureState[]> = {
  ready: ["doing"],
  doing: ["review", "blocked"],
  review: ["done", "doing", "blocked"],
  blocked: ["ready"],
  done: []
};
export function canTransition(from: FeatureState, to: FeatureState): boolean {
  return allowedTransitions[from].includes(to);
}

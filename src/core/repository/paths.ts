import path from "node:path";
import { FEATURE_STATES } from "../domain/types.js";
export function forgiumPaths(root: string) {
  const product = path.join(root, "product");
  const inbox = path.join(product, "inbox");
  const features = path.join(root, "features");
  return {
    root, product, inbox, features,
    runtime: path.join(root, ".forgium", "runtime"),
    featureStateDir: (state: string) => path.join(features, state),
    featureDir: (state: string, slug: string) => path.join(features, state, slug),
    requiredDirs: [inbox, path.join(features, "draft"), ...FEATURE_STATES.map((s) => path.join(features, s))]
  };
}

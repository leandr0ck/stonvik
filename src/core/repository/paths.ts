import path from "node:path";
import { FEATURE_STATES } from "../domain/types.js";
export function forgiumPaths(root: string) {
  const product = path.join(root, "product");
  const inbox = path.join(product, "inbox");
  const specs = path.join(root, "docs", "specs");
  const adrs = path.join(root, "docs", "adr");
  const features = path.join(root, "features");
  const definitions = path.join(features, "definition");
  return {
    root, product, inbox, specs, adrs, features, definitions,
    runtime: path.join(root, ".forgium", "runtime"),
    events: path.join(product, "events"),
    inboxReceipts: path.join(product, "inbox-receipts"),
    featureStateDir: (state: string) => path.join(features, state),
    featureDir: (state: string, slug: string) => path.join(features, state, slug),
    definitionDir: (slug: string) => path.join(definitions, slug),
    requiredDirs: [inbox, definitions, ...FEATURE_STATES.map((s) => path.join(features, s))]
  };
}

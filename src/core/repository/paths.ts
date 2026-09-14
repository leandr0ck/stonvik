import path from "node:path";
import { FEATURE_STATES } from "../domain/types.js";
export function stonvikPaths(root: string) {
  const product = path.join(root, "product");
  const inbox = path.join(product, "inbox");
  const inboxReview = path.join(inbox, "review");
  const features = path.join(root, "features");
  return {
    root, product, inbox, inboxReview, features,
    runtime: path.join(root, ".stonvik", "runtime"),
    claims: path.join(root, ".stonvik", "runtime", "claims"),
    events: path.join(product, "events"),
    inboxReceipts: path.join(product, "inbox-receipts"),
    featureStateDir: (state: string) => path.join(features, state),
    featureDir: (state: string, slug: string) => path.join(features, state, slug),
    requiredDirs: [inbox, ...FEATURE_STATES.map((s) => path.join(features, s))],
    createdDirs: [inbox, inboxReview, path.join(product, "inbox-receipts"), path.join(product, "events"), ...FEATURE_STATES.map((s) => path.join(features, s))],
    claimPath: (workId: string) => path.join(root, ".stonvik", "runtime", "claims", `${workId}.json`),
  };
}

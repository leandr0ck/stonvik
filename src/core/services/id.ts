import crypto from "node:crypto";
export function slugify(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "feature";
}
export function shortId(bytes = 2): string { return crypto.randomBytes(bytes).toString("hex"); }
export function timestampForFile(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
export function isoNow(): string { return new Date().toISOString(); }

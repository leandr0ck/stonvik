import fs from "node:fs/promises";
import path from "node:path";
import { StonvikRepositoryNotFoundError } from "../errors/stonvik-errors.js";
export async function findRepositoryRoot(start = process.cwd()): Promise<string> {
  let current = path.resolve(start);
  while (true) {
    try { if ((await fs.stat(path.join(current, ".git"))).isDirectory()) return current; } catch {}
    const parent = path.dirname(current);
    if (parent === current) throw new StonvikRepositoryNotFoundError();
    current = parent;
  }
}

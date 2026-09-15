import { spawnSync } from "node:child_process";

const isBunInstall = process.env.npm_config_user_agent?.startsWith("bun/") ?? false;
const command = isBunInstall ? "bun" : "npm";
const args = isBunInstall
  ? ["build", "src/cli/index.ts", "--outfile", "dist/cli/index.js", "--target=node"]
  : ["run", "build"];
const result = spawnSync(command, args, { stdio: "inherit" });

if (result.error) {
  console.error(`Unable to run ${command}: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);

#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import { FilesystemForgiumRepository, ForgiumError, findRepositoryRoot, type FeatureState } from "../core/index.js";

interface GlobalOptions { root?: string; json?: boolean }

const program = new Command();
program
  .name("forgium")
  .description("Repository-native workflow engine for software development agents")
  .version("0.1.0")
  .option("--root <path>", "repository root override")
  .option("--json", "emit JSON output");

program.command("init")
  .description("Initialize Forgium structures in the repository")
  .action(async () => {
    const repo = await repoForCommand(true);
    await repo.init();
    output({ initialized: true, root: repo.root }, `Initialized Forgium in ${repo.root}`);
  });

program.command("capture")
  .description("Capture a raw Inbox item")
  .argument("[text...]", "capture text")
  .option("--source <source>", "producer source", "cli")
  .action(async (parts: string[], opts: { source: string }) => {
    const repo = await repoForCommand();
    const argText = parts.join(" ").trim();
    const stdin = process.stdin.isTTY ? "" : await readStdin();
    const text = argText || stdin.trim();
    const item = await repo.capture({ text, source: opts.source });
    output(item, `Captured ${item.id}\n${relative(repo.root, item.path)}`);
  });

program.command("inbox")
  .description("List Inbox items")
  .action(async () => {
    const repo = await repoForCommand();
    const items = await repo.listInbox();
    output(items, items.length ? items.map((i) => `${i.id}\t${i.status}\t${i.created}\t${i.title}`).join("\n") : "Inbox is empty");
  });

program.command("status")
  .description("Show repository workflow status")
  .action(async () => {
    const repo = await repoForCommand();
    const status = await repo.getStatus();
    output(status, renderStatus(status));
  });

program.command("validate")
  .description("Validate Forgium repository structures and schemas")
  .action(async () => {
    const repo = await repoForCommand(true);
    const report = await repo.validate();
    output(report, report.valid ? "Forgium repository is valid" : report.issues.map((i) => `${i.severity.toUpperCase()} ${i.code}: ${i.message}`).join("\n"));
    if (!report.valid) process.exitCode = 2;
  });

const feature = program.command("feature").description("Feature lifecycle utilities");
feature.command("create")
  .description("Create a ready Feature manifest")
  .requiredOption("--title <title>", "Feature title")
  .requiredOption("--goal <goal>", "Feature goal")
  .requiredOption("--acceptance <criteria...>", "Acceptance criteria; repeat values after the flag")
  .option("--constraint <constraints...>", "Constraints")
  .option("--slug <slug>", "Feature slug")
  .action(async (opts: { title: string; goal: string; acceptance: string[]; constraint?: string[]; slug?: string }) => {
    const repo = await repoForCommand();
    const created = await repo.createFeature({ title: opts.title, goal: opts.goal, acceptance: opts.acceptance, constraints: opts.constraint, slug: opts.slug });
    output(created, `Created ${created.id}\n${relative(repo.root, created.path)}`);
  });
feature.command("list")
  .description("List Features")
  .option("--state <state>", "state filter")
  .action(async (opts: { state?: FeatureState }) => {
    const repo = await repoForCommand();
    const features = await repo.listFeatures(opts.state);
    output(features, features.length ? features.map((f) => `${f.id}\t${f.state}\t${f.manifest.created}\t${f.manifest.title}`).join("\n") : "No Features found");
  });
feature.command("start <id>").action(async (id: string) => transition(id, "startFeature", "Started"));
feature.command("submit <id>").description("Move doing → review").action(async (id: string) => transition(id, "submitForReview", "Submitted for review"));
feature.command("complete <id>").description("Move review → done").action(async (id: string) => transition(id, "completeFeature", "Completed"));
feature.command("block <id>").requiredOption("--reason <reason>").description("Move doing/review → blocked").action(async (id: string, opts: { reason: string }) => {
  const repo = await repoForCommand();
  const result = await repo.blockFeature(id, opts.reason);
  output(result, `Blocked ${result.id}\n${relative(repo.root, result.path)}`);
});
feature.command("unblock <id>").description("Move blocked → ready").action(async (id: string) => transition(id, "unblockFeature", "Unblocked"));
feature.command("profile <id>").description("Inspect Feature execution profile").action(async (id: string) => {
  const repo = await repoForCommand();
  const profile = await repo.inspectExecutionMode(id);
  output(profile, JSON.stringify(profile, null, 2));
});

program.command("work")
  .description("Select the next ready Feature and prepare it for execution")
  .action(async () => {
    const repo = await repoForCommand();
    const next = await repo.getNextReady();
    if (!next) return output({ status: "idle" }, "No ready Features");
    const doing = await repo.startFeature(next.id);
    const profile = await repo.inspectExecutionMode(doing.id);
    output({ status: "started", feature: doing, profile }, `Started ${doing.id}\nProfile: ${profile.kind}${renderProfileHint(profile)}`);
  });

program.command("review")
  .description("Mark a review Feature done, or send it back to doing/blocked")
  .argument("<id>")
  .option("--fail", "send review back to doing")
  .option("--block <reason>", "block the Feature")
  .action(async (id: string, opts: { fail?: boolean; block?: string }) => {
    const repo = await repoForCommand();
    const result = opts.block ? await repo.blockFeature(id, opts.block) : opts.fail ? await repo.returnToDoing(id) : await repo.completeFeature(id);
    output(result, `${opts.block ? "Blocked" : opts.fail ? "Returned to doing" : "Completed"} ${result.id}`);
  });

program.parseAsync(process.argv).catch((error) => {
  if (error instanceof ForgiumError) {
    const json = program.opts<GlobalOptions>().json;
    if (json) console.error(JSON.stringify({ error: { code: error.code, message: error.message } }, null, 2));
    else console.error(`${error.code}: ${error.message}`);
    process.exit(error.exitCode);
  }
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});

async function repoForCommand(allowMissing = false): Promise<FilesystemForgiumRepository> {
  const opts = program.opts<GlobalOptions>();
  const root = opts.root ? path.resolve(opts.root) : allowMissing ? await findRepositoryRoot(process.cwd()).catch(() => process.cwd()) : await findRepositoryRoot();
  return new FilesystemForgiumRepository(root);
}

async function transition(id: string, method: "startFeature" | "submitForReview" | "completeFeature" | "unblockFeature", label: string) {
  const repo = await repoForCommand();
  const result = await repo[method](id);
  output(result, `${label} ${result.id}\n${relative(repo.root, result.path)}`);
}

function output(data: unknown, human: string): void { if (program.opts<GlobalOptions>().json) console.log(JSON.stringify(data, null, 2)); else console.log(human); }
function relative(root: string, p: string): string { return path.relative(root, p) || "."; }
function renderStatus(status: Awaited<ReturnType<FilesystemForgiumRepository["getStatus"]>>): string {
  return `Inbox\n  captured: ${status.inbox.captured ?? 0}\n  promoted: ${status.inbox.promoted ?? 0}\n  merged: ${status.inbox.merged ?? 0}\n  deferred: ${status.inbox.deferred ?? 0}\n\nFeatures\n  ready: ${status.features.ready}\n  doing: ${status.features.doing}\n  review: ${status.features.review}\n  blocked: ${status.features.blocked}\n  done: ${status.features.done}`;
}
function renderProfileHint(profile: Awaited<ReturnType<FilesystemForgiumRepository["inspectExecutionMode"]>>): string {
  if (profile.kind === "direct") return "\nDirect execution should be handled by the Forgium/Pi runtime.";
  if (profile.kind === "spec-needs-plan") return `\nPlan tickets with: ${profile.commands.init}\nThen implement with: ${profile.commands.implement}`;
  return `\nContinue spec-flow with: ${profile.commands.implement}\nNext ticket: ${profile.commands.next}`;
}
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

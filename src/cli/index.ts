#!/usr/bin/env node
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { Command } from "commander";
import { EditorUnavailableError, FilesystemForgiumRepository, ForgiumError, InvalidDraftError, RunOptionsInvalidError, findRepositoryRoot, type Draft, type FeatureState } from "../core/index.js";

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
    const repo = await repoForCommand();
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
    const text = argText || (process.stdin.isTTY ? "" : (await readStdin()).trim());
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

program.command("triage")
  .description("Resolve Drafts and triage captured Inbox items")
  .option("--non-interactive", "never prompt or approve captured Inbox items")
  .option("--edit", "open each Draft in the configured editor")
  .option("--dry-run", "show the next action without writing")
  .action(async (opts: { nonInteractive?: boolean; edit?: boolean; dryRun?: boolean }) => {
    const repo = await repoForCommand();
    const result = await triage(repo, opts);
    output(result, renderTriage(result));
  });

program.command("run")
  .description("Run the bounded repository workflow loop")
  .option("--max-features <n>", "maximum number of Features", (value: string) => value)
  .option("--until-empty", "continue until no eligible work remains")
  .option("--non-interactive", "never prompt or approve captured Inbox items")
  .option("--edit", "open each Draft in the configured editor")
  .option("--dry-run", "show planned actions without writing")
  .action(async (opts: { maxFeatures?: string; untilEmpty?: boolean; nonInteractive?: boolean; edit?: boolean; dryRun?: boolean }) => {
    const repo = await repoForCommand();
    let interrupted = false;
    const onInterrupt = () => { interrupted = true; };
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);
    try {
      const result = await runLoop(repo, opts, () => interrupted);
      output(result, renderRun(result));
    } finally {
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onInterrupt);
    }
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
    const repo = await repoForCommand();
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
feature.command("verify <id>").description("Run configured verification checks").action(async (id: string) => {
  const repo = await repoForCommand();
  const receipt = await repo.verifyFeature(id);
  output(receipt, `Verification ${receipt.outcome}\nReceipt ${receipt.id}`);
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
    const result = opts.block
      ? await repo.reviewFeature(id, "blocked", opts.block)
      : opts.fail
        ? await repo.reviewFeature(id, "changes_requested", "Review requested changes.")
        : await repo.reviewFeature(id, "approved", "Review approved via Forgium CLI.");
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

async function repoForCommand(): Promise<FilesystemForgiumRepository> {
  const opts = program.opts<GlobalOptions>();
  const root = opts.root ? path.resolve(opts.root) : await findRepositoryRoot(process.cwd()).catch(() => process.cwd());
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
  return `Inbox\n  captured: ${status.inbox.captured ?? 0}\n  drafted: ${status.inbox.drafted ?? 0}\n  promoted: ${status.inbox.promoted ?? 0}\n  merged: ${status.inbox.merged ?? 0}\n  deferred: ${status.inbox.deferred ?? 0}\n\nDrafts\n  total: ${status.drafts}\n\nFeatures\n  ready: ${status.features.ready}\n  doing: ${status.features.doing}\n  review: ${status.features.review}\n  blocked: ${status.features.blocked}\n  done: ${status.features.done}`;
}

interface TriageOptions { nonInteractive?: boolean; edit?: boolean; dryRun?: boolean }
interface TriageAction { kind: "draft" | "inbox"; id: string; action: string }
interface TriageResult { root: string; actions: TriageAction[]; stopReason: string }
interface RunOptions { maxFeatures?: string; untilEmpty?: boolean; nonInteractive?: boolean; edit?: boolean; dryRun?: boolean }
interface RunFeature { id: string; state: FeatureState; action: string }
interface RunResult { root: string; actions: TriageAction[]; features: RunFeature[]; stopReason: string }

async function triage(repo: FilesystemForgiumRepository, options: TriageOptions): Promise<TriageResult> {
  const result: TriageResult = { root: repo.root, actions: [], stopReason: "no_actionable_work" };
  const drafts = await repo.listDrafts();
  const inbox = await repo.listInbox();

  for (const draft of drafts) {
    if (options.dryRun) {
      result.actions.push({ kind: "draft", id: draft.id, action: "needs_input" });
      result.stopReason = "dry_run";
      continue;
    }
    if (options.nonInteractive) {
      try {
        await repo.promoteDraft(draft.id);
        result.actions.push({ kind: "draft", id: draft.id, action: "promoted" });
      } catch (error) {
        if (!(error instanceof InvalidDraftError)) throw error;
        result.actions.push({ kind: "draft", id: draft.id, action: "needs_input" });
        result.stopReason = "human_input_required";
      }
      continue;
    }

    let autoEdit = options.edit === true;
    let resolved = false;
    while (!resolved) {
      if (autoEdit) {
        await openEditor(draft);
        result.actions.push({ kind: "draft", id: draft.id, action: "edited" });
        autoEdit = false;
        continue;
      }
      const action = await ask(`Draft ${draft.id}: [e]ditar [p]romover [s]altar [q]salir `);
      if (action === "e") {
        await openEditor(draft);
        result.actions.push({ kind: "draft", id: draft.id, action: "edited" });
      } else if (action === "p") {
        try {
          await repo.promoteDraft(draft.id);
          result.actions.push({ kind: "draft", id: draft.id, action: "promoted" });
          resolved = true;
        } catch (error) {
          if (!(error instanceof InvalidDraftError)) throw error;
          result.actions.push({ kind: "draft", id: draft.id, action: "needs_input" });
          resolved = true;
        }
      } else if (action === "q") {
        result.stopReason = "user_quit";
        return result;
      } else {
        result.actions.push({ kind: "draft", id: draft.id, action: "skipped" });
        resolved = true;
      }
    }
  }

  for (const item of inbox.filter((candidate) => candidate.status === "captured")) {
    if (options.dryRun) {
      result.actions.push({ kind: "inbox", id: item.id, action: "needs_approval" });
      result.stopReason = "dry_run";
      continue;
    }
    if (options.nonInteractive) {
      result.actions.push({ kind: "inbox", id: item.id, action: "needs_approval" });
      result.stopReason = "human_input_required";
      continue;
    }

    const action = await ask(`Inbox ${item.id} (${item.title}): [a]probar [d]iferir [m]ezclar [s]altar [q]salir `);
    if (action === "a") {
      const draft = await repo.createDraftFromInbox(item.id);
      result.actions.push({ kind: "inbox", id: item.id, action: "drafted" });
      if (options.edit) {
        await openEditor(draft);
        result.actions.push({ kind: "draft", id: draft.id, action: "edited" });
      } else if ((await ask(`Draft ${draft.id}: [e]ditar [c]ontinuar `)) === "e") {
        await openEditor(draft);
        result.actions.push({ kind: "draft", id: draft.id, action: "edited" });
      }
    } else if (action === "d") {
      await repo.deferInbox(item.id);
      result.actions.push({ kind: "inbox", id: item.id, action: "deferred" });
    } else if (action === "m") {
      const featureId = await ask("Feature destino: ");
      await repo.mergeInbox(item.id, featureId);
      result.actions.push({ kind: "inbox", id: item.id, action: `merged:${featureId}` });
    } else if (action === "q") {
      result.stopReason = "user_quit";
      return result;
    } else {
      result.actions.push({ kind: "inbox", id: item.id, action: "skipped" });
    }
  }

  if (result.stopReason === "no_actionable_work" && result.actions.some((action) => action.action === "needs_input" || action.action === "needs_approval")) {
    result.stopReason = "human_input_required";
  }
  return result;
}

async function runLoop(repo: FilesystemForgiumRepository, options: RunOptions, isInterrupted = () => false): Promise<RunResult> {
  const maxFeatures = parseRunBudget(options);
  const result: RunResult = { root: repo.root, actions: [], features: [], stopReason: "no_actionable_work" };
  const report = await repo.validate();
  if (isInterrupted()) {
    result.stopReason = "interrupted";
    return result;
  }
  if (!report.valid) {
    result.stopReason = "preflight_failed";
    return result;
  }

  const triageResult = await triage(repo, {
    nonInteractive: options.nonInteractive,
    edit: options.edit,
    dryRun: options.dryRun
  });
  result.actions.push(...triageResult.actions);
  if (isInterrupted()) {
    result.stopReason = "interrupted";
    return result;
  }
  const ready = await repo.listFeatures("ready");
  if (options.dryRun) {
    result.features.push(...ready.slice(0, maxFeatures).map((feature) => ({ id: feature.id, state: feature.state, action: "planned" })));
    result.stopReason = "dry_run";
    return result;
  }
  if (!ready.length) {
    result.stopReason = triageResult.stopReason === "human_input_required" ? "human_input_required" : triageResult.stopReason === "user_quit" ? "user_quit" : "no_actionable_work";
    return result;
  }

  const candidates = ready.slice(0, maxFeatures);
  for (const feature of candidates) {
    result.features.push({ id: feature.id, state: feature.state, action: "engine_unavailable" });
    result.stopReason = "engine_unavailable";
    break;
  }
  return result;
}

function parseRunBudget(options: RunOptions): number {
  if (options.untilEmpty && options.maxFeatures !== undefined) throw new RunOptionsInvalidError("--until-empty cannot be combined with --max-features.");
  if (options.maxFeatures === undefined) return options.untilEmpty ? Number.MAX_SAFE_INTEGER : 1;
  if (!/^[1-9]\d*$/.test(options.maxFeatures)) throw new RunOptionsInvalidError("--max-features must be a positive integer.");
  const value = Number(options.maxFeatures);
  if (!Number.isSafeInteger(value) || value < 1) throw new RunOptionsInvalidError("--max-features must be a positive integer.");
  return value;
}

async function ask(question: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await readline.question(question)).trim().toLowerCase(); }
  finally { readline.close(); }
}

async function openEditor(draft: Draft): Promise<void> {
  const configured = process.env.VISUAL ?? process.env.EDITOR;
  if (!configured) throw new EditorUnavailableError();
  const command = splitCommand(configured);
  if (!command[0]) throw new EditorUnavailableError();
  await runProcess(command[0], [...command.slice(1), path.join(draft.path, "draft.md")]);
}

function splitCommand(value: string): string[] {
  return value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) ?? [];
}

function runProcess(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Editor exited with code ${code}`)));
  });
}

function renderTriage(result: TriageResult): string {
  return `Forgium triage\n  Actions: ${result.actions.length}\n  Stop: ${result.stopReason}`;
}
function renderRun(result: RunResult): string {
  return `Forgium run\n  Actions: ${result.actions.length}\n  Features: ${result.features.length}\n  Stop: ${result.stopReason}`;
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

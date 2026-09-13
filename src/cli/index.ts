#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { AgentLoop, ExecutionAdapterRegistry, FilesystemStonvikRepository, StonvikError, SpecFlowExecutionAdapter, findRepositoryRoot, type Classification, type FeatureState, type InboxItem, type RunEvent } from "../core/index.js";

interface GlobalOptions { root?: string; json?: boolean }

const program = new Command();
program
  .name("stonvik")
  .description("Repository-native workflow engine for software development agents")
  .version("1.0.0")
  .option("--root <path>", "repository root override")
  .option("--json", "emit JSON output");

program.command("init")
  .description("Initialize Stonevik structures in the repository")
  .action(async () => {
    const repo = await repoForCommand();
    await repo.init();
    output({ initialized: true, root: repo.root }, `Initialized Stonevik in ${repo.root}`);
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

const inbox = program.command("inbox").description("List Inbox items");
inbox.action(async () => {
  const repo = await repoForCommand();
  const items = await repo.listInbox();
  output(items, items.length ? items.map((i) => `${i.id}\t${i.status}\t${i.created}\t${i.title}`).join("\n") : "Inbox is empty");
});
inbox.command("answer <inboxId> <answer...>")
  .description("Answer a pending direct clarification")
  .action(async (inboxId: string, answer: string[]) => {
    const repo = await repoForCommand();
    const item = await repo.answerInboxClarification(inboxId, answer.join(" "));
    output(item, `Recorded clarification for ${item.id}`);
  });
inbox.command("review")
  .description("List Inbox items needing human review")
  .action(async () => {
    const repo = await repoForCommand();
    const items = await repo.listReview();
    const text = items.length
      ? items.map((i) => {
        const question = i.body?.match(/\n> (.+)/g)?.map((l) => l.replace(/^> /, "")).join(" | ") ?? "";
        return `  ${i.id} (${i.status})${question ? ` — ${question}` : ""}\n    File: ${i.path}`;
      }).join("\n\n")
      : "No Inbox items in review.";
    output(items, `Inbox items needing review (${items.length})\n\n${text}`);
  });
inbox.command("confirm <inboxId>")
  .description("Confirm a definition and move the Inbox item back from review")
  .action(async (inboxId: string) => {
    const repo = await repoForCommand();
    const item = (await repo.listReview()).find((i) => i.id === inboxId);
    if (!item) throw new StonvikError(`Inbox item is not in review: ${inboxId}`, "NOT_IN_REVIEW", 2);
    if (item.status === "needs_definition") {
      const feature = await repo.confirmDefinitionForInbox(inboxId);
      output(feature, `Confirmed definition and created Work ${feature.id}`);
    } else {
      const restored = await repo.moveReviewToInbox(item);
      output(restored, `Moved ${restored.id} back to inbox (captured)`);
    }
  });
inbox.command("restore <inboxId>")
  .description("Move an Inbox item from review back to the inbox without changes")
  .action(async (inboxId: string) => {
    const repo = await repoForCommand();
    const item = (await repo.listReview()).find((i) => i.id === inboxId);
    if (!item) throw new StonvikError(`Inbox item is not in review: ${inboxId}`, "NOT_IN_REVIEW", 2);
    const restored = await repo.moveReviewToInbox(item);
    output(restored, `Moved ${restored.id} back to inbox (captured)`);
  });

const migrate = program.command("migrate").description("Migrate durable Stonevik state to the current layout");
migrate.command("inbox-provenance")
  .description("Move legacy promoted Inbox items and classification receipts into their Work")
  .action(async () => {
    const repo = await repoForCommand();
    const result = await repo.migrateInboxProvenance();
    output(result, `Migrated Inbox provenance: ${result.migrated.length}${result.skipped.length ? `\nSkipped: ${result.skipped.map((item) => `${item.inboxId} (${item.reason})`).join(", ")}` : ""}`);
  });

program.command("triage")
  .description("Classify captured Inbox items into executable Work")
  .option("--non-interactive", "never prompt or approve captured Inbox items")
  .option("--dry-run", "show the next action without writing")
  .action(async (opts: { nonInteractive?: boolean; dryRun?: boolean }) => {
    const repo = await repoForCommand();
    const result = await triage(repo, opts);
    output(result, renderTriage(result));
  });

const definition = program.command("definition").description("Edit and inspect human Work definitions");
definition.command("edit <inboxId>")
  .description("Open the pending Inbox definition in the configured editor")
  .action(async (inboxId: string) => {
    const repo = await repoForCommand();
    const item = (await repo.listInbox()).find((candidate) => candidate.id === inboxId);
    if (!item || (item.status !== "needs_definition" && item.status !== "needs_review") || !item.definitionRef) throw new StonvikError(`Inbox item has no pending definition: ${inboxId}`, "DEFINITION_NOT_PENDING", 2);
    const editor = process.env.EDITOR ?? process.env.VISUAL;
    if (!editor) throw new StonvikError("Set VISUAL or EDITOR before editing a definition.", "EDITOR_NOT_CONFIGURED", 2);
    execFileSync(editor, [path.resolve(repo.root, item.definitionRef)], { cwd: repo.root, stdio: "inherit" });
    output({ inboxId: item.id, definitionRef: item.definitionRef }, `Edited ${item.definitionRef}`);
  });

program.command("run")
  .description("Run the autonomous product, implementation, verification, and review loop")
  .option("--non-interactive", "never prompt or approve captured Inbox items")
  .option("--dry-run", "show planned actions without writing")
  .option("--watch", "wait for durable changes and resume the loop")
  .option("--progress <mode>", "progress output: auto, off, plain, or ndjson", "auto")
  .action(async (opts: { nonInteractive?: boolean; dryRun?: boolean; watch?: boolean; progress: ProgressMode }) => {
    const requestedProgress = parseProgressMode(opts.progress);
    const progress: ProgressMode = opts.watch && requestedProgress === "auto" && program.opts<GlobalOptions>().json ? "ndjson" : requestedProgress;
    if (progress === "ndjson" && !program.opts<GlobalOptions>().json) throw new StonvikError("--progress ndjson requires --json.", "PROGRESS_NDJSON_REQUIRES_JSON", 2);
    const repo = await repoForCommand();
    let interrupted = false;
    const controller = new AbortController();
    const onInterrupt = () => { interrupted = true; controller.abort(); };
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);
    try {
      if (opts.watch) await watchLoop(repo, { ...opts, progress, signal: controller.signal }, () => interrupted);
      else {
        const result = await runLoop(repo, { ...opts, progress, signal: controller.signal }, () => interrupted);
        const status = await repo.getStatus();
        const includeEvents = result.stopReason !== "idle" && progress !== "off" && progress !== "plain" && !(progress === "auto" && Boolean(process.stdout.isTTY));
        if (progress !== "ndjson") output({ ...result, status }, renderRun(result, status, includeEvents));
      }
    } finally {
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onInterrupt);
    }
  });

program.command("status")
  .description("Show repository workflow status")
  .option("--verbose", "include implementation observations")
  .action(async (opts: { verbose?: boolean }) => {
    const repo = await repoForCommand();
    const status = await repo.getStatus();
    const implementations = opts.verbose
      ? await Promise.all((await repo.listFeatures()).filter((feature) => feature.state === "doing" || feature.state === "review").map(async (feature) => {
        const receipts = await repo.listReceipts(feature.id);
        const execution = [...receipts].reverse().find((receipt) => receipt.kind === "execution");
        const handoff = [...receipts].reverse().find((receipt) => receipt.kind === "handoff");
        return {
          id: feature.id,
          state: feature.state,
          observation: execution?.kind === "execution" ? execution.details?.specFlow : undefined,
          nextAction: feature.state === "review" ? "Review the completed Work." : handoff?.kind === "handoff" ? handoff.reason : "Observe implementation again.",
        };
      }))
      : undefined;
    const data = implementations ? { ...status, implementations } : status;
    output(data, renderStatus(status, implementations));
  });

program.command("validate")
  .description("Validate Stonevik repository structures and schemas")
  .action(async () => {
    const repo = await repoForCommand();
    const report = await repo.validate();
    output(report, report.valid ? "Stonevik repository is valid" : report.issues.map((i) => `${i.severity.toUpperCase()} ${i.code}: ${i.message}`).join("\n"));
    if (!report.valid) process.exitCode = 2;
  });

const work = program.command("work").description("Product Work utilities");
work.command("create")
  .description("Create a ready Work manifest")
  .requiredOption("--title <title>", "Feature title")
  .requiredOption("--goal <goal>", "Feature goal")
  .requiredOption("--acceptance <criteria...>", "Acceptance criteria; repeat values after the flag")
  .option("--constraint <constraints...>", "Constraints")
  .option("--slug <slug>", "Feature slug")
  .option("--verify-command <command>", "Verification command; repeat for multiple commands", collectOption, [])
  .option("--manual-evidence <criterion:kind>", "Manual evidence requirement; repeat for multiple entries", collectOption, [])
  .action(async (opts: { title: string; goal: string; acceptance: string[]; constraint?: string[]; slug?: string; verifyCommand: string[]; manualEvidence: string[] }) => {
    const repo = await repoForCommand();
    const verification = buildVerification(opts.verifyCommand, opts.manualEvidence);
    const input = { title: opts.title, goal: opts.goal, acceptance: opts.acceptance, constraints: opts.constraint, slug: opts.slug, verification };
    const created = await repo.createFeature(input);
    output(created, `Created ${created.id}\n${relative(repo.root, created.path)}`);
  });
work.command("list")
  .description("List Work")
  .option("--state <state>", "state filter")
  .action(async (opts: { state?: FeatureState }) => {
    const repo = await repoForCommand();
    const features = await repo.listFeatures(opts.state);
    output(features, features.length ? features.map((f) => `${f.id}\t${f.state}\t${f.manifest.created}\t${f.manifest.title}`).join("\n") : "No Work found");
  });

program.command("implement [id]")
  .description("Start or observe a spec-driven implementation without controlling its internal ticket flow")
  .option("--engine <engine>", "implementation engine", "pi-spec-flow")
  .action(async (id: string | undefined, opts: { engine: string }) => {
    if (opts.engine !== "pi-spec-flow") throw new StonvikError(`Unsupported implementation engine: ${opts.engine}`, "IMPLEMENT_ENGINE_INVALID", 2);
    const repo = await repoForCommand();
    const active = await repo.listFeatures("doing");
    if (!id && active.length > 1) throw new StonvikError("Multiple Work items are in progress. Pass an explicit Work ID.", "IMPLEMENT_SELECTION_REQUIRED", 2);
    const feature = id ? await repo.getFeature(id) : active[0] ?? await repo.getNextReady();
    if (!feature) return output({ status: "idle" }, "No Work is ready or in progress");
    const result = await repo.executeFeature(feature.id, new ExecutionAdapterRegistry([new SpecFlowExecutionAdapter()]));
    output(
      { outcome: result.outcome, summary: result.summary, details: result.details, feature: result.feature },
      `Implementation ${result.feature.id}\n  State: ${result.feature.state}\n  Outcome: ${result.outcome}\n  ${result.summary}`,
    );
  });

program.command("review")
  .description("List Inbox items needing human review (alias for inbox review)")
  .action(async () => {
    const repo = await repoForCommand();
    const items = await repo.listReview();
    const text = items.length
      ? items.map((i) => {
        const question = i.body?.match(/\n> (.+)/g)?.map((l) => l.replace(/^> /, "")).join(" | ") ?? "";
        return `  ${i.id} (${i.status})${question ? ` — ${question}` : ""}\n    File: ${i.path}`;
      }).join("\n\n")
      : "No Inbox items in review.";
    output(items, `Inbox items needing review (${items.length})\n\n${text}`);
  });

program.command("work-review <id>")
  .description("Record an explicit implementation review decision")
  .option("--fail", "send Work back to doing")
  .option("--block <reason>", "block Work with a reason")
  .action(async (id: string, opts: { fail?: boolean; block?: string }) => {
    const repo = await repoForCommand();
    const result = opts.block
      ? await repo.reviewFeature(id, "blocked", opts.block)
      : opts.fail
        ? await repo.reviewFeature(id, "changes_requested", "Review requested changes.")
        : await repo.reviewFeature(id, "approved", "Review approved via Stonevik CLI.");
    output(result, `${opts.block ? "Blocked" : opts.fail ? "Returned to doing" : "Completed"} ${result.id}`);
  });

program.parseAsync(process.argv).catch((error) => {
  if (error instanceof StonvikError) {
    const json = program.opts<GlobalOptions>().json;
    if (json) console.error(JSON.stringify({ error: { code: error.code, message: error.message } }, null, 2));
    else console.error(`${error.code}: ${error.message}`);
    process.exit(error.exitCode);
  }
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});

async function repoForCommand(): Promise<FilesystemStonvikRepository> {
  const opts = program.opts<GlobalOptions>();
  const root = opts.root ? path.resolve(opts.root) : await findRepositoryRoot(process.cwd()).catch(() => process.cwd());
  return new FilesystemStonvikRepository(root);
}

function output(data: unknown, human: string): void { if (program.opts<GlobalOptions>().json) console.log(JSON.stringify(data, null, 2)); else console.log(human); }
function relative(root: string, p: string): string { return path.relative(root, p) || "."; }

function parseProgressMode(value: string | undefined): ProgressMode {
  if (value === "auto" || value === "off" || value === "plain" || value === "ndjson") return value;
  throw new StonvikError(`Invalid progress mode: ${value}. Use auto, off, plain, or ndjson.`, "PROGRESS_MODE_INVALID", 2);
}

function renderProgress(event: RunEvent, mode: ProgressMode): void {
  // RPC activity is intentionally available to structured consumers, but is
  // too noisy for the human terminal. Lifecycle events and heartbeats provide
  // the useful progress signal without mirroring agent chatter.
  if (mode !== "ndjson" && event.kind === "agent.activity") return;
  if (mode === "ndjson") {
    console.log(JSON.stringify(event));
    return;
  }
  const target = program.opts<GlobalOptions>().json ? process.stderr : process.stdout;
  const subject = event.workId ?? event.inboxId;
  target.write(`[${event.phase ?? event.type}]${subject ? ` ${subject}` : ""} — ${event.message}\n`);
  if (event.nextAction) target.write(`  Next: ${event.nextAction}\n`);
}
function renderStatus(status: Awaited<ReturnType<FilesystemStonvikRepository["getStatus"]>>, implementations?: Array<{ id: string; state: FeatureState; observation?: unknown; nextAction: string }>): string {
  const details = implementations?.length ? `\n\nImplementation\n${implementations.map((item) => `  ${item.id}: ${item.state} — ${item.nextAction}`).join("\n")}` : "";
  return `Inbox\n  captured: ${status.inbox.captured ?? 0}\n  needs clarification: ${status.inbox.needs_clarification ?? 0}\n  needs definition: ${status.inbox.needs_definition ?? 0}\n  in review: ${status.inbox.needs_review ?? 0}\n  promoted: ${status.inbox.promoted ?? 0}\n  merged: ${status.inbox.merged ?? 0}\n  deferred: ${status.inbox.deferred ?? 0}\n  rejected: ${status.inbox.rejected ?? 0}\n\nWork\n  ready: ${status.features.ready}\n  doing: ${status.features.doing}\n  review: ${status.features.review}\n  blocked: ${status.features.blocked}\n  done: ${status.features.done}${details}`;
}

interface TriageOptions { nonInteractive?: boolean; dryRun?: boolean }
interface TriageAction { kind: "inbox"; id: string; action: string; definitionRef?: string; definitionKind?: "spec" | "adr" }
interface TriageResult { root: string; actions: TriageAction[]; stopReason: string }
type ProgressMode = "auto" | "off" | "plain" | "ndjson";
interface RunOptions { nonInteractive?: boolean; dryRun?: boolean; watch?: boolean; progress?: ProgressMode; signal?: AbortSignal }
interface RunFeature { id: string; state: FeatureState; action: string }
interface RunResult { root: string; actions: TriageAction[]; features: RunFeature[]; inboxReview: number; stopReason: string; nextAction?: string; events?: RunEvent[] }

async function triage(repo: FilesystemStonvikRepository, options: TriageOptions): Promise<TriageResult> {
  const result: TriageResult = { root: repo.root, actions: [], stopReason: "no_actionable_work" };
  const inbox = await repo.listInbox();
  const prompt = createPromptSession();

  try {
    for (const item of inbox.filter((candidate) => candidate.status === "needs_definition")) {
      if (options.dryRun) {
        result.actions.push({ kind: "inbox", id: item.id, action: "needs_definition_confirmation", definitionRef: item.definitionRef, definitionKind: item.definitionKind });
        result.stopReason = "dry_run";
        continue;
      }
      if (options.nonInteractive) {
        result.actions.push({ kind: "inbox", id: item.id, action: "needs_definition_confirmation", definitionRef: item.definitionRef, definitionKind: item.definitionKind });
        result.stopReason = "human_definition_required";
        continue;
      }
      const action = await prompt.ask(`${item.definitionKind?.toUpperCase()} ${item.definitionRef}: [c]onfirmar Work [s]altar [q]salir `, true);
      if (action === "c") {
        const work = await repo.confirmDefinitionForInbox(item.id);
        result.actions.push({ kind: "inbox", id: item.id, action: `definition_confirmed:${work.id}` });
      } else if (action === "q") {
        result.stopReason = "user_quit";
        return result;
      } else {
        result.actions.push({ kind: "inbox", id: item.id, action: "needs_definition_confirmation", definitionRef: item.definitionRef, definitionKind: item.definitionKind });
        result.stopReason = "human_definition_required";
      }
    }

    for (const item of inbox.filter((candidate) => candidate.status === "captured")) {
      if (options.dryRun) {
        result.actions.push({ kind: "inbox", id: item.id, action: "needs_classification" });
        result.stopReason = "dry_run";
        continue;
      }
      if (options.nonInteractive) {
        result.actions.push({ kind: "inbox", id: item.id, action: "needs_classification" });
        result.stopReason = "human_input_required";
        continue;
      }

      const action = await prompt.ask(`Inbox ${item.id} (${item.title}): create [w]ork [s]pec [a]dr [d]efer [r]eject [m]erge [q]uit `, true);
      if (action === "s" || action === "a") {
        const definitionKind = action === "s" ? "spec" : "adr";
        const needsDefinition = await repo.requireDefinitionForInbox(item.id, definitionKind, !process.env.STONVIK_PI_COMMAND);
        result.actions.push({ kind: "inbox", id: item.id, action: "needs_definition", definitionRef: needsDefinition.definitionRef, definitionKind });
      } else if (action === "w" || action === "t") {
        const definition = await defineWork(prompt.ask);
        if (!definition) {
          result.actions.push({ kind: "inbox", id: item.id, action: "needs_input" });
          result.stopReason = "human_input_required";
          return result;
        }
        const work = await repo.createFeatureFromInbox(item.id, { title: item.title, ...definition });
        result.actions.push({ kind: "inbox", id: item.id, action: `created:${work.id}` });
      } else if (action === "d") {
        await repo.deferInbox(item.id);
        result.actions.push({ kind: "inbox", id: item.id, action: "deferred" });
      } else if (action === "r") {
        await repo.rejectInbox(item.id);
        result.actions.push({ kind: "inbox", id: item.id, action: "rejected" });
      } else if (action === "m") {
        const featureId = await prompt.ask("Feature destino: ");
        await repo.mergeInbox(item.id, featureId);
        result.actions.push({ kind: "inbox", id: item.id, action: `merged:${featureId}` });
      } else if (action === "q") {
        result.stopReason = "user_quit";
        return result;
      } else {
        result.actions.push({ kind: "inbox", id: item.id, action: "skipped" });
      }
    }
  } finally {
    prompt.close();
  }

  if (result.stopReason === "no_actionable_work" && result.actions.some((action) => action.action === "needs_input" || action.action === "needs_classification")) {
    result.stopReason = "human_input_required";
  }
  return result;
}

async function runLoop(repo: FilesystemStonvikRepository, options: RunOptions, isInterrupted = () => false): Promise<RunResult> {
  // Without a configured agent, preserve a safe human-only recovery pass. The
  // autonomous path is selected as soon as STONVIK_PI_COMMAND is configured;
  // no unstructured local process is treated as a state authority.
  const loop = new AgentLoop(repo);
  const events: RunEvent[] = [];
  const progress = options.progress ?? "auto";
  const stream = progress === "plain" || progress === "ndjson" || (progress === "auto" && Boolean(process.stdout.isTTY));
  const result = await loop.run({
    dryRun: options.dryRun,
    nonInteractive: options.nonInteractive,
    signal: options.signal ?? (isInterrupted() ? AbortSignal.abort() : undefined),
    onEvent: (event) => {
      events.push(event);
      if (stream) renderProgress(event, progress);
    },
  });
  return {
    root: result.root,
    actions: result.actions.map((action) => ({ kind: "inbox" as const, id: action.id, action: action.action, definitionRef: action.definitionRef, definitionKind: action.definitionKind })),
    features: result.features,
    inboxReview: result.inboxReview,
    stopReason: result.stopReason,
    nextAction: result.nextAction,
    events,
  };
}

async function watchLoop(repo: FilesystemStonvikRepository, options: RunOptions, interrupted: () => boolean): Promise<void> {
  let fingerprint = await durableFingerprint(repo.root);
  const run = async () => {
    const events = [] as unknown[];
    const loop = new AgentLoop(repo);
    const progress = options.progress ?? (program.opts<GlobalOptions>().json ? "ndjson" : "plain");
    const stream = progress !== "off";
    const result = await loop.run({
      dryRun: options.dryRun,
      nonInteractive: options.nonInteractive,
      signal: options.signal,
      onEvent: async (event) => { events.push(event); if (stream) renderProgress(event, progress); },
    });
    const status = await repo.getStatus();
    const includeEvents = result.stopReason !== "idle" && !stream && progress !== "off";
    if (progress !== "ndjson") console.log(renderRun({ root: result.root, actions: result.actions.map((a) => ({ kind: "inbox", id: a.id, action: a.action, definitionRef: a.definitionRef, definitionKind: a.definitionKind })), features: result.features, inboxReview: result.inboxReview, stopReason: result.stopReason, nextAction: result.nextAction }, status, includeEvents));
  };
  await run();
  fingerprint = await durableFingerprint(repo.root);
  while (!interrupted()) {
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      let settled = false;
      let poll: NodeJS.Timeout;
      let stop: NodeJS.Timeout;
      const finishIfChanged = async () => {
        if (settled) return;
        const next = await durableFingerprint(repo.root);
        if (next === fingerprint) return;
        settled = true;
        clearInterval(poll); clearInterval(stop); watcher.close(); resolve();
      };
      const watcher = fs.watch(repo.root, { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => { void finishIfChanged(); }, 150);
      });
      poll = setInterval(() => { void finishIfChanged(); }, 500);
      stop = setInterval(() => { if (interrupted() && !settled) { settled = true; clearInterval(poll); clearInterval(stop); watcher.close(); resolve(); } }, 250);
    });
    if (interrupted()) break;
    const next = await durableFingerprint(repo.root);
    if (next === fingerprint) continue;
    await run();
    fingerprint = await durableFingerprint(repo.root);
  }
}

async function durableFingerprint(root: string): Promise<string> {
  const parts: string[] = [];
  const walk = (directory: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".stonvik") continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else { try { const stat = fs.statSync(full); parts.push(`${path.relative(root, full)}:${stat.size}:${stat.mtimeMs}`); } catch { /* raced with writer */ } }
    }
  };
  walk(root);
  return parts.join("|");
}

function createPromptSession(): { ask: (question: string, normalize?: boolean) => Promise<string>; close: () => void } {
  const output = program.opts<GlobalOptions>().json ? process.stderr : process.stdout;
  const readline = createInterface({ input: process.stdin, output });
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let closed = false;
  readline.on("line", (line: string) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else lines.push(line);
  });
  readline.on("close", () => {
    closed = true;
    while (waiters.length) waiters.shift()!("");
  });
  return {
    ask: async (question, normalize = false) => {
      output.write(question);
      const line = lines.shift() ?? (closed ? "" : await new Promise<string>((resolve) => waiters.push(resolve)));
      const answer = line.trim();
      return normalize ? answer.toLowerCase() : answer;
    },
    close: () => readline.close(),
  };
}

async function defineWork(prompt: (question: string, normalize?: boolean) => Promise<string>): Promise<{ goal: string; acceptance: string[]; verification: { commands: Array<{ name: string; run: string }>; requiredEvidence?: Array<{ criterion: string; kind: string }> } } | null> {
  const goal = await prompt("Objetivo de implementación: ");
  if (!goal) return null;
  const acceptance: string[] = [];
  while (true) {
    const criterion = await prompt("Criterio de aceptación (vacío para terminar): ");
    if (!criterion) break;
    acceptance.push(criterion);
  }
  if (!acceptance.length) return null;
  const commands: Array<{ name: string; run: string }> = [];
  while (true) {
    const command = await prompt("Comando de verificación (vacío para terminar): ");
    if (!command) break;
    commands.push({ name: `command-${commands.length + 1}`, run: command });
  }
  const manualEvidence: string[] = [];
  while (true) {
    const evidence = await prompt("Evidencia manual (criterio:tipo, vacío para terminar): ");
    if (!evidence) break;
    manualEvidence.push(evidence);
  }
  try {
    return { goal, acceptance, verification: buildVerification(commands.map((command) => command.run), manualEvidence) };
  } catch {
    return null;
  }
}

function collectOption(value: string, previous: string[]): string[] { return [...previous, value]; }

function buildVerification(commands: string[], manualEvidence: string[]) {
  const requiredEvidence = manualEvidence.map((value) => {
    const delimiter = value.lastIndexOf(":");
    if (delimiter <= 0 || delimiter === value.length - 1) throw new StonvikError("Manual evidence must use criterion:kind.", "VERIFICATION_INVALID", 2);
    return { criterion: value.slice(0, delimiter).trim(), kind: value.slice(delimiter + 1).trim() };
  });
  if (!commands.length && !requiredEvidence.length) throw new StonvikError("Work requires a verification command or manual evidence.", "VERIFICATION_REQUIRED", 2);
  return {
    commands: commands.map((run, index) => ({ name: `command-${index + 1}`, run })),
    requiredEvidence: requiredEvidence.length ? requiredEvidence : undefined,
  };
}

function renderTriage(result: TriageResult): string {
  return `Stonevik triage\n  Actions: ${result.actions.length}${renderSpecActions(result.actions)}\n  Stop: ${result.stopReason}`;
}
function renderRun(result: RunResult, status: Awaited<ReturnType<FilesystemStonvikRepository["getStatus"]>>, includeEvents = true): string {
  const inboxNeedingAttention = (status.inbox.captured ?? 0) + (status.inbox.needs_clarification ?? 0) + (status.inbox.needs_definition ?? 0) + (status.inbox.needs_review ?? 0);
  const workNeedingAttention = status.features.ready + status.features.doing + status.features.review + status.features.blocked;
  const noActionRequired = inboxNeedingAttention === 0 && workNeedingAttention === 0;
  const reviewCount = result.inboxReview ?? 0;
  const events = includeEvents && result.events?.length ? `\n\nEvents\n${result.events.map((event) => `  [${event.type}] ${event.message}${event.nextAction ? `\n    Next: ${event.nextAction}` : ""}`).join("\n")}` : "";
  return `Stonevik status after run\n\nInbox\n  captured: ${status.inbox.captured ?? 0}\n  awaiting clarification: ${status.inbox.needs_clarification ?? 0}\n  awaiting definition: ${status.inbox.needs_definition ?? 0}\n  in review: ${status.inbox.needs_review ?? 0}\n\nWork requiring attention\n  ready: ${status.features.ready}\n  doing: ${status.features.doing}\n  review: ${status.features.review}\n  blocked: ${status.features.blocked}${reviewCount > 0 ? `\n\nInbox review: ${reviewCount} item(s) need attention — run \`stonvik review\` to see them.` : ""}${noActionRequired && reviewCount === 0 ? "\n\n  No action required." : ""}${result.nextAction ? `\n\nNext: ${result.nextAction}` : ""}${events}`;
}
function renderSpecActions(actions: TriageAction[]): string {
  const definitions = actions.filter((action) => action.definitionRef).map((action) => `${action.definitionKind}: ${action.definitionRef}`);
  return definitions.length ? `\n  Definition required: ${definitions.join(", ")}` : "";
}
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

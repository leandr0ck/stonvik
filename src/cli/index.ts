#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { AgentLoop, ExecutionAdapterRegistry, FilesystemForgiumRepository, ForgiumError, SpecFlowExecutionAdapter, findRepositoryRoot, type Classification, type FeatureState, type InboxItem, type RunEvent } from "../core/index.js";

interface GlobalOptions { root?: string; json?: boolean }

const program = new Command();
program
  .name("forgium")
  .description("Repository-native workflow engine for software development agents")
  .version("1.0.0")
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
  .description("Classify captured Inbox items into executable Work")
  .option("--non-interactive", "never prompt or approve captured Inbox items")
  .option("--dry-run", "show the next action without writing")
  .action(async (opts: { nonInteractive?: boolean; dryRun?: boolean }) => {
    const repo = await repoForCommand();
    const result = await triage(repo, opts);
    output(result, renderTriage(result));
  });

program.command("run")
  .description("Run the autonomous product, implementation, verification, and review loop")
  .option("--non-interactive", "never prompt or approve captured Inbox items")
  .option("--dry-run", "show planned actions without writing")
  .option("--watch", "wait for durable changes and resume the loop")
  .action(async (opts: { nonInteractive?: boolean; dryRun?: boolean; watch?: boolean }) => {
    const repo = await repoForCommand();
    let interrupted = false;
    const controller = new AbortController();
    const onInterrupt = () => { interrupted = true; controller.abort(); };
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);
    try {
      if (opts.watch) await watchLoop(repo, { ...opts, signal: controller.signal }, () => interrupted);
      else {
        const result = await runLoop(repo, { ...opts, signal: controller.signal }, () => interrupted);
        output(result, renderRun(result));
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
  .description("Validate Forgium repository structures and schemas")
  .action(async () => {
    const repo = await repoForCommand();
    const report = await repo.validate();
    output(report, report.valid ? "Forgium repository is valid" : report.issues.map((i) => `${i.severity.toUpperCase()} ${i.code}: ${i.message}`).join("\n"));
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
    if (opts.engine !== "pi-spec-flow") throw new ForgiumError(`Unsupported implementation engine: ${opts.engine}`, "IMPLEMENT_ENGINE_INVALID", 2);
    const repo = await repoForCommand();
    const active = await repo.listFeatures("doing");
    if (!id && active.length > 1) throw new ForgiumError("Multiple Work items are in progress. Pass an explicit Work ID.", "IMPLEMENT_SELECTION_REQUIRED", 2);
    const feature = id ? await repo.getFeature(id) : active[0] ?? await repo.getNextReady();
    if (!feature) return output({ status: "idle" }, "No Work is ready or in progress");
    const result = await repo.executeFeature(feature.id, new ExecutionAdapterRegistry([new SpecFlowExecutionAdapter()]));
    output(
      { outcome: result.outcome, summary: result.summary, details: result.details, feature: result.feature },
      `Implementation ${result.feature.id}\n  State: ${result.feature.state}\n  Outcome: ${result.outcome}\n  ${result.summary}`,
    );
  });

program.command("review <id>")
  .description("Record an explicit implementation review decision")
  .option("--fail", "send Work back to doing")
  .option("--block <reason>", "block Work with a reason")
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

function output(data: unknown, human: string): void { if (program.opts<GlobalOptions>().json) console.log(JSON.stringify(data, null, 2)); else console.log(human); }
function relative(root: string, p: string): string { return path.relative(root, p) || "."; }
function renderStatus(status: Awaited<ReturnType<FilesystemForgiumRepository["getStatus"]>>, implementations?: Array<{ id: string; state: FeatureState; observation?: unknown; nextAction: string }>): string {
  const details = implementations?.length ? `\n\nImplementation\n${implementations.map((item) => `  ${item.id}: ${item.state} — ${item.nextAction}`).join("\n")}` : "";
  return `Inbox\n  captured: ${status.inbox.captured ?? 0}\n  needs definition: ${status.inbox.needs_definition ?? 0}\n  promoted: ${status.inbox.promoted ?? 0}\n  merged: ${status.inbox.merged ?? 0}\n  deferred: ${status.inbox.deferred ?? 0}\n  rejected: ${status.inbox.rejected ?? 0}\n\nWork\n  ready: ${status.features.ready}\n  doing: ${status.features.doing}\n  review: ${status.features.review}\n  blocked: ${status.features.blocked}\n  done: ${status.features.done}${details}`;
}

interface TriageOptions { nonInteractive?: boolean; dryRun?: boolean }
interface TriageAction { kind: "inbox"; id: string; action: string; definitionRef?: string; definitionKind?: "spec" | "adr" }
interface TriageResult { root: string; actions: TriageAction[]; stopReason: string }
interface RunOptions { nonInteractive?: boolean; dryRun?: boolean; watch?: boolean; signal?: AbortSignal }
interface RunFeature { id: string; state: FeatureState; action: string }
interface RunResult { root: string; actions: TriageAction[]; features: RunFeature[]; stopReason: string; nextAction?: string; events?: RunEvent[] }

async function triage(repo: FilesystemForgiumRepository, options: TriageOptions): Promise<TriageResult> {
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

      const action = await prompt.ask(`Inbox ${item.id} (${item.title}): [t]icket [s]pec requerida [a]dr requerida [d]iferir [r]echazar [m]ezclar [q]salir `, true);
      if (action === "s" || action === "a") {
        const definitionKind = action === "s" ? "spec" : "adr";
        const needsDefinition = await repo.requireDefinitionForInbox(item.id, definitionKind, !process.env.FORGIUM_PI_COMMAND);
        result.actions.push({ kind: "inbox", id: item.id, action: "needs_definition", definitionRef: needsDefinition.definitionRef, definitionKind });
      } else if (action === "t") {
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

async function runLoop(repo: FilesystemForgiumRepository, options: RunOptions, isInterrupted = () => false): Promise<RunResult> {
  // Without a configured agent, preserve a safe human-only recovery pass. The
  // autonomous path is selected as soon as FORGIUM_PI_COMMAND is configured;
  // no unstructured local process is treated as a state authority.
  if (!process.env.FORGIUM_PI_COMMAND && !process.stdin.isTTY) {
    const triageResult = await triage(repo, { nonInteractive: options.nonInteractive, dryRun: options.dryRun });
    const ready = await repo.listFeatures("ready");
    return {
      root: repo.root,
      actions: triageResult.actions,
      features: ready.map((feature) => ({ id: feature.id, state: feature.state, action: "ready_for_implementation" })),
      stopReason: options.dryRun ? "dry_run" : triageResult.actions.some((action) => action.action === "needs_definition" || action.action === "needs_definition_confirmation") ? "human_definition_required" : triageResult.stopReason === "no_actionable_work" && ready.length ? "ready_for_implementation" : triageResult.stopReason,
    };
  }
  const prompt = createPromptSession();
  try {
    const loop = new AgentLoop(repo);
    const events: RunEvent[] = [];
    const result = await loop.run({
      dryRun: options.dryRun,
      nonInteractive: options.nonInteractive,
      signal: options.signal ?? (isInterrupted() ? AbortSignal.abort() : undefined),
      chooseClassification: async (item, classification) => chooseClassification(prompt, item, classification),
      confirmDefinition: async (item) => (await prompt.ask(`Definición ${item.definitionRef}: [c]onfirmar [s]altar [q]salir `, true)) === "c",
      onEvent: (event) => { events.push(event); },
    });
    return {
      root: result.root,
      actions: result.actions.map((action) => ({ kind: "inbox" as const, id: action.id, action: action.action, definitionRef: action.nextAction })),
      features: result.features,
      stopReason: result.stopReason,
      nextAction: result.nextAction,
      events,
    };
  } finally { prompt.close(); }
}

async function chooseClassification(prompt: ReturnType<typeof createPromptSession>, item: InboxItem, classification: Classification): Promise<"direct" | "spec" | "adr" | "split" | "defer" | "reject" | "quit"> {
  const risks = classification.risks.length ? classification.risks.join(", ") : "sin riesgos";
  const answer = await prompt.ask(`Inbox ${item.id}: ${classification.route}/${classification.size}, ${risks}. ${classification.rationale.join(" ")} [d]irect [s]pec [a]dr [p]artir [f]iferir [r]echazar [q]salir `, true);
  return answer === "d" ? "direct" : answer === "s" ? "spec" : answer === "a" ? "adr" : answer === "p" ? "split" : answer === "f" ? "defer" : answer === "r" ? "reject" : "quit";
}

async function watchLoop(repo: FilesystemForgiumRepository, options: RunOptions, interrupted: () => boolean): Promise<void> {
  let fingerprint = await durableFingerprint(repo.root);
  const run = async () => {
    const events = [] as unknown[];
    const loop = new AgentLoop(repo);
    const prompt = createPromptSession();
    try {
      const result = await loop.run({
        dryRun: options.dryRun,
        nonInteractive: options.nonInteractive,
        chooseClassification: async (item, classification) => chooseClassification(prompt, item, classification),
        confirmDefinition: async (item) => (await prompt.ask(`Definición ${item.definitionRef}: [c]onfirmar [s]altar [q]salir `, true)) === "c",
        signal: options.signal,
        onEvent: async (event) => { events.push(event); if (program.opts<GlobalOptions>().json) console.log(JSON.stringify(event)); else console.log(`[${event.type}] ${event.message}${event.nextAction ? ` Next: ${event.nextAction}` : ""}`); },
      });
      if (program.opts<GlobalOptions>().json) console.log(JSON.stringify({ type: "stop", at: new Date().toISOString(), message: `Loop stopped: ${result.stopReason}.`, stopReason: result.stopReason, nextAction: result.nextAction }));
      else console.log(renderRun({ root: result.root, actions: result.actions.map((a) => ({ kind: "inbox", id: a.id, action: a.action })), features: result.features, stopReason: result.stopReason, nextAction: result.nextAction }));
    } finally { prompt.close(); }
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
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".forgium") continue;
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
    if (delimiter <= 0 || delimiter === value.length - 1) throw new ForgiumError("Manual evidence must use criterion:kind.", "VERIFICATION_INVALID", 2);
    return { criterion: value.slice(0, delimiter).trim(), kind: value.slice(delimiter + 1).trim() };
  });
  if (!commands.length && !requiredEvidence.length) throw new ForgiumError("Work requires a verification command or manual evidence.", "VERIFICATION_REQUIRED", 2);
  return {
    commands: commands.map((run, index) => ({ name: `command-${index + 1}`, run })),
    requiredEvidence: requiredEvidence.length ? requiredEvidence : undefined,
  };
}

function renderTriage(result: TriageResult): string {
  return `Forgium triage\n  Actions: ${result.actions.length}${renderSpecActions(result.actions)}\n  Stop: ${result.stopReason}`;
}
function renderRun(result: RunResult): string {
  const events = result.events?.length ? `\n\nEvents\n${result.events.map((event) => `  [${event.type}] ${event.message}${event.nextAction ? ` — Next: ${event.nextAction}` : ""}`).join("\n")}` : "";
  return `Forgium run\n  Actions: ${result.actions.length}\n  Features: ${result.features.length}${renderSpecActions(result.actions)}\n  Stop: ${result.stopReason}${result.nextAction ? `\n  Next: ${result.nextAction}` : ""}${events}`;
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

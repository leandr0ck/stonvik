#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import YAML from "yaml";
import { Command } from "commander";
import { FilesystemStonvikRepository, StonvikError, actorFromInput, findRepositoryRoot, renderWorkHandoffMarkdown, type ActorRef, type ActorRole, type DefinitionRef, type ExternalExecutionReport, type Feature, type FeatureState, type InboxItem, type RoutingDecision } from "../core/index.js";

interface GlobalOptions { root?: string; json?: boolean }

const program = new Command();
program
  .name("stonvik")
  .description("Repository-native workflow engine for software development")
  .version("1.0.0")
  .option("--root <path>", "repository root override")
  .option("--json", "emit JSON output")
  .showSuggestionAfterError();

program.command("init")
  .description("Initialize Stonvik workflow structures")
  .action(async () => {
    const repo = await repoForCommand();
    await repo.init();
    output({ initialized: true, root: repo.root }, `Initialized Stonvik in ${repo.root}`);
  });

program.command("capture")
  .description("Capture raw user intent in the Inbox")
  .argument("[text...]", "capture text")
  .option("--source <source>", "producer source", "cli")
  .action(async (parts: string[], opts: { source: string }) => {
    const repo = await repoForCommand();
    const argText = parts.join(" ").trim();
    const text = argText || (process.stdin.isTTY ? "" : (await readStdin()).trim());
    const item = await repo.capture({ text, source: opts.source });
    output(item, `Captured ${item.id}\n${relative(repo.root, item.path)}`);
  });

const inbox = program.command("inbox")
  .description("List Inbox items")
  .action(listInboxCommand);
inbox.command("list").description("List Inbox items").action(listInboxCommand);
inbox.command("show <inboxId>")
  .description("Read one captured intent")
  .action(async (inboxId: string) => {
    const repo = await repoForCommand();
    const item = (await repo.listInbox()).find((candidate) => candidate.id === inboxId);
    if (!item) throw new StonvikError(`Inbox item not found: ${inboxId}`, "INBOX_NOT_FOUND", 3);
    output(item, renderInboxItem(repo.root, item));
  });
inbox.command("answer <inboxId> <answer...>")
  .description("Answer a pending triage clarification")
  .action(async (inboxId: string, answer: string[]) => {
    const repo = await repoForCommand();
    const item = await repo.answerInboxClarification(inboxId, answer.join(" "));
    output(item, `Recorded clarification for ${item.id}`);
  });
inbox.command("review")
  .description("List Inbox items requiring human attention")
  .action(async () => {
    const repo = await repoForCommand();
    const items = await repo.listReview();
    output(items, items.length ? items.map((item) => renderInboxItem(repo.root, item)).join("\n\n") : "No Inbox items in review.");
  });
inbox.command("restore <inboxId>")
  .description("Return an Inbox item from review to captured")
  .action(async (inboxId: string) => {
    const repo = await repoForCommand();
    const item = (await repo.listReview()).find((candidate) => candidate.id === inboxId);
    if (!item) throw new StonvikError(`Inbox item is not in review: ${inboxId}`, "NOT_IN_REVIEW", 2);
    const restored = await repo.moveReviewToInbox(item);
    output(restored, `Restored ${restored.id} to captured Inbox`);
  });

program.command("triage")
  .description("Record the route for one captured Inbox item")
  .argument("<inboxId>", "Inbox item ID")
  .requiredOption("--route <route>", "direct, spec, or adr")
  .option("--actor <actor>", "triager actor (type:name)")
  .option("--role <role>", "actor role; defaults to triager")
  .option("--size <size>", "size signal")
  .option("--touched-files <count>", "estimated touched-file count", parseInteger)
  .option("--risk <risk>", "routing risk; repeatable", collectOption, [])
  .option("--rationale <text>", "routing rationale; repeatable", collectOption, [])
  .action(async (inboxId: string, opts: { route: string; actor?: string; role?: string; size?: string; touchedFiles?: number; risk: string[]; rationale: string[] }) => {
    if (opts.route !== "direct" && opts.route !== "spec" && opts.route !== "adr") throw new StonvikError(`Invalid triage route: ${opts.route}`, "TRIAGE_ROUTE_INVALID", 2);
    const repo = await repoForCommand();
    const item = await repo.triageInbox(inboxId, {
      route: opts.route as RoutingDecision["route"],
      actor: commandActor(opts.actor, parseActorRole(opts.role, "triager")),
      signals: {
        ...(opts.size ? { size: parseWorkSize(opts.size) } : {}),
        ...(opts.touchedFiles !== undefined ? { estimatedTouchedFiles: opts.touchedFiles } : {}),
        ...(opts.risk.length ? { risks: opts.risk } : {}),
        ...(opts.rationale.length ? { rationale: opts.rationale } : {}),
      },
    });
    const next = item.routingDecision?.route === "direct"
      ? `Define the Work with \`stonvik define ${item.id}\`.`
      : `Create your ${item.routingDecision?.route?.toUpperCase()} document, then run \`stonvik define ${item.id}\`.`;
    output(item, `Triaged ${item.id} as ${item.routingDecision?.route}.\nNext: ${next}`);
  });

program.command("define")
  .description("Create ready Work from an Inbox item and user-owned definitions")
  .argument("<inboxId>", "Inbox item ID")
  .requiredOption("--goal <goal>", "Work goal")
  .requiredOption("--acceptance <criteria...>", "acceptance criteria")
  .option("--title <title>", "Work title; defaults to the Inbox title")
  .option("--slug <slug>", "Work slug")
  .option("--constraint <constraint>", "constraint; repeatable", collectOption, [])
  .option("--spec <path>", "user-owned spec path; repeatable", collectOption, [])
  .option("--adr <path>", "user-owned ADR path; repeatable", collectOption, [])
  .option("--verify-command <command>", "verification command; repeatable", collectOption, [])
  .option("--manual-evidence <criterion:kind>", "manual evidence requirement; repeatable", collectOption, [])
  .action(async (inboxId: string, opts: { title?: string; goal: string; acceptance: string[]; slug?: string; constraint: string[]; spec: string[]; adr: string[]; verifyCommand: string[]; manualEvidence: string[] }) => {
    const repo = await repoForCommand();
    const inboxItem = (await repo.listInbox()).find((item) => item.id === inboxId);
    if (!inboxItem) throw new StonvikError(`Inbox item not found: ${inboxId}`, "INBOX_NOT_FOUND", 3);
    const definitions = definitionsFromOptions(opts.spec, opts.adr);
    const feature = await repo.defineWorkFromInbox(inboxId, {
      title: opts.title?.trim() || inboxItem.title,
      slug: opts.slug,
      goal: opts.goal,
      acceptance: opts.acceptance,
      constraints: opts.constraint.length ? opts.constraint : undefined,
      definitions: definitions.length ? definitions : undefined,
      verification: buildVerification(opts.verifyCommand, opts.manualEvidence),
    });
    output(feature, `Defined ${feature.id} in ${feature.state}.\n${relative(repo.root, feature.path)}`);
  });

program.command("next")
  .description("Select the oldest ready Work without claiming it")
  .action(async () => {
    const repo = await repoForCommand();
    const feature = await repo.getNextReady();
    output(feature, feature ? `${feature.id}\t${feature.state}\t${feature.manifest.title}` : "No ready Work.");
  });

program.command("verify <id>")
  .description("Run the declared verification checks")
  .action(async (id: string) => {
    const repo = await repoForCommand();
    const receipt = await repo.verifyWork(id);
    output(receipt, `Verification ${receipt.outcome} for ${id}`);
  });

program.command("ship <id>")
  .description("Ship Work after verification and independent approval")
  .action(async (id: string) => {
    const repo = await repoForCommand();
    const feature = await repo.shipWork(id);
    output(feature, `Shipped ${feature.id}; state: ${feature.state}`);
  });

program.command("status")
  .description("Show workflow status")
  .action(async () => {
    const repo = await repoForCommand();
    const status = await repo.getStatus();
    output(status, renderStatus(status));
  });

program.command("validate")
  .description("Validate workflow structures and schemas")
  .action(async () => {
    const repo = await repoForCommand();
    const report = await repo.validate();
    output(report, report.valid ? "Stonvik repository is valid" : report.issues.map((issue) => `${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}`).join("\n"));
    if (!report.valid) process.exitCode = 2;
  });

const work = program.command("work").description("Inspect and operate Work");
work.command("create")
  .description("Create ready Work directly")
  .requiredOption("--title <title>", "Work title")
  .requiredOption("--goal <goal>", "Work goal")
  .requiredOption("--acceptance <criteria...>", "acceptance criteria")
  .option("--constraint <constraint>", "constraint; repeatable", collectOption, [])
  .option("--slug <slug>", "Work slug")
  .option("--spec <path>", "user-owned spec path; repeatable", collectOption, [])
  .option("--adr <path>", "user-owned ADR path; repeatable", collectOption, [])
  .option("--verify-command <command>", "verification command; repeatable", collectOption, [])
  .option("--manual-evidence <criterion:kind>", "manual evidence requirement; repeatable", collectOption, [])
  .action(async (opts: { title: string; goal: string; acceptance: string[]; constraint: string[]; slug?: string; spec: string[]; adr: string[]; verifyCommand: string[]; manualEvidence: string[] }) => {
    const repo = await repoForCommand();
    const feature = await repo.createFeature({
      title: opts.title,
      goal: opts.goal,
      acceptance: opts.acceptance,
      constraints: opts.constraint.length ? opts.constraint : undefined,
      slug: opts.slug,
      definitions: definitionsFromOptions(opts.spec, opts.adr),
      verification: buildVerification(opts.verifyCommand, opts.manualEvidence),
    });
    output(feature, `Created ${feature.id}\n${relative(repo.root, feature.path)}`);
  });
work.command("show <id>")
  .description("Read one Work and its workflow contract")
  .action(async (id: string) => {
    const repo = await repoForCommand();
    const feature = await repo.getFeature(id);
    if (!feature) throw new StonvikError(`Work not found: ${id}`, "FEATURE_NOT_FOUND", 3);
    output(feature, renderWork(repo.root, feature));
  });
work.command("list")
  .description("List Work")
  .option("--state <state>", "state filter")
  .action(async (opts: { state?: FeatureState }) => {
    const repo = await repoForCommand();
    const features = await repo.listFeatures(opts.state);
    output(features, features.length ? features.map((feature) => `${feature.id}\t${feature.state}\t${feature.manifest.created}\t${feature.manifest.title}`).join("\n") : "No Work found");
  });
work.command("start <id>")
  .description("Claim ready Work for implementation")
  .option("--actor <actor>", "implementer actor (type:name)")
  .option("--run-id <runId>", "execution run ID")
  .action(async (id: string, opts: { actor?: string; runId?: string }) => {
    const repo = await repoForCommand();
    const feature = await repo.startWork(id, commandActor(opts.actor, "implementer"), opts.runId);
    output(feature, `Started ${feature.id} as ${feature.state}`);
  });
work.command("report <id>")
  .description("Import the structured implementation result")
  .requiredOption("--receipt <path>", "JSON or YAML execution report")
  .option("--run-id <runId>", "execution run ID")
  .action(async (id: string, opts: { receipt: string; runId?: string }) => {
    const repo = await repoForCommand();
    const reportPath = resolveRepositoryPath(repo.root, opts.receipt, "WORK_REPORT_INVALID");
    let report: ExternalExecutionReport;
    try {
      const raw = fs.readFileSync(reportPath, "utf8");
      try { report = JSON.parse(raw) as ExternalExecutionReport; } catch { report = YAML.parse(raw) as ExternalExecutionReport; }
    } catch (error) {
      throw new StonvikError(`Could not read execution report: ${String((error as Error).message)}`, "WORK_REPORT_INVALID", 2);
    }
    const result = await repo.recordExternalExecutionReport(id, report, { runId: opts.runId });
    output(result, `Recorded execution for ${id} (${report.outcome}).\nNext: ${result.nextAction}`);
  });
work.command("review <id>")
  .description("Record an independent review decision")
  .requiredOption("--decision <decision>", "approved, changes_requested, blocked, or needs_human")
  .option("--actor <actor>", "reviewer actor (type:name)")
  .option("--summary <summary>", "review summary", "Review decision recorded.")
  .option("--finding <finding>", "review finding; repeatable", collectOption, [])
  .action(async (id: string, opts: { actor?: string; decision: string; summary: string; finding: string[] }) => {
    if (!["approved", "changes_requested", "blocked", "needs_human"].includes(opts.decision)) throw new StonvikError(`Invalid review decision: ${opts.decision}`, "REVIEW_DECISION_INVALID", 2);
    const repo = await repoForCommand();
    const feature = await repo.reviewWork(id, commandActor(opts.actor, "reviewer"), opts.decision as "approved" | "changes_requested" | "blocked" | "needs_human", opts.summary, opts.finding);
    const next = feature.state === "review" && opts.decision === "approved" ? `Run \`stonvik ship ${feature.id}\`.` : `Work is now ${feature.state}.`;
    output(feature, `Reviewed ${feature.id}; state: ${feature.state}.\n${next}`);
  });
work.command("claim <id>")
  .description("Inspect the ephemeral implementation claim")
  .action(async (id: string) => {
    const repo = await repoForCommand();
    const claim = await repo.getWorkClaim(id);
    output(claim, claim ? `Claimed by ${claim.actor.type}:${claim.actor.name} (pid ${claim.pid})` : "No active claim.");
  });
work.command("recover <id>")
  .description("Recover Work after an actor process disappeared")
  .option("--actor <actor>", "implementer actor (type:name)")
  .option("--run-id <runId>", "recovery run ID")
  .action(async (id: string, opts: { actor?: string; runId?: string }) => {
    const repo = await repoForCommand();
    const feature = await repo.recoverWork(id, commandActor(opts.actor, "implementer"), opts.runId);
    output(feature, `Recovered ${feature.id} as ${feature.state}`);
  });
work.command("unblock <id>")
  .description("Return blocked Work to ready")
  .action(async (id: string) => {
    const repo = await repoForCommand();
    const feature = await repo.unblockFeature(id);
    output(feature, `Unblocked ${feature.id}; state: ${feature.state}`);
  });
work.command("handoff <id>")
  .description("Generate a neutral implementation handoff")
  .option("--format <format>", "json or markdown", "json")
  .action(async (id: string, opts: { format: string }) => {
    if (opts.format !== "json" && opts.format !== "markdown") throw new StonvikError(`Invalid handoff format: ${opts.format}`, "HANDOFF_FORMAT_INVALID", 2);
    const repo = await repoForCommand();
    const handoff = await repo.createWorkHandoff(id);
    output(handoff, opts.format === "markdown" ? renderWorkHandoffMarkdown(handoff) : JSON.stringify(handoff, null, 2));
  });

program.parseAsync(process.argv).catch((error) => {
  if (error instanceof StonvikError) {
    if (program.opts<GlobalOptions>().json) console.error(JSON.stringify({ error: { code: error.code, message: error.message } }, null, 2));
    else console.error(`${error.code}: ${error.message}`);
    process.exit(error.exitCode);
  }
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});

async function listInboxCommand(): Promise<void> {
  const repo = await repoForCommand();
  const items = await repo.listInbox();
  output(items, items.length ? items.map((item) => `${item.id}\t${item.status}\t${item.created}\t${item.title}`).join("\n") : "Inbox is empty");
}

async function repoForCommand(): Promise<FilesystemStonvikRepository> {
  const opts = program.opts<GlobalOptions>();
  const root = opts.root ? path.resolve(opts.root) : await findRepositoryRoot(process.cwd()).catch(() => process.cwd());
  return new FilesystemStonvikRepository(root);
}

function output(data: unknown, human: string): void {
  if (program.opts<GlobalOptions>().json) console.log(JSON.stringify(data, null, 2));
  else console.log(human);
}

function relative(root: string, value: string): string { return path.relative(root, value) || "."; }

function renderInboxItem(root: string, item: InboxItem): string {
  return [
    `${item.id} (${item.status})`,
    `Title: ${item.title}`,
    `Source: ${item.source}`,
    `Created: ${item.created}`,
    `File: ${relative(root, item.path)}`,
    item.body ? `\n${item.body}` : "",
    item.routingDecision ? `\nTriage: ${item.routingDecision.route}` : "",
  ].join("\n");
}

function renderWork(root: string, feature: Feature): string {
  const manifest = feature.manifest;
  const definitions = manifest.definitions?.map((definition) => `- ${definition.kind}: ${definition.path}`).join("\n") || "- None";
  return [
    `${feature.id} (${feature.state})`,
    `Title: ${manifest.title}`,
    `Goal: ${manifest.goal}`,
    `File: ${relative(root, feature.path)}`,
    "\nAcceptance:",
    ...manifest.acceptance.map((criterion) => `- ${criterion}`),
    "\nDefinitions:",
    definitions,
  ].join("\n");
}

function renderStatus(status: Awaited<ReturnType<FilesystemStonvikRepository["getStatus"]>>): string {
  return [
    "Inbox",
    `  captured: ${status.inbox.captured ?? 0}`,
    `  needs clarification: ${status.inbox.needs_clarification ?? 0}`,
    `  needs definition: ${status.inbox.needs_definition ?? 0}`,
    `  in review: ${status.inbox.needs_review ?? 0}`,
    "",
    "Work",
    `  ready: ${status.features.ready}`,
    `  doing: ${status.features.doing}`,
    `  review: ${status.features.review}`,
    `  blocked: ${status.features.blocked}`,
    `  done: ${status.features.done}`,
  ].join("\n");
}

function definitionsFromOptions(specs: string[], adrs: string[]): DefinitionRef[] {
  return [
    ...specs.map((value) => ({ kind: "spec" as const, path: value })),
    ...adrs.map((value) => ({ kind: "adr" as const, path: value })),
  ];
}

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

function collectOption(value: string, previous: string[]): string[] { return [...previous, value]; }

function commandActor(value: string | undefined, role: ActorRole): ActorRef {
  try { return actorFromInput(value, role, process.env.STONVIK_ACTOR); }
  catch (error) { throw new StonvikError(String((error as Error).message ?? error), "ACTOR_INVALID", 2); }
}

function parseActorRole(value: string | undefined, fallback: ActorRole): ActorRole {
  const role = value ?? fallback;
  const roles: ActorRole[] = ["triager", "implementer", "specifier", "verifier", "reviewer", "product-owner"];
  if (roles.includes(role as ActorRole)) return role as ActorRole;
  throw new StonvikError(`Invalid actor role: ${role}`, "ACTOR_ROLE_INVALID", 2);
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) throw new StonvikError(`Invalid integer: ${value}`, "OPTION_INVALID", 2);
  return parsed;
}

function parseWorkSize(value: string): "XS" | "S" | "M" | "L" | "XL" {
  if (value === "XS" || value === "S" || value === "M" || value === "L" || value === "XL") return value;
  throw new StonvikError(`Invalid Work size: ${value}`, "WORK_SIZE_INVALID", 2);
}

function resolveRepositoryPath(root: string, value: string, code: string): string {
  const resolved = path.resolve(root, value);
  const relativePath = path.relative(path.resolve(root), resolved);
  if (path.isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${path.sep}`)) throw new StonvikError(`Path must stay inside the repository: ${value}`, code, 2);
  return resolved;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

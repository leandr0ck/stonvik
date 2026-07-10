# Forgium

Forgium is a repository-native workflow engine for software-development agents. It keeps a durable, reviewable queue of work in your repository: raw requests go to an Inbox, approved work becomes a Feature, and a Feature moves through execution, review, completion, or a blocker.

The repository is the source of truth. Forgium does not require a database or a hosted service.

## Requirements

- Node.js 20 or later
- A Git repository (recommended; required when Forgium needs to discover the project root automatically)

## Install

If Forgium has been published to your npm registry:

```bash
npm install --global forgium
```

To use this checkout during development:

```bash
npm install
npm run build
npm link
```

Confirm that the CLI is available:

```bash
forgium --help
```

## Quick start

Run these commands from the root of the project you want Forgium to manage:

```bash
# 1. Create the workflow directories.
forgium init

# 2. Capture an unprocessed request.
forgium capture "Add a WhatsApp contact button to the storefront"

# 3. Turn approved work into an executable Feature.
forgium feature create \
  --title "Add WhatsApp contact button" \
  --goal "Let storefront visitors contact the business on WhatsApp" \
  --acceptance "A WhatsApp button is visible on the storefront" \
               "The button opens the configured WhatsApp conversation"

# 4. Start the next ready Feature.
forgium work

# 5. After implementation, submit it for review and complete it.
forgium feature submit feature-add-whatsapp-contact-button
forgium review feature-add-whatsapp-contact-button
```

Use `forgium status` at any time to see the number of Inbox items and Features in each state.

## What Forgium creates

`forgium init` creates the following structure:

```text
product/
└── inbox/                  # Raw, untriaged requests

features/
├── ready/                  # Approved work waiting to start
├── doing/                  # Work in progress
├── review/                 # Work awaiting review
├── blocked/                # Work that cannot proceed
└── done/                   # Completed work
```

It also adds `.loop/runtime/` to `.gitignore`. Runtime leases created when work starts are local process metadata; the Inbox and Feature directories are intended to be committed to Git.

Each Feature is a directory containing at least a `manifest.yaml`. You can add supporting artifacts to that directory, such as `spec.md`, `tickets/`, `notes.md`, or `research.md`.

## Typical workflow

### 1. Capture incoming work

Capture a short request directly:

```bash
forgium capture "Add dark mode"
```

For a multi-line request, pipe text to Forgium. The first line becomes the title and the remaining text becomes the body:

```bash
printf '%s\n%s\n' \
  'Add dark mode' \
  'Respect the system preference and provide a manual toggle.' \
  | forgium capture --source feedback
```

`--source` identifies where the request came from; its default is `cli`.

List captured requests with:

```bash
forgium inbox
```

> In this version, Inbox triage and promotion are deliberate human/agent steps. `forgium capture` records raw intent; use `forgium feature create` when that intent has been approved and defined well enough to execute.

### 2. Create a Feature

A Feature must have a title, a goal, and at least one acceptance criterion:

```bash
forgium feature create \
  --title "Export invoices as CSV" \
  --goal "Allow finance users to download invoice data for reconciliation" \
  --acceptance "Users can export filtered invoices as a CSV file" \
               "The export includes invoice number, date, customer, and amount" \
  --constraint "Do not change the existing invoice API"
```

Forgium creates the Feature in `features/ready/`. Its ID is derived from the title (for example, `feature-export-invoices-as-csv`). Supply `--slug <slug>` when you need a different directory name and ID suffix:

```bash
forgium feature create \
  --slug invoice-csv-export \
  --title "Export invoices as CSV" \
  --goal "Enable invoice exports" \
  --acceptance "A CSV export can be downloaded"
```

List all Features or only one state:

```bash
forgium feature list
forgium feature list --state ready
```

### 3. Execute work

Start the oldest ready Feature explicitly:

```bash
forgium feature start feature-export-invoices-as-csv
```

Or let Forgium select and start the next ready Feature:

```bash
forgium work
```

Starting a Feature moves it from `ready` to `doing` and creates a local runtime lease. `forgium work` also prints the execution profile:

- **direct** — implement the Feature directly with your agent or normal development workflow.
- **spec-needs-plan** — a `spec.md` exists but no `tickets/` directory exists. Forgium prints the `pi-spec-flow` command to plan tickets.
- **spec-flow** — both `spec.md` and `tickets/` exist. Forgium prints the command to continue implementation with `pi-spec-flow`.

You can inspect this profile without starting work:

```bash
forgium feature profile feature-export-invoices-as-csv
```

For a Feature containing `spec.md`, the suggested Pi commands are:

```text
/spec-flow-init <path-to-spec.md>
/spec-flow-implement <path-to-spec.md>
/spec-flow-next <path-to-spec.md>
```

### 4. Review, complete, or unblock

When implementation is ready, send the Feature to review:

```bash
forgium feature submit feature-export-invoices-as-csv
```

After review, use one of the following:

```bash
# Approve and move review → done.
forgium review feature-export-invoices-as-csv

# Send review → doing for another implementation pass.
forgium review feature-export-invoices-as-csv --fail

# Record a blocker and move doing/review → blocked.
forgium feature block feature-export-invoices-as-csv \
  --reason "Awaiting approval from the finance team"

# Equivalent review-time blocker command.
forgium review feature-export-invoices-as-csv \
  --block "Awaiting approval from the finance team"

# Once resolved, move blocked → ready.
forgium feature unblock feature-export-invoices-as-csv
```

Blocking appends the reason and timestamp to the Feature's `notes.md`.

## Feature lifecycle

Forgium enforces these transitions:

```text
ready → doing → review → done
            ↘       ↙
             blocked → ready

review → doing  (review needs more work)
```

A completed Feature cannot be moved to another state through the CLI. Use Feature IDs or directory slugs with lifecycle commands; both are accepted.

## Command reference

| Command | Purpose |
| --- | --- |
| `forgium init` | Initialize the Inbox and Feature state directories. |
| `forgium capture [text...]` | Save a raw Inbox item. Reads piped standard input when no text is supplied. |
| `forgium inbox` | List Inbox items. |
| `forgium status` | Show counts by Inbox and Feature state. |
| `forgium validate` | Validate required directories and Inbox/Feature file schemas. Returns exit code `2` when invalid. |
| `forgium feature create ...` | Create a ready Feature. |
| `forgium feature list [--state <state>]` | List Features, optionally filtering by `ready`, `doing`, `review`, `blocked`, or `done`. |
| `forgium feature start <id>` | Move `ready` → `doing`. |
| `forgium feature submit <id>` | Move `doing` → `review`. |
| `forgium feature complete <id>` | Move `review` → `done`. |
| `forgium feature block <id> --reason <reason>` | Move `doing` or `review` → `blocked` and record the reason. |
| `forgium feature unblock <id>` | Move `blocked` → `ready`. |
| `forgium feature profile <id>` | Show whether a Feature is direct or `pi-spec-flow` work. |
| `forgium work` | Start the next ready Feature and show its execution profile. |
| `forgium review <id> [--fail \| --block <reason>]` | Complete a Feature in review, return it to `doing`, or block it. |

Run `forgium <command> --help` for the CLI's current argument and option details.

## Global options and automation

Pass `--root <path>` to operate on a specific project rather than the current Git repository:

```bash
forgium --root /path/to/project status
```

Pass `--json` to emit machine-readable results, which is useful for scripts and agents:

```bash
forgium --json status
forgium --json feature list --state ready
```

When Forgium reports an error in JSON mode, it writes an object with an error code and message to standard error.

## Validate before committing

Run validation after manually editing Inbox items, Feature manifests, or Feature artifacts:

```bash
forgium validate
```

Commit the resulting `product/` and `features/` changes with the work they describe, so the queue and lifecycle remain portable and auditable.

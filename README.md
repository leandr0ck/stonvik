# Forgium

Forgium is a repository-native workflow engine for software-development agents. It keeps a durable, reviewable queue of work in your repository: raw requests go to an Inbox, approved intent becomes Work, and Work moves through execution, review, completion, or a blocker.

The repository is the source of truth. Forgium does not require a database or a hosted service.

Additional architecture and implementation details are available in
[docs/](docs/README.md). Contributor instructions live in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Requirements

- Node.js 20 or later
- Git (optional; when present, Forgium uses it to discover the project root automatically)

## Install

```bash
npm install --global forgium
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

# 2. Capture raw product intent.
forgium capture "Add a WhatsApp contact button to the storefront"

# 3. Run the autonomous loop. It classifies, implements, verifies, and
#    independently reviews eligible Work.
forgium run

# 4. If Forgium asks one direct question, answer it in the terminal. In a
#    non-interactive environment, use: forgium inbox answer <inbox-id> <answer>
#    then run Forgium again. If it asks for a Spec/ADR, complete the document.
# 5. Inspect progress; Forgium never self-approves.
forgium status --verbose
```

Use `forgium status` at any time to see the number of Inbox items and Work
items in each state.

## The Loop method

Forgium is designed to run the same autonomous work loop repeatedly. The
repository is the durable queue and source of truth; each pass selects work,
delegates implementation, records evidence, and stops at an explicit gate.

```text
raw request
    │
    ▼
 Inbox ──human interview──▶ ready Work ──implement──▶ doing
    │             │                                      │
    │             └── Spec or ADR ──human confirms──┘    │
    │                                                     ▼
    │                                              verification
    │                                                     │
    │                                                     ▼
    └─────────────────────────────────────────────── review
                                                        │
                                             approve ───┴─── changes/block
                                                │                   │
                                                ▼                   ▼
                                              done            doing / blocked
```

### How one loop pass works

1. **Capture** — record raw intent in `product/inbox/`. Inbox content is not
   executable work.
2. **Product interview** — `forgium run` or `forgium triage` asks a human to
   classify the Inbox item. A simple request becomes ready Work; a complex
   request creates a human-authored Spec or ADR first.
3. **Prepare** — every ready Work has a title, goal, acceptance criteria, and
   either one or more verification commands or required manual evidence.
4. **Implement** — `forgium implement` observes `pi-spec-flow`; it does not
   control that extension's ticket lifecycle. A partial result stays `doing`.
5. **Verify** — only a complete Spec Flow observation runs the Work's
   verification policy and may move Work to `review`.
6. **Review** — an explicit human decision moves Work to `done`, back to
   `doing`, or to `blocked`.

### Loop safety rules

- `forgium run` is the normal end-to-end path; `triage`, `implement`, and
  `review` remain manual recovery APIs.
- There is no automatic approval or transition from `doing` to `done`. Forgium
  makes at most one in-memory repair attempt for an invalid classifier
  response; it never retries persisted Work execution, verification, or review.
- Each Inbox classification uses an isolated Pi session. The reusable Pi
  process starts without tools, extensions, skills, prompt templates, or
  repository context; a failed, cancelled, or unacknowledged session reset
  fails closed rather than reusing prior Inbox context.
- Work transitions move the complete directory; individual Spec Flow
  tickets remain owned by `pi-spec-flow`.
- Receipts and repository artifacts are durable; leases and process logs under
  `.forgium/runtime/` are local runtime metadata.

## What Forgium creates

`forgium init` creates the following structure:

```text
product/
├── inbox/                  # Unresolved raw product intent
├── inbox-receipts/         # Classification evidence not yet attached to Work
└── events/                 # Durable RunEvent NDJSON, partitioned by date and run

features/
├── definition/             # Human Spec/ADR definitions; never executable
├── ready/                  # Executable Work waiting for implementation
├── doing/                  # Work in progress
├── review/                 # Work awaiting review
├── blocked/                # Work that cannot proceed
└── done/                   # Completed work
```

It also adds `.forgium/runtime/` to `.gitignore`. Runtime leases created when work starts are local process metadata; the Inbox and Work directories are intended to be committed to Git. The runtime directory is created only when it is needed.

Each Work item is a directory containing at least a `manifest.yaml`. Inbox
items promoted or merged into a Work move to `provenance/inbox/`, alongside
their classification evidence in `provenance/classification/`; that evidence
then travels with the Work through `done`. You can add supporting artifacts to
it, such as `spec.md`, `tickets/`, `notes.md`, or `research.md`.

Repositories created with an earlier Forgium version can relocate their
historical Inbox evidence with `forgium migrate inbox-provenance`.

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

Use `forgium run` (or `forgium triage`) to interview and classify captured
intent. Forgium is the only command that promotes Inbox content to ready Work.

### 2. Create ready Work directly

Use this only when the Work is already defined. It must include at least one
verification command or a required piece of manual evidence:

```bash
forgium work create \
  --title "Export invoices as CSV" \
  --goal "Allow finance users to download invoice data for reconciliation" \
  --acceptance "Users can export filtered invoices as a CSV file" \
               "The export includes invoice number, date, customer, and amount" \
  --constraint "Do not change the existing invoice API" \
  --verify-command "npm test -- --runInBand"
```

Or require evidence that cannot be expressed as a command:

```bash
forgium work create \
  --title "Update the pricing page" \
  --goal "Publish approved pricing copy" \
  --acceptance "The new plan names are visible" \
  --manual-evidence "The new plan names are visible:browser-review"
```

List Work, optionally by state:

```bash
forgium work list
forgium work list --state ready
```

### 3. Implement spec-driven Work

Install the Spec Flow extension once:

```bash
pi install npm:pi-spec-flow@0.4.8
```

Work needs a `spec.md` and its Spec Flow tickets. Then invoke Forgium:

```bash
forgium implement feature-export-invoices-as-csv
```

Without an ID, `forgium implement` resumes the only Work already `doing`, or
selects the next ready Work. If more than one Work is `doing`, it refuses to
guess and requires an explicit ID. Pi/Spec Flow may pause for a checkpoint or
code review; rerun the same command after that action has occurred.

```bash
forgium status --verbose
```

`--verbose` reports the latest observed Spec Flow status and the next human
action. If Pi does not return structured status, Forgium fails closed: Work
remains `doing` with a durable handoff receipt.

Use `forgium run --watch` to keep a local process waiting for durable Inbox,
definition, manifest, ticket, or receipt changes. Run progress is sourced from
validated domain events, never raw Pi output:

```bash
forgium run --progress plain       # force compact live feedback
forgium run --progress off         # suppress live feedback
forgium run --json --progress ndjson # one validated RunEvent per line
```

`auto` is the default: it streams only to a TTY. `--json` without
`--progress ndjson` remains one final JSON object. With `--json --watch`, output
is newline-delimited JSON only and every pass ends in `run.stopped`.

### 4. Review, complete, or unblock

When implementation has completed verification and reached `review`, use one
of the following:

```bash
# Approve and move review → done.
forgium review feature-export-invoices-as-csv

# Send review → doing for another implementation pass.
forgium review feature-export-invoices-as-csv --fail

# Block review → blocked.
forgium review feature-export-invoices-as-csv \
  --block "Awaiting approval from the finance team"
```

## Work lifecycle

Forgium enforces these transitions:

```text
ready → doing → review → done
            ↘       ↙
             blocked → ready

review → doing  (review needs more work)
```

A completed Work cannot be moved to another state through the CLI.

## Command reference

| Command | Purpose |
| --- | --- |
| `forgium init` | Initialize Inbox and Work state directories. |
| `forgium capture [text...]` | Save a raw Inbox item. Reads piped standard input when no text is supplied. |
| `forgium inbox` | List Inbox items. |
| `forgium triage [--non-interactive] [--dry-run]` | Interview and classify captured Inbox items. |
| `forgium run [--watch] [--non-interactive] [--dry-run] [--progress <auto\|off\|plain\|ndjson>]` | Run the autonomous loop with validated live feedback. `ndjson` requires `--json`. |
| `forgium status [--verbose]` | Show state counts; verbose includes implementation observations. |
| `forgium validate` | Validate required directories and Inbox/Work schemas. Returns exit code `2` when invalid. |
| `forgium work create ...` | Create ready Work; verification command or manual evidence is required. |
| `forgium work list [--state <state>]` | List Work, optionally filtering by lifecycle state. |
| `forgium implement [id] [--engine pi-spec-flow]` | Start or observe Spec Flow implementation. |
| `forgium review <id> [--fail \| --block <reason>]` | Approve Work in review, return it to `doing`, or block it. |

Run `forgium <command> --help` for the CLI's current argument and option details.

## Global options and automation

Pass `--root <path>` to operate on a specific project rather than the current Git repository:

```bash
forgium --root /path/to/project status
```

Pass `--json` to emit machine-readable results, which is useful for scripts and agents:

```bash
forgium --json status
forgium --json work list --state ready
```

When Forgium reports an error in JSON mode, it writes an object with an error code and message to standard error.

## Keep workflow state portable

Run validation after manually editing Inbox items, Work manifests, or Work artifacts:

```bash
forgium validate
```

Commit the resulting `product/` and `features/` changes with the work they
describe, so the queue and lifecycle remain portable and auditable.

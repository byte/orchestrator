# Compatibility and opt-in certification

Orchestrator stays local and dependency-free. Preflight runs version/auth and
Git discovery only: no installation, model invocation, sandbox test, checkout
repair, or automatic certification. Its `certification` value is deliberately
`unknown`, even when every prerequisite passes. A detected companion is not a
verified companion version. Pending Git operations and dirty checkouts warn;
they do not make read-only tasks impossible. Git status probes disable optional
index writes, hooks, and fsmonitor.

## Small version/capability matrix

| Component | Declared baseline / implementation reference | What is known, and what is not |
| --- | --- | --- |
| Node | `>=18.18` in `package.json` | No npm dependencies required. Preflight reports the executing version; it does not certify every supported Node/OS combination. |
| Git | Linked-worktree support required; exact minimum not certified | Preflight reports the installed version and pending sequencer, merge, cherry-pick, revert, rebase, and index-lock markers. Version alone does not prove sandbox behavior. |
| `cli` executor (default) | Existing model/effort probes reference Codex CLI 0.169.0 / 0.169.1 in `runs.mjs` | Structured output schema, explicit thread resume, ignored saved approval rules, private read scratch probed at launch. A failed read-profile probe falls back to ordinary read-only: no private writable scratch guarantee. Historical model acceptance is not current account/model availability or all-platform containment evidence. |
| `codex-plugin` executor | Adapter targets public companion job commands; effort vocabulary references openai-codex 1.0.6 | Optional background task/status/result/cancel protocol. Schema is parsed from prose, not enforced by Codex; saved approval rules are not ignored; read workers lack private writable TMPDIR; warm resume uses the most recent worktree thread. Efforts above `xhigh` are stepped down. Cancel interrupts a turn but may leave an already-running command in the shared app-server until it ends. Presence/version discovery cannot upgrade these guarantees. |

No combination is automatically marked certified. Record evidence against an
exact plugin revision, Node/Git/Codex/companion versions, OS, executor, date,
account/model/effort selection, and whether fallback occurred. An untested cell
is **unknown**, not passed. Authentication and live worker artifacts are private;
do not attach raw preflight, run state, or transcripts to public issues.

## Repeatable opt-in checks

Run from the source checkout. These first commands do not invoke a model:

```sh
node plugins/orchestrator/scripts/orch.mjs preflight --json
node --test tests/preflight.test.mjs tests/storage.test.mjs
node --test tests/plugin.test.mjs tests/sandbox.test.mjs tests/checks.test.mjs tests/setup.test.mjs
# Broader regression check, when ready:
npm test
```

The automated executor tests use fake Codex/companion implementations and sandbox
shims. They establish protocol, argument construction, lifecycle, fallback, and
retention behavior, **not actual OS containment or successful live model calls**.

### Real containment, without a model (explicit opt-in)

Use the installed real Codex binary, not a fixture or shim. The following uses
the existing check executor in a disposable directory. It checks that private
scratch is writable while both the working directory and a sibling outside it
are not. It does not certify network containment, write-worker Git protection,
or the plugin executor. A nonzero result, unsupported sandbox command, fallback,
or unavailable platform is a failed/unknown capability, not a reason to weaken
the expectation.

```sh
node --input-type=module <<'JS'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeCheck } from './plugins/orchestrator/scripts/lib/checks.mjs';
const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'orch-cert-'));
const checkout = path.join(base, 'checkout');
fs.mkdirSync(checkout);
const program = `
  const fs = require('node:fs'), path = require('node:path');
  fs.writeFileSync(path.join(process.env.TMPDIR, 'allowed'), 'ok');
  for (const target of [path.join(process.cwd(), 'forbidden'), process.argv[1]]) {
    let denied = false;
    try { fs.writeFileSync(target, 'unexpected'); }
    catch (error) { denied = ['EACCES', 'EPERM', 'EROFS'].includes(error.code); }
    if (!denied) process.exit(9);
  }
`;
const receipt = executeCheck(checkout, {
  argv: [process.execPath, '-e', program, path.join(base, 'outside')], timeoutSeconds: 30
});
console.log(JSON.stringify({ passed: receipt.passed, exitCode: receipt.exitCode,
  terminationUncertain: receipt.terminationUncertain }));
if (!receipt.terminationUncertain) fs.rmSync(base, { recursive: true });
else console.error('Keep the disposable checkout until its process group is confirmed stopped.');
if (!receipt.passed) process.exitCode = 1;
JS
```

For network certification, separately establish a reachable controlled endpoint
outside the sandbox, then show the same connection fails inside the real sandbox
with networking disabled and succeeds with it explicitly enabled. Without that
positive control, a failed connection proves nothing about network containment.
Likewise test denied source, `.git`, and outside writes for the exact worker
profile before claiming those boundaries. Do not run containment probes against
valuable checkouts or secrets.

### Live-model smoke (explicit opt-in; account usage may be billed)

Use a **disposable committed Git repository**, a configured lane, and a reviewed
small plan file (`CERT_PLAN_FILE`, absolute path). Supply your own benign
`CERT_OBJECTIVE`. Include one read task and one tightly scoped write task; record
the task IDs as `READ_TASK` and `WRITE_TASK`. Keep the source CLI path in `ORCH`.
For each executor, create a separate run and repeat:

```sh
node "$ORCH" preflight --json
node "$ORCH" run create "$CERT_LANE" --id "$CERT_RUN" --executor "$CERT_EXECUTOR" --objective "$CERT_OBJECTIVE" --json
node "$ORCH" run plan "$CERT_RUN" --plan-file "$CERT_PLAN_FILE" --json
node "$ORCH" run checkpoint "$CERT_RUN" --summary 'Disposable compatibility smoke reviewed'
node "$ORCH" run launch "$CERT_RUN" "$READ_TASK" --json
node "$ORCH" run wait "$CERT_RUN" --timeout 120 --json
node "$ORCH" run poll "$CERT_RUN" --json
node "$ORCH" run launch "$CERT_RUN" "$WRITE_TASK" --json
node "$ORCH" run wait "$CERT_RUN" --timeout 120 --json
node "$ORCH" run poll "$CERT_RUN" --json
node "$ORCH" run inspect "$CERT_RUN" "$WRITE_TASK" --json
```

A wait timeout means unknown/still running, not success; poll/wait again rather
than launching a duplicate. Review the real reports, unchanged read checkout,
scoped write diff, actual model substitutions, and any sandbox fallback. Exercise
retry/resume and cancellation separately in disposable runs if certifying those
capabilities. Never infer successful cancellation of a plugin command merely
from a cancelled turn. Do not integrate or clean anything until the evidence has
been reviewed. Model success is not containment evidence, and containment success
does not establish model availability. Preflight remains `unknown`: this is a
manual, evidence-scoped certification process, not a persisted trust toggle.

## Storage and safe diagnostic metadata API

`scripts/lib/storage.mjs` exports synchronous, read-only functions returning
JSON-compatible objects (no file output, deletion, permission repair, upload, or
telemetry):

- `inventoryStorage(cwd = process.cwd())`: local advisory inventory of run
  artifact directories and saved task/retired-attempt worktrees, previews, and
  runner-owned scratch. Entries contain `kind`, an owned local `path` when safe,
  logical `bytes`, `files`, skipped `symlinks`, `complete`, and
  `cleanup: { eligible, reason }`. Shared warm-retry paths are counted once and
  any retention reason wins. Artifact directories have no existing deletion
  policy and are always retained.
- `exportDiagnosticMetadata(cwd = process.cwd())`: allowlisted aggregate only:
  schema/Node version, unknown certification, run counts grouped by fixed
  status/executor enums, and counts/sizes/retention reason codes per storage kind.
  No raw paths, run/task/attempt/thread IDs, objectives, prompts, source, log or
  transcript text, secrets, or full error messages are returned. Unknown values
  become `unknown`; parse failures become counts, never error text. Share this
  object instead of local inventory or raw preflight JSON. It still reveals
  coarse activity and storage totals; sharing remains an explicit user choice.

Only saved state, runner status JSON, and scratch owner markers are read as
metadata. Artifacts are statted, never searched for transcript content or read
from Codex's home directory. Symlink roots/ancestors are rejected and nested
links are counted without following them. Scratch requires the existing
`orch-worker-*` naming and owner-marker relationship to a status file beneath a
saved attempt; unrecorded scratch is not guessed from the temp directory.
Worktrees must be beneath this run's owned local worktree/preview root. Git
inspection resolves supervisor registration rather than trusting worker `.git`
pointers, disables optional index writes, and uses hardened worktree settings.

Eligibility is conservative advice, **not permission to delete**. Finished or
retired tasks still retain dirty worktrees, live workers, interrupted/uncertain
setup or previews, missing runner evidence, and pending integrations. Reused
live PIDs are conservatively retained. Existing `run cleanup` remains the only
cleanup operation and rechecks under its own locks; it may differ as state
changes. The inventory never invokes its destructive callbacks or
`--release-uncertain`. Orphans without authoritative saved state, missing paths,
unreadable trees, future schemas, and unproven ownership are unknown/retained,
not reclaimed. Sizes are logical file lengths (not allocated disk blocks), omit
symlink targets and supervisor Git object storage, and are a best-effort
concurrent snapshot, not an atomic quota/accounting or adversarial filesystem
race guarantee.

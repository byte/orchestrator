import "./sandbox-shim.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// A fake Codex that understands `exec ... resume <thread-id> -` the way Codex CLI
// 0.169.0 does (observed 2026-11-15):
// - a resumed thread reports the same thread id in `thread.started`;
// - a thread id with no rollout exits 1 with nothing on stdout and
//   "Error: thread/resume: thread/resume failed: no rollout found for thread id
//   <id> (code -32600)" on stderr.
// Options placed before `exec` (they end up in the orchestrator's codexCommand):
//   --log=<file>       append {argv, cwd, prompt, tmpdir, tmpdirExists} for every invocation as JSONL
//   --missing=<id>     treat this thread id as having no rollout
//   --write            append a line to src/notes.txt and commit it
//   --fresh-delay=<ms> a fresh (non-resumed) thread runs this long before finishing
const args = process.argv.slice(2);
const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const log = option("log");
const missing = option("missing");
const write = args.includes("--write");
const freshDelay = Number(option("fresh-delay") ?? 0);
const execIndex = args.indexOf("exec");
const resumeIndex = args.indexOf("resume");
const resumeThreadId = resumeIndex === -1 ? null : args.at(-2);
const outputFile = args[args.indexOf("--output-last-message") + 1];
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  if (log) {
    fs.appendFileSync(log, `${JSON.stringify({ argv: args.slice(execIndex), cwd: process.cwd(), prompt, tmpdir: process.env.TMPDIR ?? null, tmpdirExists: Boolean(process.env.TMPDIR && fs.existsSync(process.env.TMPDIR)) })}\n`);
  }
  if (resumeThreadId && resumeThreadId === missing) {
    process.stderr.write(
      `Error: thread/resume: thread/resume failed: no rollout found for thread id ${resumeThreadId} (code -32600)\n`
    );
    process.exitCode = 1;
    return;
  }
  const threadId = resumeThreadId ?? `thread-fresh-${process.pid}`;
  emit({ type: "thread.started", thread_id: threadId });
  emit({ type: "turn.started" });
  setTimeout(finish, resumeThreadId ? 0 : freshDelay);
});

function finish() {
  const files = [];
  if (write) {
    const target = path.join(process.cwd(), "src", "notes.txt");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${resumeThreadId ? "resumed" : "fresh"}\n`, "utf8");
    execFileSync("git", ["add", "src/notes.txt"], { cwd: process.cwd() });
    execFileSync("git", ["commit", "--quiet", "-m", "Update notes"], { cwd: process.cwd() });
    files.push("src/notes.txt");
  }
  fs.writeFileSync(
    outputFile,
    JSON.stringify({
      summary: resumeThreadId ? `Resumed ${resumeThreadId}.` : "Started fresh.",
      files_touched: files,
      tests: [{ command: "fake-test", outcome: "passed" }],
      decisions: [],
      assumptions: [],
      blockers: [],
      blocker_code: null,
      confidence: "high"
    }),
    "utf8"
  );
  emit({ type: "turn.completed" });
}

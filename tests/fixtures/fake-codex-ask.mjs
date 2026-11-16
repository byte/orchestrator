import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// A fake Codex worker that pauses with `needs_input` and finishes once the
// supervisor answers. It understands `exec ... resume <thread-id> -` like
// fake-codex-resume.mjs (a resumed thread reports the same thread id; a thread id
// listed in --missing has no rollout). Options placed before `exec`:
//   --log=<file>          append {argv, cwd, prompt} for every invocation as JSONL
//   --ask=scope:<paths>   ask for these comma-separated paths (scope_extension)
//   --ask=question        ask a question with two options
//   --asks=<n>            how many turns ask before finishing (default 1)
//   --write=<paths>       on the finishing turn, write and commit these paths
//   --granted=<paths>     also write these, but only if the answer said "Granted."
//   --stray=<path>        also write this path on the finishing turn, granted or not
//   --partial             commit src/partial.txt on the asking turn
//   --missing=<id>        treat this thread id as having no rollout
//   --replace=<id>        resuming this thread id silently starts a new thread, which
//                         idles 5s before it carries on (Codex does this for ids it
//                         cannot parse)
//   --unavailable=<slug>  reject this model the way fake-codex-model-unavailable.mjs does
const args = process.argv.slice(2);
const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const list = (name) => (option(name) ?? "").split(",").filter(Boolean);
const log = option("log");
const ask = option("ask") ?? "";
const asks = Number(option("asks") ?? 1);
const missing = option("missing");
const replace = option("replace");
const execIndex = args.indexOf("exec");
const resumeIndex = args.indexOf("resume");
const resumeThreadId = resumeIndex === -1 ? null : args.at(-2);
const outputFile = args[args.indexOf("--output-last-message") + 1];
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

function commit(files, message) {
  for (const file of files) {
    const target = path.join(process.cwd(), file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${message}\n`, "utf8");
  }
  execFileSync("git", ["add", ...files], { cwd: process.cwd() });
  execFileSync("git", ["commit", "--quiet", "-m", message], { cwd: process.cwd() });
}

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  if (log) {
    fs.appendFileSync(log, `${JSON.stringify({ argv: args.slice(execIndex), cwd: process.cwd(), prompt })}\n`);
  }
  if (resumeThreadId && resumeThreadId === missing) {
    process.stderr.write(
      `Error: thread/resume: thread/resume failed: no rollout found for thread id ${resumeThreadId} (code -32600)\n`
    );
    process.exitCode = 1;
    return;
  }
  const replaced = Boolean(resumeThreadId) && resumeThreadId === replace;
  const threadId = replaced ? `thread-replaced-${process.pid}` : resumeThreadId ?? `thread-ask-${process.pid}`;
  emit({ type: "thread.started", thread_id: threadId });
  emit({ type: "turn.started" });
  setTimeout(work, replaced ? 5000 : 0);
});

function work() {
  const model = args[args.indexOf("--model") + 1];
  if (model === option("unavailable")) {
    const message = `The '${model}' model is not supported when using Codex with a ChatGPT account.`;
    emit({ type: "error", message });
    emit({ type: "turn.failed", error: { message } });
    process.exitCode = 1;
    return;
  }

  // The resumed thread sees "## Supervisor answer (request <n> ..."; a fresh
  // fallback sees the full briefing with "### Request <n>" under "Supervisor answers".
  const answered = [...prompt.matchAll(/(?:Supervisor answer \(request|### Request) (\d+)/g)]
    .map((match) => Number(match[1]));
  const rounds = answered.length ? Math.max(...answered) : 0;
  const base = {
    tests: [{ command: "fake-test", outcome: "passed" }],
    decisions: [],
    assumptions: [],
    blockers: [],
    blocker_code: null,
    confidence: "high"
  };
  let result;
  if (ask && rounds < asks) {
    const files = [];
    if (args.includes("--partial") && rounds === 0) {
      commit(["src/partial.txt"], "Start the change");
      files.push("src/partial.txt");
    }
    const scope = ask.startsWith("scope:");
    result = {
      ...base,
      summary: `Paused to ask (turn ${rounds + 1}).`,
      files_touched: files,
      needs_input: scope
        ? {
            kind: "scope_extension",
            paths: ask.slice("scope:".length).split(","),
            reason: "The exported helper must change for the assignment to work.",
            question: null,
            options: []
          }
        : {
            kind: "question",
            paths: [],
            reason: "The objective admits two readings",
            question: "Should pagination be cursor-based or offset-based?",
            options: ["cursor", "offset"]
          }
    };
  } else {
    const granted = /decision: Granted\.|decision: granted/.test(prompt);
    const files = [
      ...list("write"),
      ...(granted ? list("granted") : []),
      ...(option("stray") ? [option("stray")] : [])
    ];
    if (files.length) {
      commit(files, "Finish the change");
    }
    const partial = args.includes("--partial") ? ["src/partial.txt"] : [];
    const reply = /supervisor reply: (.+)/.exec(prompt)?.[1] ?? "none";
    result = {
      ...base,
      summary: `Finished after ${rounds} answer(s); granted=${granted}; reply=${reply}.`,
      files_touched: [...new Set([...partial, ...files])],
      needs_input: null
    };
  }
  fs.writeFileSync(outputFile, JSON.stringify(result), "utf8");
  emit({ type: "turn.completed" });
}

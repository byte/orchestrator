import fs from "node:fs";

// Reproduces how Codex CLI 0.169.0 rejects a model the account cannot use
// (observed 2026-11-15): exit 1, nothing on stderr, a thread id, a metadata
// warning item that is not itself a rejection, then a top-level `error` event and
// `turn.failed` naming the slug. Models not listed in --unavailable=<a,b> behave
// like the normal fake worker.
const args = process.argv.slice(2);
const unavailable = new Set(
  (args.find((arg) => arg.startsWith("--unavailable="))?.split("=")[1] ?? "gpt-6-astra")
    .split(",")
    .filter(Boolean)
);
const model = args[args.indexOf("--model") + 1];
const outputFile = args[args.indexOf("--output-last-message") + 1];
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

process.stdin.resume();
process.stdin.on("end", () => {
  // A resumed thread keeps its id, as real Codex reports it.
  const resumed = args.includes("resume") ? args.at(-2) : null;
  emit({ type: "thread.started", thread_id: resumed ?? `thread-${model}` });
  if (unavailable.has(model)) {
    const message = `The '${model}' model is not supported when using Codex with a ChatGPT account.`;
    emit({
      type: "item.completed",
      item: {
        id: "item_0",
        type: "error",
        message: `Model metadata for \`${model}\` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.`
      }
    });
    emit({ type: "turn.started" });
    emit({ type: "error", message });
    emit({ type: "turn.failed", error: { message } });
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(
    outputFile,
    JSON.stringify({
      summary: `Fake worker completed on ${model}.`,
      files_touched: [],
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
});

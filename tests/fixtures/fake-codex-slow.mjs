import "./sandbox-shim.mjs";
import fs from "node:fs";

// A fake Codex worker that stays busy. Options placed before `exec`:
//   --delay=<ms>   how long it runs (default 10000)
//   --complete     finish with a valid structured result and exit 0 instead of
//                  exiting 1 without one
const args = process.argv.slice(2);
const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const delay = Number(option("delay") ?? 10000);
const complete = args.includes("--complete");
const outputFile = args[args.indexOf("--output-last-message") + 1];

process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(`${JSON.stringify({
    type: "thread.started",
    thread_id: "thread-slow"
  })}\n`);
});

process.on("SIGTERM", () => {
  process.exit(143);
});

setTimeout(() => {
  if (!complete) {
    process.exit(1);
  }
  fs.writeFileSync(outputFile, JSON.stringify({
    summary: `Slow worker finished after ${delay} ms.`,
    files_touched: [],
    tests: [],
    decisions: [],
    assumptions: [],
    blockers: [],
    blocker_code: null,
    needs_input: null,
    confidence: "high"
  }), "utf8");
  process.stdout.write(`${JSON.stringify({ type: "turn.completed" })}\n`);
  process.exit(0);
}, delay);

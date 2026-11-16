import "./sandbox-shim.mjs";
import fs from "node:fs";

// A process that ignores SIGTERM, and writes its own pid (argv[1]) only once that
// handler is installed, so a test never signals it before it can ignore it.
const HOLDER = "process.on('SIGTERM', () => {}); require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)";

// A fake Codex worker that stays busy. Options placed before `exec`:
//   --delay=<ms>   how long it runs (default 10000)
//   --complete     finish with a valid structured result and exit 0 instead of
//                  exiting 1 without one
const args = process.argv.slice(2);
const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const delay = Number(option("delay") ?? 10000);
const complete = args.includes("--complete");
const outputFile = args[args.indexOf("--output-last-message") + 1];

//   --descendant=<file>  start a long-running child that holds this process's
//                  output pipes, write its pid to <file>, and ignore SIGTERM in it
const descendantFile = option("descendant");
if (descendantFile) {
  const { spawn } = await import("node:child_process");
  // --quiet-descendant gives it no pipes at all, so Codex's own exit closes them.
  const stdio = args.includes("--quiet-descendant") ? "ignore" : "inherit";
  spawn(process.execPath, ["-e", HOLDER, descendantFile], { stdio });
  // Carry on only once it can ignore SIGTERM.
  while (!fs.existsSync(descendantFile)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}

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

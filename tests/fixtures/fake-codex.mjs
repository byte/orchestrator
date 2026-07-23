import fs from "node:fs";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const outputFile = args[outputIndex + 1];

process.stdin.resume();
process.stdin.on("end", () => {
  fs.writeFileSync(
    outputFile,
    JSON.stringify({
      summary: "Fake worker completed.",
      files_touched: [],
      tests: [{ command: "fake-test", outcome: "passed" }],
      decisions: [],
      assumptions: [],
      blockers: [],
      confidence: "high"
    }),
    "utf8"
  );
  process.stdout.write(`${JSON.stringify({
    type: "thread.started",
    thread_id: "thread-fake"
  })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "turn.completed" })}\n`);
});

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const outputFile = args[outputIndex + 1];

process.stdin.resume();
process.stdin.on("end", () => {
  const target = path.join(process.cwd(), "src", "generated.js");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "export const generated = true;\n", "utf8");
  execFileSync("git", ["add", "src/generated.js"], { cwd: process.cwd() });
  execFileSync("git", ["commit", "--quiet", "-m", "Add generated module"], {
    cwd: process.cwd()
  });

  fs.writeFileSync(
    outputFile,
    JSON.stringify({
      summary: "Added and committed the generated module.",
      files_touched: ["src/generated.js"],
      tests: [{ command: "test -f src/generated.js", outcome: "passed" }],
      decisions: [],
      assumptions: [],
      blockers: [],
      confidence: "high"
    }),
    "utf8"
  );
  process.stdout.write(`${JSON.stringify({
    type: "thread.started",
    thread_id: "thread-fake-write"
  })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "turn.completed" })}\n`);
});

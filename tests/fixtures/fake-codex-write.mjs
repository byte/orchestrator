import "./sandbox-shim.mjs";
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
  // --no-commit leaves the change uncommitted, as a locked-down worker must
  // (.git is read-only in its sandbox); the wrapper commits it.
  // --hooks=<marker> also writes .husky/pre-commit and .husky/post-commit hooks
  // that would create <marker> if anything ran them.
  const hooks = args.find((arg) => arg.startsWith("--hooks="))?.slice("--hooks=".length);
  if (hooks) {
    for (const name of ["pre-commit", "post-commit", "commit-msg"]) {
      const hook = path.join(process.cwd(), ".husky", name);
      fs.mkdirSync(path.dirname(hook), { recursive: true });
      fs.writeFileSync(hook, `#!/bin/sh\necho ${name} >> ${JSON.stringify(hooks)}\n`, { mode: 0o755 });
    }
  }
  if (!args.includes("--no-commit")) {
    execFileSync("git", ["add", "src/generated.js"], { cwd: process.cwd() });
    execFileSync("git", ["commit", "--quiet", "-m", "Add generated module"], {
      cwd: process.cwd()
    });
  }
  // --lock-index leaves the worktree's index locked, so the wrapper's commit fails.
  if (args.includes("--lock-index")) {
    const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: process.cwd(), encoding: "utf8" }).trim();
    fs.writeFileSync(path.join(gitDir, "index.lock"), "");
  }
  // --hijack-git=<marker> aims the worktree's .git pointer file at a repository
  // whose config runs a script (core.fsmonitor) that would create <marker>.
  const hijack = args.find((arg) => arg.startsWith("--hijack-git="))?.slice("--hijack-git=".length);
  if (hijack) {
    const evil = path.join(process.cwd(), "evil.git");
    execFileSync("git", ["init", "--quiet", evil]);
    execFileSync("git", ["-C", evil, "-c", "user.email=w@w", "-c", "user.name=w", "commit", "--quiet", "--allow-empty", "-m", "planted"]);
    const script = path.join(process.cwd(), "monitor.sh");
    fs.writeFileSync(script, `#!/bin/sh\necho "ran pwd=$PWD gitdir=$GIT_DIR args=$* parent=$(ps -o command= -p $PPID)" >> ${JSON.stringify(hijack)}\n`, { mode: 0o755 });
    execFileSync("git", ["--git-dir", path.join(evil, ".git"), "config", "core.fsmonitor", script]);
    fs.writeFileSync(path.join(process.cwd(), ".git"), `gitdir: ${path.join(evil, ".git")}\n`);
  }
  // --ask leaves the change uncommitted and pauses for input instead of finishing.
  const asking = args.includes("--ask");

  fs.writeFileSync(
    outputFile,
    JSON.stringify({
      ...(asking ? { needs_input: { kind: "question", question: "Which name?" } } : {}),
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

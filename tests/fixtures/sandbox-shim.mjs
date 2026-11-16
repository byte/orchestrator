// Stands in for `codex sandbox` in the fake Codex fixtures. A worker probes the
// read-only permissions profile with `codex sandbox <profile args> -- node -e
// <probe> <scratch> <worktree> <marker>` before launching a read task. There is
// no seatbelt here, so the shim runs the real probe and decides what the
// sandbox would have allowed:
//   --sandbox-probe=ok        (default) scratch writable, worktree not: the
//                             worktree argument is swapped for a path that
//                             cannot be written
//   --sandbox-probe=writable  run the probe as given, so the worktree is writable
//   --sandbox-probe=fail      exit 2 the way a Codex without `sandbox` would
// Imported first by every fixture; it exits the process for a sandbox call and
// does nothing otherwise.
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const at = args.indexOf("sandbox");
if (at !== -1 && !args.includes("exec")) {
  const mode = args.find((arg) => arg.startsWith("--sandbox-probe="))?.slice("--sandbox-probe=".length) ?? "ok";
  if (mode === "fail") {
    process.stderr.write("error: unrecognized subcommand 'sandbox'\n");
    process.exit(2);
  }
  const command = args.slice(args.indexOf("--", at) + 1);
  if (mode === "ok") {
    // [node, -e, script, scratch, worktree, marker]
    command[4] = "/nonexistent/orchestrator-sandbox-shim";
  }
  const result = spawnSync(command[0], command.slice(1), { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

// Stands in for `codex sandbox` in the fake Codex fixtures. A worker probes the
// read-only permissions profile with `codex sandbox <profile args> -- node -e
// <probe> <scratch> <worktree> <marker>` before launching a read task. There is
// no seatbelt here, so the shim runs the real probe and decides what the
// sandbox would have allowed:
//   --sandbox-probe=ok        (default) scratch writable, worktree not: the
//                             worktree argument is swapped for a directory
//                             without write permission
//   --sandbox-probe=writable  run the probe as given, so the worktree is writable
//   --sandbox-probe=fail      exit 2 the way a Codex without `sandbox` would
//   --sandbox-probe=ok-exit17 print a passing probe result, then exit 17
//   --sandbox-probe=hang      write this process's pid to --sandbox-probe-pid=<file>
//                             and hang, to test stopping a worker mid-probe
// Imported first by every fixture; it exits the process for a sandbox call and
// does nothing otherwise.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const at = args.indexOf("sandbox");
if (at !== -1 && !args.includes("exec")) {
  const mode = args.find((arg) => arg.startsWith("--sandbox-probe="))?.slice("--sandbox-probe=".length) ?? "ok";
  if (mode === "fail") {
    process.stderr.write("error: unrecognized subcommand 'sandbox'\n");
    process.exit(2);
  }
  if (mode === "hang") {
    const pidFile = args.find((arg) => arg.startsWith("--sandbox-probe-pid="))?.slice("--sandbox-probe-pid=".length);
    if (pidFile) {
      fs.writeFileSync(pidFile, String(process.pid));
    }
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  const command = args.slice(args.indexOf("--", at) + 1);
  let denied = null;
  if (mode === "ok" || mode === "ok-exit17") {
    // [node, -e, script, scratch, worktree, marker]: point the worktree argument
    // at a directory without write permission, as the sandbox would deny it.
    denied = fs.mkdtempSync(path.join(os.tmpdir(), "orch-shim-denied-"));
    fs.chmodSync(denied, 0o500);
    command[4] = denied;
  }
  const result = spawnSync(command[0], command.slice(1), { stdio: "inherit" });
  if (denied) {
    fs.chmodSync(denied, 0o700);
    fs.rmSync(denied, { recursive: true, force: true });
  }
  process.exit(mode === "ok-exit17" ? 17 : result.status ?? 1);
}

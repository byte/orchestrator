// Preload only in CLI regression subprocesses. Exit without releasing locks,
// at the durable intent / Git / durable acceptance boundaries.
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const phase = process.env.ORCH_TEST_INTEGRATION_INTERRUPT;
const read = fs.readFileSync;
let staleRead = false;
fs.readFileSync = function (file, ...rest) {
  if (!staleRead && String(file) === process.env.ORCH_TEST_STALE_STATUS_FILE) {
    staleRead = true;
    return read.call(this, process.env.ORCH_TEST_STALE_STATUS_SNAPSHOT, ...rest);
  }
  return read.call(this, file, ...rest);
};
// Intentional process.exit skips execGit's finally. This fixture owns its
// capture directories, including the descriptors inherited by the gated child.
const captures = [];
const mkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function (prefix, ...rest) {
  const directory = mkdtemp.call(this, prefix, ...rest);
  if (String(prefix).endsWith("orch-git-")) captures.push(directory);
  return directory;
};
process.on("exit", () => {
  for (const directory of captures) fs.rmSync(directory, { recursive: true, force: true });
});
const rename = fs.renameSync;
fs.renameSync = function (source, target) {
  if (String(target).endsWith("/run.json")) {
    const run = JSON.parse(fs.readFileSync(source, "utf8"));
    if (phase === "after-git" && run.tasks.build?.status === "completed") {
      process.exit(86);
    }
    const result = rename.call(this, source, target);
    if (phase === "before-git" && run.pendingIntegration) {
      process.exit(86);
    }
    return result;
  }
  return rename.call(this, source, target);
};

const exec = childProcess.execFileSync;
childProcess.execFileSync = function (file, args, options) {
  if (phase === "partial-git" && file === "git" && args.includes("cherry-pick") && !args.includes("--abort")) {
    // Apply only the first of the two inspected commits, then die.
    exec.call(this, file, args.slice(0, -1), options);
    process.exit(86);
  }
  return exec.call(this, file, args, options);
};

const spawn = childProcess.spawnSync;
const kill = process.kill;
let unreapableGroup;
process.kill = function (pid, signal) {
  if (pid === -unreapableGroup || (signal !== 0 && pid === -Number(process.env.ORCH_TEST_DENY_GROUP))) {
    throw Object.assign(new Error("injected group denial"), { code: "EPERM" });
  }
  return kill.call(this, pid, signal);
};
childProcess.spawnSync = function (file, args, options) {
  if (process.env.ORCH_TEST_SHORT_GIT_TIMEOUT && /(?:^|\/)git$/.test(file) && options?.timeout) {
    options = { ...options, timeout: 150 };
  }
  if (/(?:^|\/)git$/.test(file) && ((args.includes("cherry-pick") && !args.includes("--abort")) ||
      (phase?.startsWith("wrapper-") && args.includes("commit")))) {
    if (["signalled-git", "unreapable-git", "wrapper-signalled-git", "wrapper-success-git", "wrapper-delayed-git"].includes(phase)) {
      const result = spawn.call(this, "/bin/sh", ["-c", `
        /bin/sh -c 'kill -STOP $$; exec "$@"' gate "$@" &
        child=$!
        printf '%s' "$child" > "$ORCH_TEST_GIT_PID"
        while ! /bin/ps -o stat= -p "$child" | /usr/bin/grep -q T; do sleep 0.01; done
        ${phase === "wrapper-delayed-git" ? "sleep 5" : ":"}
        ${phase === "wrapper-success-git" ? "exit 0" : "kill -KILL $$"}
      `, "launcher", file, ...args], options);
      if (phase === "unreapable-git") unreapableGroup = result.pid;
      return result;
    }
    if (phase === "orphan-git") {
      const child = childProcess.spawn("/bin/sh", ["-c", 'kill -STOP $$; exec "$@"', "gate", file, ...args], options);
      fs.writeFileSync(process.env.ORCH_TEST_GIT_PID, String(child.pid));
      process.exit(86);
    }
    if (phase === "partial-git") {
      spawn.call(this, file, args.slice(0, -1), options);
      process.exit(86);
    }
  }
  return spawn.call(this, file, args, options);
};
syncBuiltinESMExports();

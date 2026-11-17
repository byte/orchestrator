// Preload only in CLI regression subprocesses. Exit without releasing locks,
// at the durable intent / Git / durable acceptance boundaries.
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const phase = process.env.ORCH_TEST_INTEGRATION_INTERRUPT;
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
syncBuiltinESMExports();

#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import { BoundedLog } from "./lib/bounded-log.mjs";

// The detached group has its own deadline even if the synchronous CLI dies.
const spec = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const stdout = new BoundedLog(spec.stdout, { limitBytes: 32 * 1024, tail: true });
const stderr = new BoundedLog(spec.stderr, { limitBytes: 32 * 1024, tail: true });
const child = spawn(spec.argv[0], spec.argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
let error = null;
let stopped = false;
const writeResult = (fields) => fs.writeFileSync(spec.result, JSON.stringify({ ...fields, error,
  stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated }), { mode: 0o600 });
const stopGroup = () => {
  // The caller makes this process the group leader.
  if (spec.ownGroup) {
    try { process.kill(0, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  } else child.kill("SIGKILL");
};
// Stop the whole group, this process included: a descendant that inherited the
// pipes would otherwise hold them open until the timeout. The captures are
// written synchronously, so the result is saved first and nothing is lost.
const stop = (reason) => {
  if (stopped) return;
  stopped = true;
  error = reason;
  try { writeResult({ status: null, signal: "SIGKILL" }); }
  finally { stopGroup(); }
};
const timer = setTimeout(() => stop(`Command exceeded ${spec.timeoutMs} ms and was stopped (ETIMEDOUT).`),
  Math.max(1, spec.deadlineMs - Date.now()));
for (const [stream, capture] of [[child.stdout, stdout], [child.stderr, stderr]]) {
  capture.on("error", (failure) => stop(failure.message));
  stream.on("data", (chunk) => {
    capture.write(chunk);
    if (capture.observedBytes > spec.maxOutputBytes) {
      stop(`Command output exceeded maxOutputBytes (${spec.maxOutputBytes}); command stopped.`);
    }
  });
}
child.on("error", (failure) => { error = failure.message; });
child.on("close", async (status, signal) => {
  if (stopped) return;
  await Promise.all([stdout, stderr].map((capture) => new Promise((resolve) => capture.end(resolve))));
  if (stopped) return;
  clearTimeout(timer);
  // Background descendants may have closed their streams. End their group
  // even on success, including when the original caller is already gone.
  try { writeResult({ status, signal }); }
  finally { stopGroup(); }
});

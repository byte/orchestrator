#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import { BoundedLog } from "./lib/bounded-log.mjs";

// Shares the parent's detached group: the synchronous caller kills the entire
// group on every exit, including timeout and a descendant holding pipes open.
const spec = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const stdout = new BoundedLog(spec.stdout, { limitBytes: 32 * 1024, tail: true });
const stderr = new BoundedLog(spec.stderr, { limitBytes: 32 * 1024, tail: true });
const child = spawn(spec.argv[0], spec.argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
let error = null;
let outputLimit = false;
for (const [stream, capture] of [[child.stdout, stdout], [child.stderr, stderr]]) {
  capture.on("error", (failure) => { error = failure.message; child.kill("SIGKILL"); });
  stream.on("data", (chunk) => {
    capture.write(chunk);
    if (capture.observedBytes > spec.maxOutputBytes && !outputLimit) {
      outputLimit = true;
      error = `Command output exceeded maxOutputBytes (${spec.maxOutputBytes}); command stopped.`;
      child.kill("SIGKILL");
    }
  });
}
child.on("error", (failure) => { error = failure.message; });
child.on("close", async (status, signal) => {
  await Promise.all([stdout, stderr].map((capture) => new Promise((resolve) => capture.end(resolve))));
  fs.writeFileSync(spec.result, JSON.stringify({ status, signal, error,
    stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated }), { mode: 0o600 });
});

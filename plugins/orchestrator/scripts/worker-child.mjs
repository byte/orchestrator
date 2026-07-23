#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";

function atomicWrite(filePath, payload) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  fs.renameSync(temporary, filePath);
}

const specPath = process.argv[2];
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const startedAt = new Date().toISOString();
let threadId = null;

atomicWrite(spec.statusFile, {
  status: "running",
  pid: process.pid,
  startedAt,
  threadId
});

const output = fs.createWriteStream(spec.outputFile, { flags: "a", mode: 0o600 });
const errors = fs.createWriteStream(spec.errorFile, { flags: "a", mode: 0o600 });
const prompt = fs.readFileSync(spec.promptFile);
const [command, ...prefixArgs] = spec.codexCommand;
const args = [
  ...prefixArgs,
  "exec",
  "-C",
  spec.worktreePath,
  "--model",
  spec.model,
  "-c",
  `model_reasoning_effort="${spec.reasoningEffort}"`,
  "--sandbox",
  spec.sandbox,
  "--json",
  "--output-schema",
  spec.schemaFile,
  "--output-last-message",
  spec.lastMessageFile,
  "-"
];

const child = spawn(command, args, {
  cwd: spec.worktreePath,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"]
});

let stopping = false;
function stopChild(signal = "SIGTERM") {
  if (stopping) {
    return;
  }
  stopping = true;
  try {
    child.kill(signal);
  } catch {
    // Exit handling below records the final state.
  }
}
process.on("SIGTERM", () => stopChild("SIGTERM"));
process.on("SIGINT", () => stopChild("SIGINT"));

let buffered = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  output.write(chunk);
  buffered += chunk;
  const lines = buffered.split("\n");
  buffered = lines.pop() ?? "";
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === "thread.started" && event.thread_id) {
        threadId = event.thread_id;
        atomicWrite(spec.statusFile, {
          status: "running",
          pid: process.pid,
          childPid: child.pid,
          startedAt,
          threadId
        });
      }
    } catch {
      // Preserve malformed output in the JSONL file; collection will report it.
    }
  }
});
child.stderr.pipe(errors);
child.stdin.end(prompt);

child.on("error", (error) => {
  atomicWrite(spec.statusFile, {
    status: "failed",
    pid: process.pid,
    startedAt,
    finishedAt: new Date().toISOString(),
    threadId,
    error: error.message
  });
  output.end();
  errors.end();
});

child.on("exit", (code, signal) => {
  atomicWrite(spec.statusFile, {
    status: stopping ? "cancelled" : code === 0 ? "completed" : "failed",
    pid: process.pid,
    childPid: child.pid,
    startedAt,
    finishedAt: new Date().toISOString(),
    threadId,
    exitCode: code,
    signal
  });
  output.end();
  errors.end();
});

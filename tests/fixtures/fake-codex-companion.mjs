// A stand-in for the Codex plugin's codex-companion.mjs: task --background,
// status, result, and cancel over job files in FAKE_COMPANION_STATE. A job
// finishes FAKE_COMPANION_MS after it was queued (default 200 ms). Every call is
// appended to FAKE_COMPANION_LOG as JSON.
import fs from "node:fs";
import path from "node:path";

const [command, ...args] = process.argv.slice(2);
const state = process.env.FAKE_COMPANION_STATE;
const delay = Number(process.env.FAKE_COMPANION_MS ?? 200);
fs.mkdirSync(state, { recursive: true });
if (process.env.FAKE_COMPANION_LOG) {
  fs.appendFileSync(process.env.FAKE_COMPANION_LOG, `${JSON.stringify({ command, args, cwd: process.cwd() })}\n`);
}

const value = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
};
const jobFile = (id) => path.join(state, `${id}.json`);
const read = (id) => JSON.parse(fs.readFileSync(jobFile(id), "utf8"));
const save = (job) => fs.writeFileSync(jobFile(job.id), JSON.stringify(job));
const print = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);

function current(job) {
  if (job.status === "running" && Date.now() >= job.doneAt) {
    job.status = "completed";
    job.threadId = job.resume ? "thread-plugin-1" : `thread-plugin-${job.id}`;
    save(job);
  }
  return job;
}

if (command === "task") {
  const id = `job-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const cwd = value("--cwd");
  if (args.includes("--write")) {
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "plugin.js"), "export const viaPlugin = true;\n");
  }
  save({
    id,
    status: "running",
    resume: args.includes("--resume"),
    write: args.includes("--write"),
    doneAt: Date.now() + delay,
    prompt: fs.readFileSync(value("--prompt-file"), "utf8")
  });
  print({ jobId: id, status: "queued" });
} else if (command === "status") {
  print({ job: current(read(args[0])) });
} else if (command === "result") {
  const job = current(read(args[0]));
  const report = {
    summary: "Done through the plugin.",
    files_touched: job.write ? ["src/plugin.js"] : [],
    tests: [],
    decisions: [],
    assumptions: [],
    blockers: [],
    blocker_code: null,
    needs_input: null,
    confidence: "high"
  };
  print({
    job,
    storedJob: {
      ...job,
      result: { rawOutput: `Here is my report.\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n` }
    }
  });
} else if (command === "cancel") {
  const job = read(args[0]);
  job.status = "cancelled";
  save(job);
  print({ job });
} else {
  process.stderr.write(`unknown command ${command}\n`);
  process.exit(1);
}

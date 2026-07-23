#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";

import { evaluateRun } from "./lib/acceptance.mjs";
import { parseArgs, splitList } from "./lib/args.mjs";
import { briefingLedger, renderBriefing } from "./lib/briefing.mjs";
import { changedFiles, currentBranch, headSha } from "./lib/git.mjs";
import { addLedgerEntry, readLedger } from "./lib/ledger.mjs";
import { addLane, bindThread, listLanes, removeLane, requireLane, unbindThread } from "./lib/lanes.mjs";
import { preflight } from "./lib/preflight.mjs";
import { renderAcceptance, renderLanes, renderPreflight } from "./lib/render.mjs";
import {
  initWorkspace,
  isInitialized,
  loadLocalState,
  nowIso,
  orchDir,
  updateLocalState
} from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const USAGE = `orchestrator — keep Codex briefed across tasks

Usage:
  orch preflight [--json]
  orch init
  orch lane list [--json]
  orch lane add <name> [--description <text>] [--scope <glob>]... [--constraint <text>]... [--done <text>]
  orch lane remove <name>
  orch lane show <name> [--json]
  orch lane bind <name> <thread-id>
  orch lane unbind <name>
  orch brief <name> [--task <text>] [--no-snapshot] [--json]
  orch accept <name> [--result-file <path>] [--json]
  orch ledger show
  orch ledger add <section> <text>
`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function emit(text) {
  process.stdout.write(`${text}\n`);
}

function emitJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function requireInitialized(cwd) {
  if (!isInitialized(cwd)) {
    throw new Error("Orchestrator is not initialized in this repository. Run /orch:init first.");
  }
}

function readTask(options, positionals) {
  if (options.task) {
    return String(options.task);
  }
  if (options["task-file"]) {
    return fs.readFileSync(options["task-file"], "utf8");
  }
  const inline = positionals.join(" ").trim();
  if (inline) {
    return inline;
  }
  throw new Error("A task description is required. Pass --task, --task-file, or trailing text.");
}

function commandPreflight(argv, cwd) {
  const { options } = parseArgs(argv, { booleanOptions: ["json"] });
  const report = preflight(cwd);
  if (options.json) {
    emitJson(report);
  } else {
    emit(renderPreflight(report));
  }
  if (!report.ok) {
    process.exitCode = 1;
  }
}

function commandInit(cwd) {
  const report = preflight(cwd);
  const { dir, created } = initWorkspace(cwd);

  const lines = [`Initialized orchestrator at ${dir}`, ""];
  lines.push(created.length ? `Created:\n${created.map((file) => `- ${file}`).join("\n")}` : "Nothing to create; already initialized.");
  lines.push("");
  lines.push("`local/` is self-ignored: thread bindings stay on this machine, lanes and the ledger are meant to be committed.");
  lines.push("");
  lines.push(renderPreflight(preflight(cwd)));
  if (!report.ok) {
    lines.push("", "Dispatch will not work until the blocking checks above are fixed.");
  }
  emit(lines.join("\n"));
}

function commandLane(argv, cwd) {
  const [action = "list", ...rest] = argv;
  const { options, positionals } = parseArgs(rest, {
    booleanOptions: ["json"],
    repeatableOptions: ["scope", "constraint"]
  });

  if (action === "list") {
    const lanes = listLanes(cwd);
    return options.json ? emitJson(lanes) : emit(renderLanes(lanes));
  }

  const name = positionals[0];
  if (!name) {
    throw new Error(`\`orch lane ${action}\` requires a lane name.`);
  }

  if (action === "add") {
    const lane = addLane(cwd, name, {
      description: options.description ?? "",
      scope: splitList(options.scope),
      constraints: splitList(options.constraint),
      done: options.done ?? ""
    });
    return options.json ? emitJson(lane) : emit(renderLanes([lane]));
  }

  if (action === "remove") {
    const removed = removeLane(cwd, name);
    return emit(removed ? `Removed lane "${name}".` : `No lane named "${name}".`);
  }

  if (action === "show") {
    const lane = requireLane(cwd, name);
    return options.json ? emitJson(lane) : emit(renderLanes([lane]));
  }

  if (action === "bind") {
    requireLane(cwd, name);
    const threadId = positionals[1];
    if (!threadId) {
      throw new Error("`orch lane bind` requires a thread id.");
    }
    const bound = bindThread(cwd, name, threadId);
    return emit(`Bound lane "${bound.lane}" to Codex thread ${bound.threadId}.`);
  }

  if (action === "unbind") {
    unbindThread(cwd, name);
    return emit(`Unbound lane "${name}". The next dispatch starts a fresh Codex thread.`);
  }

  throw new Error(`Unknown lane action "${action}".`);
}

function commandBrief(argv, cwd) {
  requireInitialized(cwd);
  const { options, positionals } = parseArgs(argv, { booleanOptions: ["json", "no-snapshot"] });
  const name = positionals.shift();
  if (!name) {
    throw new Error("`orch brief` requires a lane name.");
  }

  const lane = requireLane(cwd, name);
  const task = readTask(options, positionals);
  const ledger = briefingLedger(cwd);
  const resuming = Boolean(lane.threadId);
  const text = renderBriefing({ lane, task, ledger, resuming });

  // Snapshot before dispatch so the acceptance check can attribute changes to
  // this run rather than to whatever was already dirty in the tree.
  if (!options["no-snapshot"]) {
    updateLocalState(cwd, (local) => {
      local.snapshots[lane.name] = {
        head: headSha(cwd),
        branch: currentBranch(cwd),
        changedFiles: changedFiles(cwd),
        task,
        takenAt: nowIso()
      };
    });
  }

  if (options.json) {
    return emitJson({
      lane: lane.name,
      resuming,
      threadId: lane.threadId,
      ledgerBytes: ledger.bytes,
      ledgerOversized: ledger.oversized,
      briefing: text
    });
  }

  if (ledger.oversized) {
    process.stderr.write(
      `warning: ledger is ${ledger.bytes} bytes and rides along in every briefing. Consider pruning it.\n`
    );
  }
  emit(text);
}

function commandAccept(argv, cwd) {
  requireInitialized(cwd);
  const { options, positionals } = parseArgs(argv, { booleanOptions: ["json"] });
  const name = positionals.shift();
  if (!name) {
    throw new Error("`orch accept` requires a lane name.");
  }

  const lane = requireLane(cwd, name);
  const local = loadLocalState(cwd);
  const snapshot = local.snapshots[lane.name];
  if (!snapshot) {
    throw new Error(`No pre-dispatch snapshot for lane "${lane.name}". Run \`orch brief\` before dispatching.`);
  }

  let resultText = "";
  if (options["result-file"]) {
    resultText = fs.readFileSync(options["result-file"], "utf8");
  } else if (positionals.length) {
    resultText = positionals.join(" ");
  }

  const evaluation = evaluateRun({
    lane,
    snapshot,
    changedNow: changedFiles(cwd),
    resultText
  });

  if (options.json) {
    emitJson({ lane: lane.name, ...evaluation });
  } else {
    emit(renderAcceptance(lane, evaluation));
  }

  if (evaluation.verdict !== "clean") {
    process.exitCode = 2;
  }
}

function commandLedger(argv, cwd) {
  requireInitialized(cwd);
  const [action = "show", ...rest] = argv;

  if (action === "show") {
    return emit(readLedger(cwd).trimEnd());
  }

  if (action === "add") {
    const section = rest.shift();
    const text = rest.join(" ").trim();
    if (!section || !text) {
      throw new Error("`orch ledger add` requires a section and text.");
    }
    const entry = addLedgerEntry(cwd, section, text);
    return emit(`Added to ${entry.section}: ${entry.entry}`);
  }

  throw new Error(`Unknown ledger action "${action}".`);
}

function main() {
  const [, , command = "help", ...argv] = process.argv;
  const cwd = resolveWorkspaceRoot(process.cwd());

  try {
    switch (command) {
      case "preflight":
        return commandPreflight(argv, cwd);
      case "init":
        return commandInit(cwd);
      case "lane":
        return commandLane(argv, cwd);
      case "brief":
        return commandBrief(argv, cwd);
      case "accept":
        return commandAccept(argv, cwd);
      case "ledger":
        return commandLedger(argv, cwd);
      case "where":
        return emit(orchDir(cwd));
      case "help":
      case "--help":
      case "-h":
        return emit(USAGE);
      default:
        return fail(`Unknown command "${command}".\n\n${USAGE}`);
    }
  } catch (error) {
    return fail(`error: ${error.message}`);
  }
}

main();

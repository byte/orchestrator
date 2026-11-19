#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const all = fs.readdirSync(new URL("../tests/", import.meta.url)).filter((file) => file.endsWith(".test.mjs")).sort();
const fast = new Set(["glob", "redaction", "render", "metadata", "outcomes"].map((name) => `${name}.test.mjs`));
const repeat = ["locks.test.mjs", "wait.test.mjs", "cleanup-races.test.mjs"];
const [mode = "full", ...flags] = process.argv.slice(2);
if (!["fast", "protocol", "full", "repeat"].includes(mode) || flags.some((flag) => flag !== "--load") || (flags.length && mode !== "repeat")) {
  console.error("Usage: node scripts/test.mjs fast|protocol|full|repeat [--load]");
  process.exit(2);
}
const files = mode === "fast" ? all.filter((file) => fast.has(file)) : mode === "protocol" ? all.filter((file) => !fast.has(file)) : mode === "repeat" ? repeat : all;
// --test-concurrency arrived after our oldest supported runtime. Keep that
// runtime usable by running one file at a time instead of overloading it.
const [major, minor] = process.versions.node.split(".").map(Number);
const supportsConcurrency = major >= 21 || (major === 20 && minor >= 10) || (major === 18 && minor >= 19);
const groups = supportsConcurrency ? [files] : files.map((file) => [file]);
// A single bounded-duty CPU process, not a stress test or a timing guarantee.
const load = flags.includes("--load") ? spawn(process.execPath, ["-e", "setInterval(()=>{const end=Date.now()+20;while(Date.now()<end){}},50)"], { stdio: "ignore" }) : null;
let active;
let interrupted = 0;
const stop = (signal) => {
  interrupted = signal === "SIGINT" ? 130 : 143;
  active?.kill(signal);
  load?.kill(signal);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
try {
  for (let iteration = 1; iteration <= (mode === "repeat" ? 2 : 1); iteration++) {
    const started = Date.now();
    console.log(`# ${mode} ${iteration}: ${files.length} files, concurrency ${supportsConcurrency ? 2 : "1 (legacy Node fallback)"}, load ${Boolean(load)}`);
    let code = 0;
    for (const group of groups) {
      active = spawn(process.execPath, ["--test", ...(supportsConcurrency ? ["--test-concurrency=2"] : []), ...group.map((file) => `tests/${file}`)], { cwd: root, stdio: "inherit" });
      code = await new Promise((resolve) => {
        active.on("error", (error) => { console.error(error.message); resolve(1); });
        active.on("exit", (exit) => resolve(code || (exit ?? 1)));
      });
      if (interrupted) { code = interrupted; break; }
      // Repeat stops at the first failure; the other suites still run every
      // file one at a time on old Node, so a full run is never cut short.
      if (code && mode === "repeat") break;
    }
    console.log(`# ${mode} ${iteration}: exit ${code}, elapsed ${((Date.now() - started) / 1000).toFixed(1)}s`);
    if (code) { process.exitCode = code; break; } // Never retry or hide a failed iteration.
  }
} finally { load?.kill("SIGTERM"); }

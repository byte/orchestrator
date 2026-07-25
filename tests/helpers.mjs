import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { addCheckpoint } from "../plugins/orchestrator/scripts/lib/runs.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

export const CLI = path.join(here, "..", "plugins", "orchestrator", "scripts", "orch.mjs");

/** Create a throwaway git repository so tests never touch the developer's tree. */
export function makeRepo() {
  // realpath the temp dir: on macOS /var is a symlink to /private/var, and git
  // reports the resolved path, which would otherwise break path comparisons.
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "orch-test-"));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(root, "seed.txt"), "seed\n", "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", "seed"]);
  return root;
}

export function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

export function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Write a Codex result transcript outside the repository. Putting it inside would
 * make the result file itself show up as an undeclared, out-of-scope change.
 */
export function writeResult(contents) {
  const filePath = path.join(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "orch-result-")), "result.txt");
  fs.writeFileSync(filePath, contents, "utf8");
  return filePath;
}

export function write(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, "utf8");
  return target;
}

/** Run the CLI in a repo and capture stdout, stderr, and exit code. */
export function runCli(root, args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? ""
    };
  }
}

/**
 * Dispatch is gated on a checkpoint covering the current plan revision, so tests
 * that launch or claim work record one first, exactly as a supervisor must.
 */
export function checkpointPlan(root, runId, summary = "plan approved") {
  return addCheckpoint(root, runId, { summary });
}

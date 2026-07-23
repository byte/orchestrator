import { parseFileList, parseResultBlock } from "./briefing.mjs";
import { partitionByScope } from "./glob.mjs";

/**
 * Compare what Codex said it did against what the working tree says it did.
 *
 * Three independent checks:
 *   - scope:    changes outside the lane's declared patterns
 *   - undeclared: files that changed but were never reported
 *   - phantom:  files reported as touched that did not actually change
 *
 * `phantom` is the interesting one. It usually means the run failed partway and
 * the summary describes intent rather than outcome.
 */
export function evaluateRun({ lane, snapshot, changedNow = [], resultText = "" }) {
  const before = new Set(snapshot?.changedFiles ?? []);
  const headChanged = Boolean(snapshot) && snapshot.head !== (snapshot.headAfter ?? snapshot.head);

  const attributable = changedNow.filter((filePath) => !before.has(filePath));
  const preexisting = changedNow.filter((filePath) => before.has(filePath));

  const scope = lane?.scope ?? [];
  const { inScope, outOfScope } = scope.length
    ? partitionByScope(attributable, scope)
    : { inScope: attributable, outOfScope: [] };

  const result = parseResultBlock(resultText);
  const declared = parseFileList(result.fields.files_touched);
  const declaredSet = new Set(declared);
  const attributableSet = new Set(attributable);

  const undeclared = attributable.filter((filePath) => !declaredSet.has(filePath));
  const phantom = declared.filter((filePath) => !attributableSet.has(filePath));

  const problems = [];
  if (scope.length && outOfScope.length) {
    problems.push(`${outOfScope.length} file(s) changed outside the lane's declared scope`);
  }
  if (!result.found) {
    problems.push("no RESULT block was returned, so nothing could be cross-checked");
  } else if (result.missing.length) {
    problems.push(`RESULT block is missing: ${result.missing.join(", ")}`);
  }
  if (result.found && undeclared.length) {
    problems.push(`${undeclared.length} changed file(s) were not declared in files_touched`);
  }
  if (result.found && phantom.length) {
    problems.push(`${phantom.length} declared file(s) show no actual change`);
  }
  if (String(result.fields.blockers ?? "").trim() && !isNone(result.fields.blockers)) {
    problems.push("Codex reported blockers");
  }
  if (String(result.fields.confidence ?? "").trim().toLowerCase() === "low") {
    problems.push("Codex reported low confidence");
  }

  return {
    verdict: problems.length ? "review" : "clean",
    problems,
    changed: attributable,
    preexisting,
    inScope,
    outOfScope,
    declared,
    undeclared,
    phantom,
    headChanged,
    result
  };
}

function isNone(value) {
  return ["none", "n/a", "na", "-"].includes(String(value).trim().toLowerCase());
}

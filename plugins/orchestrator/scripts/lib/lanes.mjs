import { loadLanesState, nowIso, updateLanesState, updateLocalState } from "./state.mjs";
import { normalizeChecks, normalizeSetup } from "./checks.mjs";

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function assertValidLaneName(name) {
  const value = String(name ?? "").trim();
  if (!NAME_PATTERN.test(value)) {
    throw new Error(
      `Invalid lane name "${name}". Use lowercase letters, digits, dot, dash, or underscore, starting with a letter or digit.`
    );
  }
  return value;
}

export function listLanes(cwd) {
  const { lanes } = loadLanesState(cwd);
  return Object.entries(lanes)
    .map(([name, lane]) => ({ name, ...lane }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function getLane(cwd, name) {
  const laneName = assertValidLaneName(name);
  const { lanes } = loadLanesState(cwd);
  const lane = lanes[laneName];
  if (!lane) {
    return null;
  }
  return { name: laneName, ...lane };
}

export function requireLane(cwd, name) {
  const lane = getLane(cwd, name);
  if (!lane) {
    const known = listLanes(cwd).map((entry) => entry.name);
    const hint = known.length ? ` Known lanes: ${known.join(", ")}.` : " No lanes exist yet.";
    throw new Error(`Unknown lane "${name}".${hint}`);
  }
  return lane;
}

function keep(key, value) {
  return value === undefined || value === null || (Array.isArray(value) && !value.length) ? {} : { [key]: value };
}

export function addLane(cwd, name, { description = "", scope = [], constraints = [], done = "", checks, setup } = {}) {
  const laneName = assertValidLaneName(name);
  updateLanesState(cwd, (state) => {
    const existing = state.lanes[laneName];
    state.lanes[laneName] = {
      description: description || existing?.description || "",
      scope: scope.length ? scope : existing?.scope ?? [],
      constraints: constraints.length ? constraints : existing?.constraints ?? [],
      done: done || existing?.done || "",
      // Omitted keeps what the lane has; an empty list or null removes it.
      ...keep("checks", checks === undefined ? existing?.checks : normalizeChecks(checks ?? [])),
      ...keep("setup", setup === undefined ? existing?.setup : normalizeSetup(setup)),
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso()
    };
  });
  return getLane(cwd, laneName);
}

export function removeLane(cwd, name) {
  const laneName = assertValidLaneName(name);
  let removed = false;
  updateLanesState(cwd, (state) => {
    if (state.lanes[laneName]) {
      delete state.lanes[laneName];
      removed = true;
    }
  });
  if (!removed) {
    return false;
  }
  // Thread bindings and snapshots were written only by the retired
  // `/orchestrator:do` path. The local file keeps its schema so state written by
  // older releases still loads; removing a lane still clears its stale entries.
  updateLocalState(cwd, (local) => {
    delete local.threads[laneName];
    delete local.snapshots[laneName];
  });
  return true;
}

import { loadLanesState, loadLocalState, nowIso, updateLanesState, updateLocalState } from "./state.mjs";

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
  const local = loadLocalState(cwd);
  return Object.entries(lanes)
    .map(([name, lane]) => ({
      name,
      ...lane,
      threadId: local.threads[name]?.threadId ?? null,
      threadBoundAt: local.threads[name]?.updatedAt ?? null
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function getLane(cwd, name) {
  const laneName = assertValidLaneName(name);
  const { lanes } = loadLanesState(cwd);
  const lane = lanes[laneName];
  if (!lane) {
    return null;
  }
  const local = loadLocalState(cwd);
  return {
    name: laneName,
    ...lane,
    threadId: local.threads[laneName]?.threadId ?? null,
    threadBoundAt: local.threads[laneName]?.updatedAt ?? null
  };
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

export function addLane(cwd, name, { description = "", scope = [], constraints = [], done = "" } = {}) {
  const laneName = assertValidLaneName(name);
  updateLanesState(cwd, (state) => {
    const existing = state.lanes[laneName];
    state.lanes[laneName] = {
      description: description || existing?.description || "",
      scope: scope.length ? scope : existing?.scope ?? [],
      constraints: constraints.length ? constraints : existing?.constraints ?? [],
      done: done || existing?.done || "",
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
  updateLocalState(cwd, (local) => {
    delete local.threads[laneName];
    delete local.snapshots[laneName];
  });
  return true;
}

/**
 * Bind a Codex thread to a lane on this machine. This is the pointer the upstream
 * plugin drops on SessionEnd; keeping it is the whole point of lanes.
 */
export function bindThread(cwd, name, threadId) {
  const laneName = assertValidLaneName(name);
  const id = String(threadId ?? "").trim();
  if (!id) {
    throw new Error("A thread id is required to bind a lane.");
  }
  updateLocalState(cwd, (local) => {
    local.threads[laneName] = { threadId: id, updatedAt: nowIso() };
  });
  return { lane: laneName, threadId: id };
}

export function unbindThread(cwd, name) {
  const laneName = assertValidLaneName(name);
  updateLocalState(cwd, (local) => {
    delete local.threads[laneName];
  });
  return { lane: laneName };
}

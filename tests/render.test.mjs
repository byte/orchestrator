import assert from "node:assert/strict";
import { test } from "node:test";

import { renderPreflight } from "../plugins/orchestrator/scripts/lib/render.mjs";

test("preflight distinguishes optional legacy integration from blocking failures", () => {
  const report = {
    ok: false,
    checks: [
      {
        id: "codex-plugin",
        label: "Legacy Codex bridge installed (optional)",
        ok: false,
        optional: true,
        detail: "not installed"
      },
      {
        id: "codex-auth",
        label: "Codex authenticated",
        ok: false,
        detail: "not logged in",
        remedy: "!codex login"
      }
    ],
    blocking: [
      {
        id: "codex-auth",
        label: "Codex authenticated",
        remedy: "!codex login"
      }
    ]
  };
  const output = renderPreflight(report);
  assert.match(output, /optional  Legacy Codex bridge/);
  assert.doesNotMatch(output, /MISSING  Legacy Codex bridge/);
  assert.match(output, /MISSING  Codex authenticated/);
});

test("preflight shows an uncommitted checkout as a warning, not a blocker", async () => {
  const { preflight } = await import("../plugins/orchestrator/scripts/lib/preflight.mjs");
  const { makeRepo, cleanup, write } = await import("./helpers.mjs");
  const root = makeRepo();
  try {
    write(root, "notes.md", "draft\n");
    const report = preflight(root);
    const check = report.checks.find((entry) => entry.id === "clean_checkout");
    assert.equal(check.ok, false);
    assert.equal(check.warning, true);
    assert.ok(!report.blocking.some((entry) => entry.id === "clean_checkout"));
    assert.match(renderPreflight(report), /warn  Checkout clean — 1 uncommitted file; read and verify tasks run as is/);
  } finally {
    cleanup(root);
  }
});

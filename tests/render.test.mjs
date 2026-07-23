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

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  matchesScope,
  overlappingPatterns,
  partitionByScope,
  patternsMayOverlap,
  scopeCovers
} from "../plugins/orchestrator/scripts/lib/glob.mjs";

test("* does not cross path separators", () => {
  assert.equal(matchesScope("src/a.js", ["src/*.js"]), true);
  assert.equal(matchesScope("src/deep/a.js", ["src/*.js"]), false);
});

test("** crosses path separators", () => {
  assert.equal(matchesScope("src/deep/nested/a.js", ["src/**"]), true);
  assert.equal(matchesScope("src/a.js", ["src/**"]), true);
});

test("**/ matches zero path segments", () => {
  assert.equal(matchesScope("src/a.js", ["src/**/a.js"]), true);
  assert.equal(matchesScope("src/deep/a.js", ["src/**/a.js"]), true);
});

test("? matches exactly one non-separator character", () => {
  assert.equal(matchesScope("a1.js", ["a?.js"]), true);
  assert.equal(matchesScope("a12.js", ["a?.js"]), false);
  assert.equal(matchesScope("a/1.js", ["a?1.js"]), false);
});

test("a trailing slash matches everything beneath a directory", () => {
  assert.equal(matchesScope("docs/guide/intro.md", ["docs/"]), true);
  assert.equal(matchesScope("docsy/intro.md", ["docs/"]), false);
});

test("later patterns win, so negation carves out exclusions", () => {
  const scope = ["src/**", "!src/generated/**"];
  assert.equal(matchesScope("src/app.js", scope), true);
  assert.equal(matchesScope("src/generated/api.js", scope), false);
});

test("a negation followed by a re-include is honoured in order", () => {
  const scope = ["src/**", "!src/generated/**", "src/generated/keep.js"];
  assert.equal(matchesScope("src/generated/keep.js", scope), true);
  assert.equal(matchesScope("src/generated/other.js", scope), false);
});

test("regex metacharacters in patterns are literal", () => {
  assert.equal(matchesScope("a.b.js", ["a.b.js"]), true);
  assert.equal(matchesScope("axbxjs", ["a.b.js"]), false);
  assert.equal(matchesScope("cost(1).txt", ["cost(1).txt"]), true);
});

test("an empty scope list matches nothing", () => {
  assert.equal(matchesScope("anything.js", []), false);
});

test("windows separators in patterns and ./ prefixes normalize", () => {
  assert.equal(matchesScope("src/a.js", ["src\\*.js"]), true);
  assert.equal(matchesScope("./src/a.js", ["src/*.js"]), true);
});

test("a backslash in a path is a filename character, not a separator", () => {
  // git reports "src\\outside.txt" for a root-level file of that name.
  assert.equal(matchesScope("src\\outside.txt", ["src/**"]), false);
  assert.equal(matchesScope("src\\outside.txt", ["src/*"]), false);
});

test("partitionByScope splits on the same rules", () => {
  const { inScope, outOfScope } = partitionByScope(
    ["src/a.js", "docs/b.md", "src/generated/c.js"],
    ["src/**", "!src/generated/**"]
  );
  assert.deepEqual(inScope, ["src/a.js"]);
  assert.deepEqual(outOfScope, ["docs/b.md", "src/generated/c.js"]);
});

test("pattern overlap is exact for literal paths and conservative for globs", () => {
  assert.equal(patternsMayOverlap("lib/helper.js", "lib/**"), true);
  assert.equal(patternsMayOverlap("lib/helper.js", "src/**"), false);
  assert.equal(patternsMayOverlap("lib/a.js", "lib/b.js"), false);
  assert.equal(patternsMayOverlap("lib/*.js", "lib/**"), true);
  assert.equal(patternsMayOverlap("lib/", "lib/deep/x.ts"), true);
  assert.equal(patternsMayOverlap("src/**", "lib/**"), false);
  // Divergent literal suffixes cannot match the same path.
  assert.equal(patternsMayOverlap("src/*.js", "src/*.css"), false);
  // Unprovable cases are reported as overlapping.
  assert.equal(patternsMayOverlap("src/*/a.js", "src/x/*"), true);
  // Negations only narrow a surface and are ignored.
  assert.deepEqual(overlappingPatterns("lib/a.js", ["src/**", "!lib/a.js", "lib/**"]), ["lib/**"]);
});

test("scope coverage proves containment or reports it as not covered", () => {
  assert.equal(scopeCovers(["src/**", "lib/**"], "lib/helper.js"), true);
  assert.equal(scopeCovers(["src/**"], "lib/helper.js"), false);
  assert.equal(scopeCovers(["src/**"], "src/deep/*.js"), true);
  assert.equal(scopeCovers(["src/"], "src/**"), true);
  assert.equal(scopeCovers(["src/*.js"], "src/*.js"), true);
  assert.equal(scopeCovers(["src/*.js"], "src/**"), false);
  assert.equal(scopeCovers(["src/**", "!src/secret/**"], "src/secret/key.js"), false);
  assert.equal(scopeCovers(["src/**", "!src/secret/**"], "src/*.js"), false);
  assert.equal(scopeCovers([], "src/a.js"), false);
});

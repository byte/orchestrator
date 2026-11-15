/**
 * Minimal glob matching for scope patterns. No dependencies by design.
 *
 * Supported:
 *   *   - any run of characters except "/"
 *   **  - any run of characters including "/"
 *   ?   - a single character except "/"
 *   !   - leading negation on a pattern
 *
 * A pattern ending in "/" matches everything beneath that directory.
 */

const SPECIAL = /[.+^${}()|[\]\\]/g;

export function globToRegExp(pattern) {
  let source = pattern;
  if (source.endsWith("/")) {
    source += "**";
  }

  let out = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "*") {
      if (source[index + 1] === "*") {
        // "**/" should also match zero path segments, so a/**/b matches a/b.
        if (source[index + 2] === "/") {
          out += "(?:.*/)?";
          index += 2;
          continue;
        }
        out += ".*";
        index += 1;
        continue;
      }
      out += "[^/]*";
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    out += char.replace(SPECIAL, "\\$&");
  }

  return new RegExp(`^${out}$`);
}

function normalize(filePath) {
  return String(filePath).replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Match a path against an ordered pattern list. Later patterns win, so a
 * negation can carve an exclusion out of a broad include.
 * An empty pattern list matches nothing — scope must be stated explicitly.
 */
export function matchesScope(filePath, patterns = []) {
  const candidate = normalize(filePath);
  let matched = false;

  for (const raw of patterns) {
    const pattern = String(raw).trim();
    if (!pattern) {
      continue;
    }
    const negated = pattern.startsWith("!");
    const body = negated ? pattern.slice(1) : pattern;
    if (globToRegExp(normalize(body)).test(candidate)) {
      matched = !negated;
    }
  }

  return matched;
}

const GLOB_CHARS = /[*?]/;

function normalizePattern(pattern) {
  const body = normalize(String(pattern).trim());
  return body.endsWith("/") ? `${body}**` : body;
}

function literalPrefix(pattern) {
  const index = pattern.search(GLOB_CHARS);
  return index === -1 ? pattern : pattern.slice(0, index);
}

function literalSuffix(pattern) {
  const match = /[*?]([^*?]*)$/.exec(pattern);
  return match ? match[1] : pattern;
}

/**
 * Whether two positive scope patterns could match a common path. A literal path
 * is matched against the other pattern exactly. For two globs this is a
 * conservative check: they are disjoint only when their literal prefixes or
 * literal suffixes diverge, otherwise they are reported as overlapping. A false
 * "overlap" refuses a grant the supervisor can rephrase; a false "disjoint"
 * would let two workers write the same file, so the check errs one way only.
 */
export function patternsMayOverlap(left, right) {
  const a = normalizePattern(left);
  const b = normalizePattern(right);
  if (!a || !b) {
    return false;
  }
  if (!GLOB_CHARS.test(a)) {
    return globToRegExp(b).test(a);
  }
  if (!GLOB_CHARS.test(b)) {
    return globToRegExp(a).test(b);
  }
  const [prefixA, prefixB] = [literalPrefix(a), literalPrefix(b)];
  if (!prefixA.startsWith(prefixB) && !prefixB.startsWith(prefixA)) {
    return false;
  }
  const [suffixA, suffixB] = [literalSuffix(a), literalSuffix(b)];
  return suffixA.endsWith(suffixB) || suffixB.endsWith(suffixA);
}

/** Every positive pattern of `patterns` that may overlap `pattern`. Negations only narrow a surface, so they are ignored. */
export function overlappingPatterns(pattern, patterns = []) {
  return patterns
    .map((entry) => String(entry).trim())
    .filter((entry) => entry && !entry.startsWith("!") && patternsMayOverlap(pattern, entry));
}

/**
 * Whether `patterns` (an ordered scope list, negations allowed) certainly covers
 * every path `pattern` can match. A literal path is checked exactly. A glob is
 * covered only by a positive pattern that is identical to it or a `<dir>/**`
 * ancestor of its literal prefix, with no later negation that could carve part
 * of it out. Anything this cannot prove is reported as not covered.
 */
export function scopeCovers(patterns = [], pattern) {
  const target = normalizePattern(pattern);
  if (!target) {
    return false;
  }
  if (!GLOB_CHARS.test(target)) {
    return matchesScope(target, patterns);
  }
  let covered = false;
  for (const raw of patterns) {
    const entry = String(raw).trim();
    if (!entry) {
      continue;
    }
    if (entry.startsWith("!")) {
      if (covered && patternsMayOverlap(entry.slice(1), target)) {
        covered = false;
      }
      continue;
    }
    const outer = normalizePattern(entry);
    const base = outer.endsWith("**") ? outer.slice(0, -2) : null;
    if (outer === target ||
        (base !== null && !GLOB_CHARS.test(base) && (base === "" || base.endsWith("/")) &&
          literalPrefix(target).startsWith(base))) {
      covered = true;
    }
  }
  return covered;
}

export function partitionByScope(filePaths, patterns = []) {
  const inScope = [];
  const outOfScope = [];
  for (const filePath of filePaths) {
    (matchesScope(filePath, patterns) ? inScope : outOfScope).push(filePath);
  }
  return { inScope, outOfScope };
}

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

export function partitionByScope(filePaths, patterns = []) {
  const inScope = [];
  const outOfScope = [];
  for (const filePath of filePaths) {
    (matchesScope(filePath, patterns) ? inScope : outOfScope).push(filePath);
  }
  return { inScope, outOfScope };
}

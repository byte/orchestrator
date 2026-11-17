export const REDACTION_VERSION = 4;
export const SUPPORTED_REDACTION_VERSIONS = Object.freeze([1, 2, 3, REDACTION_VERSION]);

function redactAssignments(text) {
  // Consume complete assignments in the ORIGINAL text, left to right. A quoted
  // value can contain a YAML-looking header and a block can contain unmatched
  // quotes; neither may destroy the other's boundaries or a sibling assignment.
  // Supported YAML blocks: direct mapping/sequence keys, |/>, indentation and
  // chomping indicators, comments, and space-indented bodies (not general YAML).
  const block = /^(?<indent> *)(?<sequence>- +)?(?<blockQuote>["']?)(?<blockKey>api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret|aws_secret_access_key)\k<blockQuote>[ \t]*:[ \t]*[|>](?:[1-9][+-]?|[+-][1-9]?)?[ \t]*(?:#[^\r\n]*)?(?<eol>\r?\n|$)/;
  // Unquoted values are whitespace-delimited or bounded by quotes/backticks,
  // except two values that contain whitespace by design and must be consumed
  // whole: a PEM private key (to its END line, or to the end of the text when
  // it has none) and an HTTP auth scheme with its token.
  // URL query assignments retain their own &/# boundaries in RULES instead.
  const assignment = /(?<![\w?&])(?<key>api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret|aws_secret_access_key)(?<keyQuote>["']?)\s*[:=](?:\s*(?:"(?:\\[\s\S]|[^"\\])*"|'(?:''|\\[\s\S]|[^'\\])*')|\s*(?<pem>-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----(?:[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----|[\s\S]*))|[ \t]*(?<scheme>(?:Bearer|Basic)[ \t]+[^\s"'`]+)|[ \t]*[^\s"'`]+)/;
  const pattern = new RegExp(`${block.source}|${assignment.source}`, "gim");
  const output = [];
  const findings = {};
  let offset = 0;
  let match;
  while ((match = pattern.exec(text))) {
    const { indent, sequence = "", blockKey, eol, key, keyQuote, pem, scheme } = match.groups;
    let type = "credential";
    let replacement;
    if (blockKey) {
      const indentation = indent.length + sequence.length;
      let end = pattern.lastIndex;
      while (end < text.length) {
        const newline = text.indexOf("\n", end);
        const lineEnd = newline === -1 ? text.length : newline + 1;
        const line = text.slice(end, lineEnd);
        if (line.trim() && /^ */.exec(line)[0].length <= indentation) {
          break;
        }
        // Conservatively consume deeper lines even if an explicit indentation
        // indicator would make this a malformed scalar.
        end = lineEnd;
      }
      pattern.lastIndex = end;
      replacement = `${indent}${sequence}${blockKey}=<redacted:credential>${eol}`;
    } else {
      // Keep the specific categories the token rules would have reported.
      if (pem) {
        type = "private_key";
      } else if (scheme) {
        type = "authorization";
      } else if (key.toLowerCase() === "aws_secret_access_key" && !keyQuote) {
        type = "aws_secret_key";
      }
      replacement = `${key}=<redacted:${type}>`;
    }
    output.push(text.slice(offset, match.index), replacement);
    offset = pattern.lastIndex;
    findings[type] = (findings[type] ?? 0) + 1;
  }
  output.push(text.slice(offset));
  return { text: output.join(""), findings };
}

const RULES = Object.freeze([
  {
    type: "private_key",
    pattern: /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g,
    replacement: "<redacted:private_key>"
  },
  {
    type: "openai_key",
    pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    replacement: "<redacted:openai_key>"
  },
  {
    type: "github_token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    replacement: "<redacted:github_token>"
  },
  {
    type: "aws_access_key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: "<redacted:aws_access_key>"
  },
  {
    type: "google_api_key",
    pattern: /\bAIza[A-Za-z0-9_-]{24,}\b/g,
    replacement: "<redacted:google_api_key>"
  },
  {
    type: "slack_token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: "<redacted:slack_token>"
  },
  {
    type: "stripe_key",
    pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g,
    replacement: "<redacted:stripe_key>"
  },
  {
    type: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: "<redacted:jwt>"
  },
  {
    type: "authorization",
    pattern: /\b(?:Authorization\s*:\s*)?(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: "<redacted:authorization>"
  },
  {
    type: "url_credentials",
    pattern: /\b(https?):\/\/[^/\s:@]+:[^@\s/]+@/gi,
    replacement: (match, scheme) => `${scheme}://<redacted:url_credentials>@`
  },
  {
    type: "database_url_credentials",
    pattern: /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^/\s:@]+:[^@\s/]+@/gi,
    replacement: (match, scheme) => `${scheme}://<redacted:url_credentials>@`
  },
  {
    type: "sensitive_query",
    // Apostrophes are valid URL data. Generated credential markers are data too:
    // stopping at one would expose the remaining suffix of the query value.
    // A quote or backtick ends the value only where it plausibly closes the
    // surrounding string (before whitespace, punctuation, or the end): one
    // inside the value must not expose the rest of it.
    pattern: /([?&](?:token|api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|aws_secret_access_key)=)(?:[^&#\s"`]|["`](?![\s,;)}\]>]|$))+/gi,
    replacement: (match, prefix) => `${prefix}<redacted:sensitive_query>`
  },
  {
    type: "email",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    replacement: "<redacted:email>"
  },
  {
    type: "phone",
    pattern: /\+\d{1,3}[ .-]?(?:\(?\d{1,4}\)?[ .-]?){2,5}\d{2,4}\b/g,
    replacement: "<redacted:phone>"
  },
  {
    type: "ssn",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: "<redacted:ssn>"
  },
  {
    type: "ipv4",
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    shouldRedact: (match) => match.split(".").every((octet) => Number(octet) <= 255),
    replacement: "<redacted:ipv4>"
  },
  {
    type: "ipv6",
    pattern: /\b(?:[A-Fa-f0-9]{1,4}:){2,7}[A-Fa-f0-9]{0,4}\b/g,
    replacement: "<redacted:ipv6>"
  },
  {
    type: "home_path",
    pattern: /\/(?:Users|home)\/[A-Za-z0-9._-]+(?: [A-Za-z0-9._-]+)?(?:\/[A-Za-z0-9._+@%=-]+)+/g,
    replacement: "<redacted:home_path>"
  },
  {
    type: "absolute_path",
    pattern: /(?<![A-Za-z0-9])\/(?:root|private|tmp|var|etc|opt|workspace|srv|mnt)(?:\/[A-Za-z0-9._+@% -]+)+/g,
    replacement: "<redacted:absolute_path>"
  },
  {
    type: "windows_home_path",
    pattern: /\b[A-Za-z]:\\(?:Users\\)?[A-Za-z0-9._-]+(?:\\[A-Za-z0-9._+@%=-]+)+/g,
    replacement: "<redacted:home_path>"
  },
  {
    type: "unc_path",
    pattern: /\\\\[A-Za-z0-9._-]+\\[A-Za-z0-9.$_-]+(?:\\[A-Za-z0-9._+@%=$-]+)+/g,
    replacement: "<redacted:unc_path>"
  }
]);

export function redactText(value) {
  const assignments = redactAssignments(String(value ?? ""));
  let text = assignments.text;
  const findings = assignments.findings;
  for (const rule of RULES) {
    text = text.replace(rule.pattern, (...args) => {
      if (rule.shouldRedact && !rule.shouldRedact(args[0])) {
        return args[0];
      }
      findings[rule.type] = (findings[rule.type] ?? 0) + 1;
      return typeof rule.replacement === "function"
        ? rule.replacement(...args)
        : rule.replacement;
    });
  }
  return { text, findings };
}

export function redactTextFields(source, fields) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("Text redaction source must be an object.");
  }
  if (!Array.isArray(fields)) {
    throw new Error("Text redaction fields must be an array.");
  }
  const text = {};
  const findings = {};
  for (const field of [...new Set(fields)]) {
    if (typeof field !== "string" || !field) {
      throw new Error("Text redaction field names must be non-empty strings.");
    }
    if (!Object.hasOwn(source, field)) {
      continue;
    }
    const redacted = redactText(source[field]);
    text[field] = redacted.text;
    for (const [type, count] of Object.entries(redacted.findings)) {
      findings[type] = (findings[type] ?? 0) + count;
    }
  }
  return { text, findings };
}

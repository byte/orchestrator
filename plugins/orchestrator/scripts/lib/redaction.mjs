export const REDACTION_VERSION = 2;
export const SUPPORTED_REDACTION_VERSIONS = Object.freeze([1, REDACTION_VERSION]);

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
    type: "aws_secret_key",
    pattern: /\baws_secret_access_key\s*[:=]\s*["']?[A-Za-z0-9/+=]{32,}["']?/gi,
    replacement: "aws_secret_access_key=<redacted:aws_secret_key>"
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
    pattern: /([?&](?:token|api[_-]?key|secret|password)=)[^&#\s]+/gi,
    replacement: (match, prefix) => `${prefix}<redacted:sensitive_query>`
  },
  {
    type: "credential",
    pattern: /\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret)\s*[:=]\s*["']?[A-Za-z0-9+/_=-]{8,}["']?/gi,
    replacement: (match, key) => `${key}=<redacted:credential>`
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
  let text = String(value ?? "");
  const findings = {};
  for (const rule of RULES) {
    let count = 0;
    text = text.replace(rule.pattern, (...args) => {
      if (rule.shouldRedact && !rule.shouldRedact(args[0])) {
        return args[0];
      }
      count += 1;
      return typeof rule.replacement === "function"
        ? rule.replacement(...args)
        : rule.replacement;
    });
    if (count > 0) {
      findings[rule.type] = count;
    }
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

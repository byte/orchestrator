/**
 * Tiny argv parser. Repeatable options collect into arrays so `--scope a --scope b`
 * reads naturally for lane definitions.
 */
export function parseArgs(
  argv,
  { booleanOptions = [], repeatableOptions = [], valueOptions = [] } = {}
) {
  const options = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const body = token.slice(2);
    const equals = body.indexOf("=");
    const key = equals === -1 ? body : body.slice(0, equals);
    let value = equals === -1 ? null : body.slice(equals + 1);
    const known = booleanOptions.includes(key) ||
      repeatableOptions.includes(key) ||
      valueOptions.includes(key);
    if (!known) {
      throw new Error(`Unknown option --${key}.`);
    }

    if (booleanOptions.includes(key)) {
      if (value !== null) {
        throw new Error(`Boolean option --${key} does not take a value.`);
      }
      options[key] = true;
      continue;
    }

    if (value === null) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`Option --${key} requires a value.`);
      }
      value = next;
      index += 1;
    }

    if (repeatableOptions.includes(key)) {
      options[key] = [...(options[key] ?? []), value];
      continue;
    }

    options[key] = value;
  }

  return { options, positionals };
}

export function splitList(value) {
  if (value === undefined || value === null) {
    return [];
  }
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((entry) => String(entry).split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

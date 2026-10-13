function normalizePath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
}

function basenameKey(value) {
  const normalized = normalizePath(value);
  return normalized ? normalized.split("/").pop() : "";
}

function splitExtension(filename) {
  const index = filename.lastIndexOf(".");
  if (index <= 0) {
    return { stem: filename, ext: "" };
  }
  return {
    stem: filename.slice(0, index),
    ext: filename.slice(index),
  };
}

function stripConfiguredPostfix(filename, postfixes) {
  const { stem, ext } = splitExtension(filename);

  for (const postfix of postfixes || []) {
    const normalizedPostfix = String(postfix || "").trim().toLowerCase();
    if (!normalizedPostfix) continue;

    for (const separator of ["_", "-", ".", " "]) {
      const suffix = `${separator}${normalizedPostfix}`;
      if (stem.endsWith(suffix)) {
        return `${stem.slice(0, -suffix.length)}${ext}`;
      }
    }

    if (stem.endsWith(normalizedPostfix)) {
      return `${stem.slice(0, -normalizedPostfix.length)}${ext}`;
    }
  }

  return filename;
}

export function basenameVariants(value, postfixes = []) {
  const basename = basenameKey(value);
  if (!basename) return [];

  const variants = new Set([basename]);
  let current = basename;

  for (let i = 0; i < 5; i++) {
    const stripped = stripConfiguredPostfix(current, postfixes);
    variants.add(stripped);
    if (stripped === current) break;
    current = stripped;
  }

  return [...variants].filter(Boolean);
}

let defaultRules = { ignore_groups: [], aliases: {} };
let userRules = { ignore_tokens: [], aliases: {}, disabled_defaults: [] };
let ignoreRegex = null;
let aliasList = [];

function tokenize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileRules() {
  const disabled = new Set(userRules.disabled_defaults || []);
  const patterns = [];
  // user tokens first and longest first, so "comfy-org" wins over the built-in "comfy"
  const userTokens = (userRules.ignore_tokens || []).map(tokenize).filter(Boolean).sort((x, y) => y.length - x.length);
  for (const token of userTokens) patterns.push(escapeRegex(token));
  for (const group of defaultRules.ignore_groups || []) {
    if (group?.pattern && !disabled.has(group.id)) patterns.push(group.pattern);
  }
  ignoreRegex = patterns.length
    ? new RegExp(`(?:^|_)(?:(?:${patterns.join("|")})+)(?=_|$)`, "g")
    : null;

  aliasList = [];
  for (const [from, to] of Object.entries({ ...(defaultRules.aliases || {}), ...(userRules.aliases || {}) })) {
    const key = tokenize(from);
    if (key) aliasList.push([new RegExp(`(?:^|_)${escapeRegex(key)}(?=_|$)`, "g"), tokenize(to)]);
  }
}

export function setMatchingRules({ defaults, user } = {}) {
  if (defaults) defaultRules = { ignore_groups: [], aliases: {}, ...defaults };
  if (user) userRules = { ignore_tokens: [], aliases: {}, disabled_defaults: [], ...user };
  compileRules();
}

export function getMatchingRules() {
  return { defaults: defaultRules, user: userRules };
}

function applyAliases(stem) {
  let result = stem;
  for (const [regex, to] of aliasList) {
    result = result.replace(regex, (match) => (match.startsWith("_") ? "_" : "") + to);
  }
  return result;
}

function stemKey(filename) {
  return applyAliases(tokenize(splitExtension(filename).stem));
}

function stripIgnorable(stem) {
  if (!ignoreRegex) return stem;
  let core = stem;
  // repeat: adjacent tokens share the "_" boundary, so one pass can miss neighbours
  for (let i = 0; i < 3; i++) {
    ignoreRegex.lastIndex = 0;
    const next = core.replace(ignoreRegex, "");
    if (next === core) break;
    core = next;
  }
  return core;
}

// compact: stem without separators ("flux_dev" == "fluxdev");
// core: compact with quantization/precision tokens removed ("x_fp8_e4m3fn" == "x");
// sorted: core tokens in alphabetical order (word-order insensitive).
export function looseKeys(filename) {
  const stem = stemKey(filename);
  const core = stripIgnorable(stem);
  return {
    compact: stem.replace(/_/g, ""),
    core: core.replace(/_/g, ""),
    sorted: core.split("_").filter(Boolean).sort().join(""),
  };
}

const VERSION_LIKE = /^v?\d+$/;

// Derives a reusable rule from a manual before -> after replacement.
// Returns { ignore_tokens } or { aliases } or null when no safe general rule exists.
export function suggestRuleFromPair(before, after) {
  const b = looseKeys(basenameKey(before));
  const a = looseKeys(basenameKey(after));
  if (!b.compact || !a.compact || b.core === a.core || b.sorted === a.sorted) return null;

  const tokensOf = (value) => new Set(stripIgnorable(stemKey(basenameKey(value))).split("_").filter(Boolean));
  const tb = tokensOf(before);
  const ta = tokensOf(after);
  const onlyBefore = [...tb].filter((t) => !ta.has(t));
  const onlyAfter = [...ta].filter((t) => !tb.has(t));
  const extras = [...onlyBefore, ...onlyAfter];
  if (extras.length === 0 || extras.length > 3) return null;
  if (extras.some((t) => VERSION_LIKE.test(t) || /\d{3,}/.test(t))) return null;

  if (onlyBefore.length === 1 && onlyAfter.length === 1) {
    return { aliases: { [onlyBefore[0]]: onlyAfter[0] } };
  }
  return { ignore_tokens: extras };
}

// Higher is better; 0 means no match. `wantedVariants` come from basenameVariants().
export function looseMatchScore(wantedVariants, candidate, postfixes = []) {
  let best = 0;
  const candidateVariants = basenameVariants(candidate, postfixes);
  for (const wanted of wantedVariants) {
    const w = looseKeys(wanted);
    for (const variant of candidateVariants) {
      const c = looseKeys(variant);
      if (w.compact && w.compact === c.compact) best = Math.max(best, 3);
      else if (w.core && w.core === c.core) best = Math.max(best, 2);
      else if (w.sorted && w.sorted === c.sorted) best = Math.max(best, 1.5);
    }
  }
  return best;
}

function getMappingBefore(mapping) {
  return mapping?.before ?? mapping?.from ?? mapping?.old ?? mapping?.source;
}

function getMappingAfter(mapping) {
  return mapping?.after ?? mapping?.to ?? mapping?.new ?? mapping?.target;
}

export function describeMappings(mappings) {
  return (mappings || [])
    .filter((mapping) => mapping && typeof mapping === "object")
    .map((mapping) => ({
      before: getMappingBefore(mapping),
      after: getMappingAfter(mapping),
    }));
}

export function findMappingForPath(path, mappings, mode = "basename", options = {}) {
  if (!path || typeof path !== "string") {
    return null;
  }

  const normalizedPath = normalizePath(path);
  const pathBasenames = basenameVariants(path, options.postfixes || []);

  for (const mapping of mappings) {
    const before = getMappingBefore(mapping);
    const after = getMappingAfter(mapping);
    if (typeof before !== "string" || typeof after !== "string") continue;

    const mappingBefore = normalizePath(before);

    if (mode === "subpath" && mappingBefore === normalizedPath) {
      return after;
    }

    if (mappingBefore === normalizedPath) {
      return after;
    }

    if (mode === "basename" || mode === "auto") {
      const mappingBasenames = basenameVariants(before, options.postfixes || []);
      if (mappingBasenames.some((basename) => pathBasenames.includes(basename))) {
        return after;
      }
    }
  }

  return null;
}

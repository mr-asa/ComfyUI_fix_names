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

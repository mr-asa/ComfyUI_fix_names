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

export function findMappingForPath(path, mappings, mode = "basename") {
  if (!path || typeof path !== "string") {
    return null;
  }

  const normalizedPath = normalizePath(path);
  const pathBasename = basenameKey(path);

  for (const mapping of mappings) {
    if (!mapping || typeof mapping.before !== "string") continue;

    const mappingBefore = normalizePath(mapping.before);
    const mappingAfter = mapping.after;

    if (mode === "subpath" && mappingBefore === normalizedPath) {
      return mappingAfter;
    }

    if (mappingBefore === normalizedPath) {
      return mappingAfter;
    }

    if (mode === "basename" || mode === "auto") {
      const mappingBasename = basenameKey(mapping.before);
      if (mappingBasename && mappingBasename === pathBasename) {
        return mappingAfter;
      }
    }
  }

  return null;
}

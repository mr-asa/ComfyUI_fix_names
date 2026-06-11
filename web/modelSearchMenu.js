import { getAvailableModels, getMappings, getPostfixes } from "./mappingApi.js";
import { findMappingForPath } from "./pathResolver.js";
import { PATH_NODE_REGISTRY } from "./pathNodeRegistry.js";
import { getDiscoveredNodeEntryForNode } from "./nodeDiscovery.js";
import { autoResolveWidgetWithPostfixes } from "./workflowFixer.js";

const MODEL_FILE_EXTENSIONS = [
  ".safetensors",
  ".ckpt",
  ".pt",
  ".pth",
  ".bin",
  ".gguf",
];

const searchState = {
  mappings: [],
  availableModels: {},
  postfixes: [],
  loaded: false,
  loading: null,
};

function normalizePath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
}

function isLikelyModelPathValue(value) {
  const normalized = normalizePath(value);
  return MODEL_FILE_EXTENSIONS.some((ext) => normalized.endsWith(ext));
}

function basenameOnly(value) {
  const normalized = String(value || "").trim().replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() || normalized;
}

function getRuntimeWidgetOptions(widget) {
  const values = widget?.options?.values || widget?.options?.items || widget?.options;
  if (Array.isArray(values)) return values;
  return null;
}

function collectObjectModelValues(value, results = []) {
  if (typeof value === "string") {
    if (isLikelyModelPathValue(value)) {
      results.push({ value, options: null });
    }
    return results;
  }

  if (!value || typeof value !== "object") {
    return results;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectObjectModelValues(item, results);
    return results;
  }

  for (const item of Object.values(value)) {
    collectObjectModelValues(item, results);
  }
  return results;
}

function collectNodeModelValues(node) {
  const values = [];
  const seen = new Set();

  const pushValue = (value, options = null) => {
    if (typeof value !== "string" || !isLikelyModelPathValue(value)) return;
    const key = normalizePath(value);
    if (seen.has(key)) return;
    seen.add(key);
    values.push({ value, options });
  };

  for (const widget of node.widgets || []) {
    pushValue(widget.value, getRuntimeWidgetOptions(widget));
  }

  if (Array.isArray(node.widgets_values)) {
    for (const value of node.widgets_values) {
      if (typeof value === "string") {
        pushValue(value);
      } else {
        for (const item of collectObjectModelValues(value)) {
          pushValue(item.value, item.options);
        }
      }
    }
  } else {
    for (const item of collectObjectModelValues(node.widgets_values)) {
      pushValue(item.value, item.options);
    }
  }

  return values;
}

async function refreshSearchState() {
  searchState.loading = Promise.all([
    getMappings().catch(() => []),
    getAvailableModels().catch(() => ({})),
    getPostfixes().catch(() => []),
  ]).then(([mappings, availableModels, postfixes]) => {
    searchState.mappings = mappings;
    searchState.availableModels = availableModels;
    searchState.postfixes = postfixes;
    searchState.loaded = true;
  }).finally(() => {
    searchState.loading = null;
  });

  return searchState.loading;
}

export function warmModelSearchCache() {
  if (!searchState.loading) {
    refreshSearchState();
  }
}

function getRegistryEntryForNode(node) {
  return PATH_NODE_REGISTRY.find((entry) => entry.matches(node))
    || getDiscoveredNodeEntryForNode(node)
    || null;
}

function hasKnownMatch(item, registryEntry) {
  const mapping = findMappingForPath(item.value, searchState.mappings, "auto", {
    postfixes: searchState.postfixes,
  });
  if (mapping) return true;

  const autoMatch = autoResolveWidgetWithPostfixes(
    registryEntry,
    item.value,
    null,
    searchState.availableModels,
    searchState.postfixes,
    item.options,
  );
  return Boolean(autoMatch);
}

export function getUnmatchedModelBasenamesForNode(node) {
  const names = new Set();
  const registryEntry = getRegistryEntryForNode(node);
  for (const item of collectNodeModelValues(node)) {
    if (searchState.loaded && hasKnownMatch(item, registryEntry)) {
      continue;
    }
    const basename = basenameOnly(item.value);
    if (basename) {
      names.add(basename);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

export async function refreshAndGetUnmatchedModelBasenamesForNode(node) {
  if (searchState.loading) {
    await searchState.loading;
  } else {
    await refreshSearchState();
  }
  return getUnmatchedModelBasenamesForNode(node);
}

export function openModelSearch(modelName) {
  const query = encodeURIComponent(modelName);
  window.open(`https://www.google.com/search?q=${query}`, "_blank", "noopener,noreferrer");
}

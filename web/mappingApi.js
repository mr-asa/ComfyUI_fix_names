import { setMatchingRules } from "./pathResolver.js";

export async function getMappings() {
  const response = await fetch("/fix_model_paths/mappings", {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Unable to load mappings: ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

export async function saveMapping(before, after) {
  const response = await fetch("/fix_model_paths/mappings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ before, after }),
  });

  if (!response.ok) {
    throw new Error(`Unable to save mapping: ${response.status}`);
  }

  return response.json();
}

export async function validateWorkflow(prompt) {
  const response = await fetch("/fix_model_paths/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });

  if (!response.ok) {
    throw new Error(`Unable to validate workflow: ${response.status}`);
  }

  return response.json();
}

let availableModelsCache = null;

export async function getAvailableModels(forceRefresh = false) {
  if (availableModelsCache && !forceRefresh) {
    return availableModelsCache;
  }

  const response = await fetch("/fix_model_paths/available", {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Unable to fetch available models: ${response.status}`);
  }

  availableModelsCache = await response.json();
  return availableModelsCache;
}

export async function getNodeLibrary() {
  const response = await fetch("/fix_model_paths/node_library", {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Unable to load node library: ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

export async function saveNodeLibraryEntry(nodeType, modelType, widgets) {
  const response = await fetch("/fix_model_paths/node_library", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node_type: nodeType, model_type: modelType, widgets }),
  });

  if (!response.ok) {
    throw new Error(`Unable to save node library entry: ${response.status}`);
  }

  return response.json();
}

export async function logFixReport(report) {
  const response = await fetch("/fix_model_paths/log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(report),
  });

  if (!response.ok) {
    throw new Error(`Unable to write fix report: ${response.status}`);
  }

  return response.json();
}

export async function getPostfixes() {
  const response = await fetch("/fix_model_paths/postfixes", {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Unable to load postfixes: ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

export async function savePostfixes(postfixes) {
  const response = await fetch("/fix_model_paths/postfixes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ postfixes }),
  });

  if (!response.ok) {
    throw new Error(`Unable to save postfixes: ${response.status}`);
  }

  return response.json();
}

let defaultRulesPromise = null;

function loadDefaultRules() {
  if (!defaultRulesPromise) {
    defaultRulesPromise = fetch(new URL("./matchingRules.default.json", import.meta.url))
      .then((response) => (response.ok ? response.json() : {}))
      .catch(() => ({}));
  }
  return defaultRulesPromise;
}

export async function getUserMatchingRules() {
  const response = await fetch("/fix_model_paths/matching_rules", {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Unable to load matching rules: ${response.status}`);
  }

  return response.json();
}

export async function saveUserMatchingRules(rules) {
  const response = await fetch("/fix_model_paths/matching_rules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rules }),
  });

  if (!response.ok) {
    throw new Error(`Unable to save matching rules: ${response.status}`);
  }

  const data = await response.json();
  setMatchingRules({ user: data.rules });
  return data;
}

// Loads built-in + user rules and applies them to the matcher. Never throws.
export async function loadMatchingRules() {
  const [defaults, user] = await Promise.all([
    loadDefaultRules(),
    getUserMatchingRules().catch((err) => {
      console.warn("[Fix Model Paths] Failed to load user matching rules", err);
      return {};
    }),
  ]);
  setMatchingRules({ defaults, user });
}

export async function deleteMapping(before) {
  const response = await fetch("/fix_model_paths/mappings/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ before }),
  });

  if (!response.ok) {
    throw new Error(`Unable to delete mapping: ${response.status}`);
  }

  return response.json();
}

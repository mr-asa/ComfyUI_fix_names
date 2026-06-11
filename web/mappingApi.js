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

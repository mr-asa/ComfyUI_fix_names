import { app } from "/scripts/app.js";
import { saveMapping } from "./mappingApi.js";
import { offerRuleSuggestion } from "./matchingRulesUi.js";
import { PATH_NODE_REGISTRY } from "./pathNodeRegistry.js";

const pendingNodeFixes = new Map();
let readyIndicatorEl = null;
let cancelIndicatorEl = null;
let positionTimer = null;
export let lastCaptures = [];

export function captureNodeFix(node, widgetName, before) {
  const key = String(node.id);
  const existing = pendingNodeFixes.get(key);
  if (existing) {
    existing.push({ widgetName, before });
  } else {
    pendingNodeFixes.set(key, [{ widgetName, before }]);
  }
}

export function getPendingNodeFix(node) {
  return pendingNodeFixes.get(String(node.id)) || null;
}

export function hasPendingNodeFix(node) {
  return pendingNodeFixes.has(String(node.id));
}

export function clearPendingNodeFix(node) {
  pendingNodeFixes.delete(String(node.id));
}

export function cancelNodeFix(node) {
  clearPendingNodeFix(node);
  hideNodeReadyIndicator();
  return { cancelled: true, message: "Node fix cancelled" };
}

export function showNodeReadyIndicator(node, onSave, onCancel) {
  hideNodeReadyIndicator();

  readyIndicatorEl = document.createElement("button");
  readyIndicatorEl.type = "button";
  readyIndicatorEl.className = "fix-model-paths-ready";
  readyIndicatorEl.textContent = "Ready: Save Fixed";
  readyIndicatorEl.style.position = "absolute";
  readyIndicatorEl.style.zIndex = "9999";
  readyIndicatorEl.style.pointerEvents = "auto";

  readyIndicatorEl.addEventListener("click", async () => {
    if (typeof onSave === "function") {
      await onSave();
      return;
    }

    await saveFixedNode(node);
  });

  cancelIndicatorEl = document.createElement("button");
  cancelIndicatorEl.type = "button";
  cancelIndicatorEl.className = "fix-model-paths-ready fix-model-paths-cancel";
  cancelIndicatorEl.textContent = "Cancel Fix";
  cancelIndicatorEl.style.position = "absolute";
  cancelIndicatorEl.style.zIndex = "9999";
  cancelIndicatorEl.style.pointerEvents = "auto";
  cancelIndicatorEl.style.background = "#5c5c66";
  cancelIndicatorEl.style.borderColor = "#8a8a94";

  cancelIndicatorEl.addEventListener("click", async () => {
    if (typeof onCancel === "function") {
      await onCancel();
      return;
    }

    cancelNodeFix(node);
  });

  document.body.appendChild(readyIndicatorEl);
  document.body.appendChild(cancelIndicatorEl);
  positionNodeReadyIndicator(node);
  positionTimer = window.setInterval(() => positionNodeReadyIndicator(node), 100);
}

export function hideNodeReadyIndicator() {
  if (positionTimer) {
    window.clearInterval(positionTimer);
  }
  readyIndicatorEl?.remove();
  cancelIndicatorEl?.remove();
  readyIndicatorEl = null;
  cancelIndicatorEl = null;
  positionTimer = null;
}

function positionNodeReadyIndicator(node) {
  if (!readyIndicatorEl || !app?.canvas) {
    return;
  }

  const canvasEl = app.canvas.canvas;
  const rect = canvasEl?.getBoundingClientRect?.() || { left: 0, top: 0 };
  const scale = app.canvas.ds?.scale || 1;
  const offset = app.canvas.ds?.offset || [0, 0];
  const x = rect.left + (node.pos[0] + offset[0]) * scale + 12;
  const y = rect.top + (node.pos[1] + offset[1]) * scale + 12;

  readyIndicatorEl.style.position = "fixed";
  readyIndicatorEl.style.left = `${x}px`;
  readyIndicatorEl.style.top = `${y}px`;

  if (cancelIndicatorEl) {
    cancelIndicatorEl.style.position = "fixed";
    cancelIndicatorEl.style.left = `${x}px`;
    cancelIndicatorEl.style.top = `${y + 34}px`;
  }
}

function resolveWidgetValue(node, widgetName) {
  if (widgetName.startsWith("inline_")) {
    const idx = parseInt(widgetName.replace("inline_", ""), 10);
    if (Number.isInteger(idx) && Array.isArray(node.widgets_values)) {
      return node.widgets_values[idx];
    }
    return undefined;
  }

  const widget = node.widgets?.find((item) => item.name === widgetName);
  if (widget) {
    return widget.value ?? node.widgets_values?.[widget?.index ?? -1];
  }

  return undefined;
}

function setWidgetValue(node, widgetName, newValue) {
  if (widgetName.startsWith("inline_")) {
    const idx = parseInt(widgetName.replace("inline_", ""), 10);
    if (Number.isInteger(idx) && Array.isArray(node.widgets_values)) {
      node.widgets_values[idx] = newValue;
    }
    return;
  }

  const widget = node.widgets?.find((item) => item.name === widgetName);
  if (widget) {
    widget.value = newValue;
    if (typeof widget.callback === "function") {
      widget.callback(newValue);
    }
    const index = widget?.index;
    if (Array.isArray(node.widgets_values) && Number.isInteger(index)) {
      node.widgets_values[index] = newValue;
    }
  }
}

export function fixNode(node, pathWidgetNames, options = {}) {
  const captures = [];
  lastCaptures = [];

  for (const widgetName of pathWidgetNames) {
    const currentValue = resolveWidgetValue(node, widgetName);

    if (typeof currentValue !== "string") {
      continue;
    }

    captureNodeFix(node, widgetName, currentValue);
    captures.push({ widgetName, before: currentValue });
    lastCaptures.push({ widgetName, before: currentValue });
  }

  showNodeReadyIndicator(node, options.onSave, options.onCancel);

  return captures;
}

export async function saveFixedNode(node) {
  const pending = getPendingNodeFix(node);
  if (!pending || pending.length === 0) {
    return { saved: 0, message: "No pending node fix" };
  }

  const savedMappings = [];
  let anyChanged = false;

  for (const capture of pending) {
    const after = resolveWidgetValue(node, capture.widgetName);

    if (typeof after !== "string" || !after.trim()) {
      continue;
    }

    if (after === capture.before) {
      continue;
    }

    await saveMapping(capture.before, after);
    await offerRuleSuggestion(capture.before, after);
    savedMappings.push({ before: capture.before, after });
    setWidgetValue(node, capture.widgetName, after);
    anyChanged = true;
  }

  if (!anyChanged) {
    return { saved: 0, message: "No changes detected" };
  }

  clearPendingNodeFix(node);
  hideNodeReadyIndicator();
  if (node.flags) node.flags.error = false;
  app.canvas?.setDirty(true, true);

  const nodeType = node.type || node.comfyClass || "Unknown";
  const isUnknownNode = pending.length > 0 && !PATH_NODE_REGISTRY.find((e) => e.matches(node));

  const allAfter = savedMappings.map((m) => m.after);

  return {
    saved: savedMappings.length,
    message: `Saved ${savedMappings.length} path mapping(s)`,
    nodeType,
    isUnknownNode,
    captures: pending,
    mappings: savedMappings,
    after: allAfter[0],
  };
}

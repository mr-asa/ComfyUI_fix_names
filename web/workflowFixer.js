import { app } from "/scripts/app.js";
import { getMappings, validateWorkflow, getAvailableModels, logFixReport as sendFixReport } from "./mappingApi.js";
import { findMappingForPath } from "./pathResolver.js";
import { PATH_NODE_REGISTRY } from "./pathNodeRegistry.js";
import {
  getDiscoveredNodeEntryForNode,
  getDiscoveredWidgetDetailsForNode,
  getDiscoveredWidgetsForNode,
} from "./nodeDiscovery.js";

function basenameOnly(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .toLowerCase();
}

function normalizePath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
}

function isSkippablePathValue(value) {
  const normalized = normalizePath(value);
  return !normalized || normalized === "none" || normalized === "[none]" || normalized === "null";
}

function clearNodeErrors(node) {
  if (node.flags) {
    node.flags.error = false;
    node.flags.invalid = false;
  }
  node.has_errors = false;
  node.hasErrors = false;
  node.error = null;
  node.errors = null;
  node.execution_error = null;
  node.validation_error = null;
  node.validationErrors = null;
  node.widgets_errors = null;
  node.missing = null;
  node.invalid = false;
  delete node.errorMessage;
  delete node._errorMessage;
  delete node.title_text_color;
  if (node.widgets) {
    for (const w of node.widgets) {
      if (w.options?.element?.classList) {
        w.options.element.classList.remove("error", "comfy-error");
      }
      if (w?.domElement?.classList) {
        w.domElement.classList.remove("error", "comfy-error");
      }
    }
  }
  if (typeof node.setDirtyCanvas === "function") {
    node.setDirtyCanvas(true, true);
  }
  const nodeEl = document.querySelector(`[data-node-id="${node.id}"]`);
  if (nodeEl) {
    nodeEl.classList.remove("comfy-error", "error");
    for (const el of nodeEl.querySelectorAll(".comfy-error, .error")) {
      el.classList.remove("comfy-error", "error");
    }
    const borderEl = nodeEl.querySelector(".litegraph .litegraph.canvas");
    if (borderEl) borderEl.classList.remove("comfy-error", "error");
  }
}

function getNameIndexForSlot(registryEntry, slotIndex) {
  const slot = registryEntry?.valueSlots?.[slotIndex];
  return Number.isInteger(slot?.nameIdx) ? slot.nameIdx : null;
}

function setWidgetValue(node, widget, widgetName, newValue) {
  const widgetIndex = node.widgets?.findIndex((item) => item.name === widgetName);
  const detail = getDiscoveredWidgetDetailsForNode(node)
    .find((item) => item.widgetName === widgetName);
  const fallbackIndex = widgetIndex >= 0 ? widgetIndex : detail?.index;

  if (widget) {
    widget.value = newValue;
    if (typeof widget.callback === "function") {
      widget.callback(newValue);
    }

    const index = Number.isInteger(widget.index) ? widget.index : fallbackIndex;
    if (Array.isArray(node.widgets_values) && Number.isInteger(index)) {
      node.widgets_values[index] = newValue;
    }
    return;
  }

  const index = fallbackIndex;
  if (node.widgets && Number.isInteger(index) && index >= 0 && node.widgets[index]) {
    const resolvedWidget = node.widgets[index];
    resolvedWidget.value = newValue;
    if (typeof resolvedWidget.callback === "function") {
      resolvedWidget.callback(newValue);
    }
    if (Array.isArray(node.widgets_values)) {
      node.widgets_values[index] = newValue;
    }
    return;
  }

  if (Array.isArray(node.widgets_values) && Number.isInteger(index) && index >= 0) {
    node.widgets_values[index] = newValue;
  }
}

function clearAllNodeErrors() {
  for (const node of app.graph._nodes || []) {
    clearNodeErrors(node);
  }

  const allNodeEls = document.querySelectorAll("[data-node-id]");
  for (const el of allNodeEls) {
    el.classList.remove("error", "comfy-error");
    const canvasEl = el.querySelector(".litegraph");
    if (canvasEl) canvasEl.classList.remove("error", "comfy-error");
  }

  const allEls = document.querySelectorAll(".error, .comfy-error");
  for (const el of allEls) {
    el.classList.remove("error", "comfy-error");
  }

  app.canvas?.setDirty(true, true);
}

function createFixReport() {
  return {
    fixed: [],
    noMapping: [],
    noOp: [],
    skipped: [],
  };
}

function reportNoMapping(report, node, widgetName, value) {
  report?.noMapping.push({
    nodeId: node.id,
    nodeType: node.type,
    widget: widgetName,
    value,
  });
}

function reportNoOp(report, node, widgetName, value, replacement) {
  report?.noOp.push({
    nodeId: node.id,
    nodeType: node.type,
    widget: widgetName,
    value,
    replacement,
  });
}

function reportSkipped(report, node, widgetName, reason) {
  report?.skipped.push({
    nodeId: node.id,
    nodeType: node.type,
    widget: widgetName,
    reason,
  });
}

function logBrowserFixReport(report, remainingNodeErrors) {
  console.groupCollapsed(`[Fix Model Paths] Summary: fixed=${report.fixed.length}, noMapping=${report.noMapping.length}, noOp=${report.noOp.length}, skipped=${report.skipped.length}, remainingErrors=${Object.keys(remainingNodeErrors || {}).length}`);
  if (report.fixed.length > 0) {
    console.table(report.fixed);
  }
  if (report.noMapping.length > 0) {
    console.groupCollapsed("[Fix Model Paths] No mapping / no matching available model");
    console.table(report.noMapping);
    console.groupEnd();
  }
  if (report.noOp.length > 0) {
    console.groupCollapsed("[Fix Model Paths] Already correct / no-op");
    console.table(report.noOp);
    console.groupEnd();
  }
  if (report.skipped.length > 0) {
    console.groupCollapsed("[Fix Model Paths] Skipped");
    console.table(report.skipped);
    console.groupEnd();
  }
  console.groupEnd();
}

async function logServerFixReport(report, remainingNodeErrors) {
  try {
    await sendFixReport({
      ...report,
      remainingErrors: Object.keys(remainingNodeErrors || {}).length,
    });
  } catch (error) {
    console.warn("[Fix Model Paths] Failed to send server log report", error);
  }
}

function refreshNodeVisualState(node) {
  clearNodeErrors(node);

  try {
    if (typeof node.serialize === "function" && typeof node.configure === "function") {
      const serialized = node.serialize();
      node.configure(serialized);
      clearNodeErrors(node);
    }
  } catch (error) {
    console.log("[Fix Model Paths] Node visual refresh failed", node.id, node.type, error.message);
  }

  try {
    if (typeof node.updateOutputDisplay === "function") node.updateOutputDisplay();
    if (typeof node.onResize === "function") node.onResize();
    if (typeof node.recomputeIO === "function") node.recomputeIO();
  } catch {}

  app.canvas?.setDirty(true, true);
  if (typeof app.graph?.setDirtyCanvas === "function") {
    app.graph.setDirtyCanvas(true, true);
  }
}

function notifyGraphChanged() {
  try {
    if (typeof app.graph?.change === "function") {
      app.graph.change();
    }
  } catch (error) {
    console.debug("[Fix Model Paths] graph.change failed", error);
  }
}

export function autoResolveWidget(registryEntry, widgetValue, node, allAvailable) {
  const wanted = basenameOnly(widgetValue);
  if (!wanted) return null;

  if (registryEntry?.modelType) {
    const models = allAvailable?.[registryEntry.modelType];
    if (Array.isArray(models)) {
      const match = models.find((m) => basenameOnly(m) === wanted);
      if (match) return match;
    }
  }

  for (const models of Object.values(allAvailable || {})) {
    if (!Array.isArray(models)) continue;
    const match = models.find((m) => basenameOnly(m) === wanted);
    if (match) return match;
  }

  return null;
}

export function buildErrorWidgetMap(nodeErrors) {
  const map = new Map();

  for (const [nodeId, nodeError] of Object.entries(nodeErrors || {})) {
    const inputNames = new Set();
    let hasInputName = false;

    for (const reason of nodeError.errors || []) {
      const inputName = reason?.extra_info?.input_name;
      if (typeof inputName === "string") {
        hasInputName = true;
        inputNames.add(inputName);
      }
    }

    map.set(String(nodeId), { inputNames, hasInputName });
  }

  return map;
}

export function isWidgetInError(nodeId, widgetName, errorWidgetMap, pathWidgetCount) {
  const errorInfo = errorWidgetMap.get(String(nodeId));
  if (!errorInfo) {
    return false;
  }

  if (errorInfo.hasInputName) {
    return errorInfo.inputNames.has(widgetName);
  }

  return pathWidgetCount >= 1;
}

function registryWidgetsForNode(node, registryEntry) {
  const widgets = new Set(registryEntry?.widgets || []);

  for (const widgetName of getDiscoveredWidgetsForNode(node)) {
    widgets.add(widgetName);
  }

  return [...widgets];
}

function getPathWidgetValue(node, widgetName) {
  const widget = node.widgets?.find((item) => item.name === widgetName);
  if (widget) {
    const index = Number.isInteger(widget.index)
      ? widget.index
      : node.widgets?.indexOf(widget);
    return {
      widget,
      value: widget.value ?? node.widgets_values?.[index],
    };
  }

  const detail = getDiscoveredWidgetDetailsForNode(node)
    .find((item) => item.widgetName === widgetName);
  if (detail && Array.isArray(node.widgets_values)) {
    return {
      widget: null,
      value: node.widgets_values[detail.index],
    };
  }

  return {
    widget: null,
    value: undefined,
  };
}

export function scanGraphForPathWidgets(graph, mappings, options = {}) {
  const errorWidgetMap = options.nodeErrors
    ? buildErrorWidgetMap(options.nodeErrors)
    : new Map();
  const results = [];
  const matchMode = options.matchMode || "basename";
  const availableModels = options.availableModels || {};
  const report = options.report;

  for (const node of graph._nodes || []) {
    let registryEntry = PATH_NODE_REGISTRY.find((entry) => entry.matches(node));
    const discoveredEntry = getDiscoveredNodeEntryForNode(node);
    const discoveredWidgets = discoveredEntry?.widgets || [];

    if (!registryEntry && discoveredWidgets.length === 0) {
      continue;
    }

    if (!registryEntry) {
      registryEntry = discoveredEntry;
    }

    if (options.onlyErrorNodes && !errorWidgetMap.has(String(node.id))) {
      continue;
    }

    const pathWidgets = [];
    const effectiveWidgets = registryWidgetsForNode(node, registryEntry);

    for (const widgetName of effectiveWidgets) {
      const { widget, value } = getPathWidgetValue(node, widgetName);

      if (typeof value !== "string") {
        continue;
      }

      if (isSkippablePathValue(value)) {
        reportSkipped(report, node, widgetName, "empty/none value");
        continue;
      }

      pathWidgets.push({ widget, widgetName, value });
    }

    if (registryEntry?.getWidgetsFromValues && typeof registryEntry.getWidgetsFromValues === "function") {
      const specialValues = registryEntry.getWidgetsFromValues(node);
      const specialSlots = registryEntry.widgets;

      for (let i = 0; i < specialValues.length; i++) {
        const slotName = specialSlots[i];
        if (
          options.onlyErrorNodes &&
          !isWidgetInError(node.id, slotName, errorWidgetMap, specialValues.length)
        ) {
          continue;
        }

        let replacement = findMappingForPath(specialValues[i], mappings, matchMode);
        let autoResolved = false;

        if (!replacement && options.autoResolve) {
          replacement = autoResolveWidget(registryEntry, specialValues[i], node, availableModels);
          if (replacement) {
            autoResolved = true;
            console.log("[Fix Model Paths] Auto-resolved", specialValues[i], "->", replacement, "on node", node.id, node.type, "slot", slotName);
          }
        }

        if (!replacement) {
          if (!autoResolved) {
            console.debug("[Fix Model Paths] No mapping for", specialValues[i], "on node", node.id, node.type, "slot", slotName);
          }
          reportNoMapping(report, node, slotName, specialValues[i]);
          continue;
        }

        if (normalizePath(replacement) === normalizePath(specialValues[i])) {
          console.log("[Fix Model Paths] Skipping no-op for", specialValues[i], "on node", node.id, node.type, "slot", slotName);
          reportNoOp(report, node, slotName, specialValues[i], replacement);
          continue;
        }

        results.push({
          node,
          registryEntry,
          widget: null,
          widgetName: slotName,
          before: specialValues[i],
          after: replacement,
          autoResolved,
          isSpecialSlot: true,
          slotIndex: i,
        });
      }
      continue;
    }

    for (const pathWidget of pathWidgets) {
      if (
        options.onlyErrorNodes &&
        !isWidgetInError(
          node.id,
          pathWidget.widgetName,
          errorWidgetMap,
          pathWidgets.length,
        )
      ) {
        console.log("[Fix Model Paths] Skipping node", node.id, node.type, "widget", pathWidget.widgetName, "- not in errors");
        reportSkipped(report, node, pathWidget.widgetName, "not in validation errors");
        continue;
      }

      let replacement = findMappingForPath(pathWidget.value, mappings, matchMode);
      let autoResolved = false;

      if (!replacement && options.autoResolve) {
        replacement = autoResolveWidget(registryEntry, pathWidget.value, node, availableModels);
        if (replacement) {
          autoResolved = true;
          console.log("[Fix Model Paths] Auto-resolved", pathWidget.value, "->", replacement, "on node", node.id, node.type);
        }
      }

      if (!replacement) {
        if (!autoResolved) {
          console.debug("[Fix Model Paths] No mapping for", pathWidget.value, "on node", node.id, node.type);
        }
        reportNoMapping(report, node, pathWidget.widgetName, pathWidget.value);
        continue;
      }

      if (normalizePath(replacement) === normalizePath(pathWidget.value)) {
        console.log("[Fix Model Paths] Skipping no-op for", pathWidget.value, "on node", node.id, node.type);
        reportNoOp(report, node, pathWidget.widgetName, pathWidget.value, replacement);
        continue;
      }

      results.push({
        node,
        registryEntry,
        widget: pathWidget.widget,
        widgetName: pathWidget.widgetName,
        before: pathWidget.value,
        after: replacement,
        autoResolved,
      });
    }
  }

  return results;
}

export async function fixAllModelPaths() {
  const promptResult = await app.graphToPrompt();
  let validation;
  let validationError = null;

  try {
    validation = await validateWorkflow(promptResult.output);
  } catch (err) {
    console.warn("[Fix Model Paths] Validate endpoint failed, falling back to scan without error filter", err);
    validationError = err;
    validation = { valid: false, node_errors: {} };
  }

  if (!validationError && validation.valid) {
    console.log("[Fix Model Paths] Workflow already validates, nothing to fix");
    return { fixed: 0, remainingNodeErrors: {}, message: "Workflow already validates" };
  }

  const hasNodeErrors = Object.keys(validation.node_errors || {}).length > 0;
  const onlyErrorNodes = !validationError && hasNodeErrors;

  console.log("[Fix Model Paths] Validate result:", {
    valid: validation.valid,
    errorCount: Object.keys(validation.node_errors || {}).length,
    onlyErrorNodes,
  });

  const [mappings, availableModels] = await Promise.all([
    getMappings(),
    getAvailableModels().catch((err) => {
      console.warn("[Fix Model Paths] Failed to fetch available models for auto-resolve", err);
      return {};
    }),
  ]);

  console.log("[Fix Model Paths] Mappings loaded:", mappings.length);

  const report = createFixReport();
  const fixes = scanGraphForPathWidgets(app.graph, mappings, {
    onlyErrorNodes,
    nodeErrors: validation.node_errors,
    matchMode: "auto",
    autoResolve: true,
    availableModels,
    report,
  });

  console.log("[Fix Model Paths] Fixes found:", fixes.length, fixes);

  const autoResolvedFixes = [];

  for (const fix of fixes) {
    if (fix.isSpecialSlot) {
      const nameIdx = getNameIndexForSlot(fix.registryEntry, fix.slotIndex);
      console.log("[Fix Model Paths] Applying special slot fix:", {
        nodeType: fix.node.type,
        slotIndex: fix.slotIndex,
        nameIdx,
        before: fix.before,
        after: fix.after,
        widgets_values_len: fix.node.widgets_values?.length,
        node_widgets_count: fix.node.widgets?.length,
      });
      if (Number.isInteger(nameIdx) && Array.isArray(fix.node.widgets_values)) {
        fix.node.widgets_values[nameIdx] = fix.after;
        if (fix.node.widgets && fix.node.widgets[nameIdx]) {
          const w = fix.node.widgets[nameIdx];
          w.value = fix.after;
          if (typeof w.callback === "function") {
            w.callback(fix.after);
          }
        }
        console.log("[Fix Model Paths] Set widgets_values[" + nameIdx + "] =", fix.after);
      }
    } else {
      setWidgetValue(fix.node, fix.widget, fix.widgetName, fix.after);
    }

    report.fixed.push({
      nodeId: fix.node.id,
      nodeType: fix.node.type,
      widget: fix.widgetName,
      before: fix.before,
      after: fix.after,
      source: fix.autoResolved ? "auto-resolve" : "mapping",
    });

    clearNodeErrors(fix.node);

    if (fix.autoResolved) {
      autoResolvedFixes.push(fix);
    }
  }

  const fixedNodeIds = new Set();
  for (const fix of fixes) {
    if (fix.node) {
      fixedNodeIds.add(String(fix.node.id));
      try {
        if (typeof fix.node.updateOutputDisplay === "function") fix.node.updateOutputDisplay();
        if (typeof fix.node.onResize === "function") fix.node.onResize();
        if (typeof fix.node.recomputeIO === "function") fix.node.recomputeIO();
      } catch {}
    }
  }

  for (const nodeId of fixedNodeIds) {
    const node = app.graph._nodes?.find((n) => String(n.id) === nodeId);
    if (node) clearNodeErrors(node);
  }

  app.canvas?.setDirty(true, true);
  if (typeof app.graph?.setDirtyCanvas === "function") {
    app.graph.setDirtyCanvas(true, true);
  }
  notifyGraphChanged();

  const nextPromptResult = await app.graphToPrompt();
  const nextValidation = await validateWorkflow(nextPromptResult.output);
  const remainingNodeIds = new Set(Object.keys(nextValidation.node_errors || {}));

  for (const nodeId of fixedNodeIds) {
    if (remainingNodeIds.has(String(nodeId))) {
      continue;
    }

    const node = app.graph._nodes?.find((n) => String(n.id) === nodeId);
    if (node) refreshNodeVisualState(node);
  }

  const resolvedNodeIds = new Set([...fixedNodeIds].filter((nodeId) => !remainingNodeIds.has(String(nodeId))));
  console.log("[Fix Model Paths] Locally refreshed resolved node visuals:", [...resolvedNodeIds]);

  app.canvas?.setDirty(true, true);
  notifyGraphChanged();
  logBrowserFixReport(report, nextValidation.node_errors || {});
  await logServerFixReport(report, nextValidation.node_errors || {});

  return {
    fixed: fixes.length,
    remainingNodeErrors: nextValidation.node_errors || {},
    message: fixes.length
      ? `Fixed ${fixes.length} path widget(s)`
      : "No mapped path fixes found for validation errors",
  };
}

import { app } from "/scripts/app.js";
import { getMappings, validateWorkflow, getAvailableModels, getPostfixes, logFixReport as sendFixReport } from "./mappingApi.js";
import { basenameVariants, describeMappings, findMappingForPath } from "./pathResolver.js";
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
  return (
    !normalized ||
    normalized === "none" ||
    normalized === "[none]" ||
    normalized === "null" ||
    normalized === "fixed" ||
    normalized === "randomize" ||
    normalized === "increment" ||
    normalized === "decrement"
  );
}

const MODEL_FILE_EXTENSIONS = [
  ".safetensors",
  ".ckpt",
  ".pt",
  ".pth",
  ".bin",
  ".gguf",
];

function isLikelyModelPathValue(value) {
  const text = String(value || "").trim();
  const normalized = normalizePath(text);
  if (!normalized || text.includes("\n") || normalized.startsWith("http://") || normalized.startsWith("https://")) {
    return false;
  }
  return MODEL_FILE_EXTENSIONS.some((ext) => normalized.endsWith(ext));
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
  if (typeof widgetName === "string" && widgetName.startsWith("object:")) {
    const path = widgetName
      .slice("object:".length)
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
    let cursor = node.widgets_values;
    for (let i = 0; i < path.length - 1; i++) {
      cursor = cursor?.[path[i]];
    }
    if (cursor && typeof cursor === "object" && path.length > 0) {
      cursor[path[path.length - 1]] = newValue;
    }
    return;
  }

  if (widgetName.startsWith("inline_")) {
    const index = parseInt(widgetName.replace("inline_", ""), 10);
    if (Array.isArray(node.widgets_values) && Number.isInteger(index)) {
      node.widgets_values[index] = newValue;
    }
    return;
  }

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
  return autoResolveWidgetWithPostfixes(registryEntry, widgetValue, node, allAvailable, []);
}

export function autoResolveWidgetWithPostfixes(registryEntry, widgetValue, node, allAvailable, postfixes = []) {
  const wantedVariants = basenameVariants(widgetValue, postfixes);
  if (wantedVariants.length === 0) return null;

  if (registryEntry?.modelType) {
    const models = allAvailable?.[registryEntry.modelType];
    if (Array.isArray(models)) {
      const match = models.find((m) => {
        const variants = basenameVariants(m, postfixes);
        return variants.some((variant) => wantedVariants.includes(variant));
      });
      if (match) return match;
    }
  }

  for (const models of Object.values(allAvailable || {})) {
    if (!Array.isArray(models)) continue;
    const match = models.find((m) => {
      const variants = basenameVariants(m, postfixes);
      return variants.some((variant) => wantedVariants.includes(variant));
    });
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

function objectPathToWidgetName(path) {
  return `object:${path.map((part) => encodeURIComponent(String(part))).join("/")}`;
}

function collectObjectStringWidgets(value, path = [], results = []) {
  if (typeof value === "string") {
    if (path.length > 1 && isLikelyModelPathValue(value)) {
      results.push({
        widget: null,
        widgetName: objectPathToWidgetName(path),
        displayWidgetName: path.join("."),
        value,
      });
    }
    return results;
  }

  if (!value || typeof value !== "object") {
    return results;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectObjectStringWidgets(item, [...path, index], results));
    return results;
  }

  for (const [key, item] of Object.entries(value)) {
    collectObjectStringWidgets(item, [...path, key], results);
  }

  return results;
}

function getObjectPathWidgets(node) {
  if (!node.widgets_values || typeof node.widgets_values !== "object") {
    return [];
  }
  return collectObjectStringWidgets(node.widgets_values);
}

function getGraphLink(graph, linkId) {
  if (linkId == null) return null;
  if (Array.isArray(graph.links)) {
    return graph.links.find((link) => link && link.id === linkId) || graph.links[linkId] || null;
  }
  return graph.links?.[linkId] || null;
}

function getNodeById(graph, nodeId) {
  return graph._nodes?.find((node) => String(node.id) === String(nodeId)) || null;
}

function collectGraphs(graph, seen = new Set()) {
  if (!graph || seen.has(graph)) {
    return [];
  }
  seen.add(graph);

  const graphs = [graph];
  for (const node of graph._nodes || []) {
    const candidates = [
      node.subgraph,
      node.graph,
      node.innerGraph,
      node.properties?.subgraph,
      node.properties?.graph,
    ];
    for (const candidate of candidates) {
      if (candidate?._nodes) {
        graphs.push(...collectGraphs(candidate, seen));
      }
    }
  }

  return graphs;
}

function findNodeInGraphs(graphs, nodeId) {
  for (const graph of graphs) {
    const node = getNodeById(graph, nodeId);
    if (node) return node;
  }
  return null;
}

function getLinkedSourceNode(graph, node, inputName) {
  const input = node.inputs?.find((item) => item.name === inputName);
  if (!input || input.link == null) {
    return null;
  }

  const link = getGraphLink(graph, input.link);
  const originId = link?.origin_id ?? link?.originId ?? link?.[1];
  return originId == null ? null : getNodeById(graph, originId);
}

function getLinkedStringWidgets(graph, targetNode, inputName) {
  const sourceNode = getLinkedSourceNode(graph, targetNode, inputName);
  if (!sourceNode) {
    return [];
  }

  const widgets = [];
  for (const widget of sourceNode.widgets || []) {
    const value = widget?.value;
    if (typeof value === "string" && !isSkippablePathValue(value)) {
      widgets.push({
        node: sourceNode,
        widget,
        widgetName: widget.name || widget.type || "value",
        value,
        sourceInputName: inputName,
        targetNode,
      });
    }
  }

  if (widgets.length === 0 && Array.isArray(sourceNode.widgets_values)) {
    for (let i = 0; i < sourceNode.widgets_values.length; i++) {
      const value = sourceNode.widgets_values[i];
      if (typeof value === "string" && !isSkippablePathValue(value)) {
        widgets.push({
          node: sourceNode,
          widget: null,
          widgetName: `inline_${i}`,
          value,
          sourceInputName: inputName,
          targetNode,
        });
      }
    }
  }

  if (widgets.length === 0) {
    for (const item of getObjectPathWidgets(sourceNode)) {
      widgets.push({
        node: sourceNode,
        widget: null,
        widgetName: item.widgetName,
        displayWidgetName: item.displayWidgetName,
        value: item.value,
        sourceInputName: inputName,
        targetNode,
      });
    }
  }

  return widgets;
}

export function scanGraphForPathWidgets(graph, mappings, options = {}) {
  const errorWidgetMap = options.nodeErrors
    ? buildErrorWidgetMap(options.nodeErrors)
    : new Map();
  const results = [];
  const matchMode = options.matchMode || "basename";
  const availableModels = options.availableModels || {};
  const report = options.report;

  const graphs = collectGraphs(graph);

  for (const localGraph of graphs) {
  for (const node of localGraph._nodes || []) {
    let registryEntry = PATH_NODE_REGISTRY.find((entry) => entry.matches(node));
    const discoveredEntry = getDiscoveredNodeEntryForNode(node);
    const discoveredWidgets = discoveredEntry?.widgets || [];

    const objectPathWidgets = getObjectPathWidgets(node);

    if (!registryEntry && discoveredWidgets.length === 0 && objectPathWidgets.length === 0) {
      continue;
    }

    if (!registryEntry) {
      registryEntry = discoveredEntry || { widgets: [], modelType: null };
    }

    const nodeIsInErrors = errorWidgetMap.has(String(node.id));

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

    if (options.onlyErrorNodes || registryEntry?.source === "discovered") {
      for (const objectWidget of objectPathWidgets) {
        pathWidgets.push(objectWidget);
      }
    }

    const errorInfo = errorWidgetMap.get(String(node.id));
    const linkedInputNames = errorInfo?.hasInputName
      ? [...errorInfo.inputNames].filter((name) => effectiveWidgets.includes(name))
      : [];
    const linkedInputNameSet = new Set();
    for (const inputName of linkedInputNames) {
      const linkedWidgets = getLinkedStringWidgets(localGraph, node, inputName);
      if (linkedWidgets.length === 0) {
        continue;
      }
      linkedInputNameSet.add(inputName);
      for (const linkedWidget of linkedWidgets) {
        pathWidgets.push({
          ...linkedWidget,
          widgetName: `${inputName} <- ${linkedWidget.displayWidgetName || linkedWidget.widgetName}`,
          linkedWidgetName: linkedWidget.widgetName,
          linkedInputName: inputName,
          isLinkedInput: true,
        });
      }
    }
    if (linkedInputNameSet.size > 0) {
      for (let i = pathWidgets.length - 1; i >= 0; i--) {
        if (!pathWidgets[i].isLinkedInput && linkedInputNameSet.has(pathWidgets[i].widgetName)) {
          pathWidgets.splice(i, 1);
        }
      }
    }

    if (registryEntry?.getWidgetsFromValues && typeof registryEntry.getWidgetsFromValues === "function") {
      const specialValues = registryEntry.getWidgetsFromValues(node);
      const specialSlots = registryEntry.widgets;

      for (let i = 0; i < specialValues.length; i++) {
        const slotName = specialSlots[i];
        const widgetIsInErrors = isWidgetInError(node.id, slotName, errorWidgetMap, specialValues.length);
        if (options.onlyErrorNodes && nodeIsInErrors && !widgetIsInErrors) {
          continue;
        }

        const specialValue = specialValues[i];
        const canResolveOutsideErrors = Boolean(options.allowGlobalAutoResolve);
        const canAttemptAutoResolve = !options.onlyErrorNodes || nodeIsInErrors || canResolveOutsideErrors;
        const canReportNoMapping = !options.onlyErrorNodes || nodeIsInErrors;
        let replacement = findMappingForPath(specialValue, mappings, matchMode, {
          postfixes: options.postfixes || [],
        });
        let autoResolved = false;

        if (!replacement && !isLikelyModelPathValue(specialValue)) {
          continue;
        }

        if (!replacement && options.autoResolve && canAttemptAutoResolve) {
          replacement = autoResolveWidgetWithPostfixes(registryEntry, specialValue, node, availableModels, options.postfixes || []);
          if (replacement) {
            autoResolved = true;
            console.log("[Fix Model Paths] Auto-resolved", specialValue, "->", replacement, "on node", node.id, node.type, "slot", slotName);
          }
        }

        if (!replacement) {
          if (!autoResolved && canReportNoMapping) {
            console.debug("[Fix Model Paths] No mapping for", specialValue, "on node", node.id, node.type, "slot", slotName);
            reportNoMapping(report, node, slotName, specialValue);
          }
          continue;
        }

        if (normalizePath(replacement) === normalizePath(specialValue)) {
          console.log("[Fix Model Paths] Skipping no-op for", specialValue, "on node", node.id, node.type, "slot", slotName);
          reportNoOp(report, node, slotName, specialValue, replacement);
          continue;
        }

        results.push({
          node,
          registryEntry,
          widget: null,
          widgetName: slotName,
          before: specialValue,
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
        nodeIsInErrors &&
        !pathWidget.isLinkedInput &&
        !String(pathWidget.widgetName || "").startsWith("object:") &&
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

      const canResolveOutsideErrors = Boolean(options.allowGlobalAutoResolve);
      const canAttemptAutoResolve = !options.onlyErrorNodes || nodeIsInErrors || pathWidget.isLinkedInput || canResolveOutsideErrors;
      const canReportNoMapping = !options.onlyErrorNodes || nodeIsInErrors || pathWidget.isLinkedInput;
      let replacement = findMappingForPath(pathWidget.value, mappings, matchMode, {
        postfixes: options.postfixes || [],
      });
      let autoResolved = false;

      if (!replacement && !isLikelyModelPathValue(pathWidget.value)) {
        continue;
      }

      if (!replacement && options.autoResolve && canAttemptAutoResolve) {
        replacement = autoResolveWidgetWithPostfixes(registryEntry, pathWidget.value, node, availableModels, options.postfixes || []);
        if (replacement) {
          autoResolved = true;
          console.log("[Fix Model Paths] Auto-resolved", pathWidget.value, "->", replacement, "on node", node.id, node.type);
        }
      }

      if (!replacement) {
        if (!autoResolved && canReportNoMapping) {
          console.debug("[Fix Model Paths] No mapping for", pathWidget.value, "on node", node.id, node.type);
          reportNoMapping(report, pathWidget.node || node, pathWidget.widgetName, pathWidget.value);
        }
        continue;
      }

      if (normalizePath(replacement) === normalizePath(pathWidget.value)) {
        console.log("[Fix Model Paths] Skipping no-op for", pathWidget.value, "on node", node.id, node.type);
        reportNoOp(report, pathWidget.node || node, pathWidget.widgetName, pathWidget.value, replacement);
        continue;
      }

      results.push({
        node: pathWidget.node || node,
        registryEntry,
        widget: pathWidget.widget,
        widgetName: pathWidget.linkedWidgetName || pathWidget.widgetName,
        displayWidgetName: pathWidget.widgetName,
        before: pathWidget.value,
        after: replacement,
        autoResolved,
        isLinkedInput: pathWidget.isLinkedInput,
        targetNode: pathWidget.targetNode,
      });
    }
  }
  }

  const seenFixes = new Set();
  const uniqueResults = [];
  for (const fix of results) {
    const key = `${fix.node?.id}|${fix.widgetName}|${fix.before}|${fix.after}`;
    if (seenFixes.has(key)) {
      continue;
    }
    seenFixes.add(key);
    uniqueResults.push(fix);
  }

  for (const nodeId of errorWidgetMap.keys()) {
    if (!findNodeInGraphs(graphs, nodeId)) {
      reportSkipped(report, { id: nodeId, type: "Unknown/Subgraph" }, "", "validation node is not in active graph");
    }
  }

  return uniqueResults;
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

  const hasNodeErrors = Object.keys(validation.node_errors || {}).length > 0;
  const onlyErrorNodes = !validationError && hasNodeErrors;
  const workflowAlreadyValid = !validationError && validation.valid && !hasNodeErrors;
  const allowGlobalAutoResolve = !validationError && validation.valid && hasNodeErrors;

  console.log("[Fix Model Paths] Validate result:", {
    valid: validation.valid,
    errorCount: Object.keys(validation.node_errors || {}).length,
    onlyErrorNodes,
  });

  const [mappings, availableModels, postfixes] = await Promise.all([
    getMappings(),
    getAvailableModels().catch((err) => {
      console.warn("[Fix Model Paths] Failed to fetch available models for auto-resolve", err);
      return {};
    }),
    getPostfixes().catch((err) => {
      console.warn("[Fix Model Paths] Failed to fetch postfixes", err);
      return [];
    }),
  ]);

  console.log("[Fix Model Paths] Mappings loaded:", mappings.length, "postfixes:", postfixes);
  console.table(describeMappings(mappings));

  const report = createFixReport();
  const fixes = scanGraphForPathWidgets(app.graph, mappings, {
    onlyErrorNodes,
    nodeErrors: validation.node_errors,
    matchMode: "auto",
    autoResolve: !workflowAlreadyValid,
    allowGlobalAutoResolve,
    availableModels,
    postfixes,
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
      displayWidget: fix.displayWidgetName || fix.widgetName,
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
      if (fix.targetNode) {
        fixedNodeIds.add(String(fix.targetNode.id));
      }
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
      : workflowAlreadyValid
        ? "Workflow validates; no mapped path replacements found"
        : "No mapped path fixes found for validation errors",
  };
}

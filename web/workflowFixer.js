import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { getMappings, validateWorkflow, getAvailableModels, getPostfixes, loadMatchingRules, logFixReport as sendFixReport } from "./mappingApi.js";
import { basenameVariants, looseMatchScore, describeMappings, findMappingForPath } from "./pathResolver.js";
import { PATH_NODE_REGISTRY } from "./pathNodeRegistry.js";
import {
  getDiscoveredNodeEntryForNode,
  getDiscoveredWidgetDetailsForNode,
  getDiscoveredWidgetsForNode,
} from "./nodeDiscovery.js";

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

const MODEL_TYPE_ALIASES = {
  unet: ["diffusion_models"],
  diffusion_models: ["unet"],
  clips: ["text_encoders", "clip"],
  text_encoders: ["clips", "clip"],
  controlnet: ["controlnet"],
};

function isLikelyModelPathValue(value) {
  const text = String(value || "").trim();
  const normalized = normalizePath(text);
  if (!normalized || text.includes("\n") || normalized.startsWith("http://") || normalized.startsWith("https://")) {
    return false;
  }
  return MODEL_FILE_EXTENSIONS.some((ext) => normalized.endsWith(ext));
}

function getNameIndexForSlot(registryEntry, slotIndex) {
  const slot = registryEntry?.valueSlots?.[slotIndex];
  return Number.isInteger(slot?.nameIdx) ? slot.nameIdx : null;
}

function getInputWidgetIndex(node, widgetName) {
  let index = 0;
  for (const input of node.inputs || []) {
    const inputWidgetName = input?.widget?.name || input?.name;
    if (input?.widget || input?.type === "COMBO" || input?.type === "STRING") {
      if (inputWidgetName === widgetName) {
        return index;
      }
      index += 1;
    }
  }
  return null;
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
  const inputWidgetIndex = getInputWidgetIndex(node, widgetName);
  const registryEntry = PATH_NODE_REGISTRY.find((entry) => entry.matches(node))
    || getDiscoveredNodeEntryForNode(node);
  const registryWidgetIndex = getRegistryWidgetIndex(registryEntry, widgetName);
  const fallbackIndex = widgetIndex >= 0
    ? widgetIndex
    : Number.isInteger(detail?.index)
      ? detail.index
      : Number.isInteger(inputWidgetIndex)
        ? inputWidgetIndex
        : registryWidgetIndex;

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

function notifyGraphChanged() {
  try {
    if (typeof app.graph?.change === "function") {
      app.graph.change();
    }
  } catch (error) {
    console.debug("[Fix Model Paths] graph.change failed", error);
  }

  try {
    const graphData = typeof app.rootGraph?.serialize === "function"
      ? app.rootGraph.serialize()
      : app.graph?.serialize?.();
    api.dispatchCustomEvent("graphChanged", graphData);
  } catch (error) {
    console.debug("[Fix Model Paths] graphChanged event failed", error);
  }
}

function getActiveWorkflowForReload() {
  const isWorkflow = (candidate) => candidate?.changeTracker && typeof candidate.load === "function";
  const candidates = [
    app.workflow?.activeWorkflow,
    app.workflowStore?.activeWorkflow,
    app.workspace?.workflow?.activeWorkflow,
    app.workspaceStore?.workflow?.activeWorkflow,
    window.comfyAPI?.workspace?.workflow?.activeWorkflow,
    window.comfyAPI?.workflow?.activeWorkflow,
    window.comfyAPI?.workflowStore?.activeWorkflow,
    window.app?.workflow?.activeWorkflow,
    window.app?.workflowStore?.activeWorkflow,
    window.app?.workspace?.workflow?.activeWorkflow,
  ];

  for (const candidate of candidates) {
    if (isWorkflow(candidate)) {
      return candidate;
    }
  }

  const seen = new WeakSet();
  const findInObject = (obj, depth = 0) => {
    if (!obj || typeof obj !== "object" || depth > 4 || seen.has(obj)) {
      return null;
    }
    seen.add(obj);

    if (isWorkflow(obj)) {
      return obj;
    }

    let values;
    try {
      values = Object.values(obj);
    } catch {
      return null;
    }

    for (const value of values) {
      if (isWorkflow(value)) {
        return value;
      }
      if (value && typeof value === "object") {
        const found = findInObject(value, depth + 1);
        if (found) {
          return found;
        }
      }
    }

    return null;
  };

  return findInObject(app) || findInObject(window.comfyAPI);
}

export function autoResolveWidget(registryEntry, widgetValue, node, allAvailable) {
  return autoResolveWidgetWithPostfixes(registryEntry, widgetValue, node, allAvailable, []);
}

function getRuntimeWidgetOptions(widget) {
  const values = widget?.options?.values || widget?.options?.items || widget?.options;
  if (Array.isArray(values)) return values;
  return null;
}

function getRuntimePathWidgetNames(node) {
  const names = [];
  for (const widget of node.widgets || []) {
    const options = getRuntimeWidgetOptions(widget);
    const value = widget?.value;
    const hasModelOption = Array.isArray(options) && options.some((option) => isLikelyModelPathValue(option));
    if ((typeof value === "string" && isLikelyModelPathValue(value)) || hasModelOption) {
      names.push(widget.name || widget.type || `widget_${names.length}`);
    }
  }
  return [...new Set(names)];
}

function findAvailableModelMatch(models, wantedVariants, postfixes, options = {}) {
  if (!Array.isArray(models)) return null;

  const normalizedWanted = new Set(wantedVariants.map((value) => normalizePath(value)));
  const ignoredExactValue = options.ignoreExactValue ? normalizePath(options.ignoreExactValue) : null;
  const exactMatch = models.find((model) => {
    const normalizedModel = normalizePath(model);
    return normalizedWanted.has(normalizedModel) && normalizedModel !== ignoredExactValue;
  });
  if (exactMatch) return exactMatch;

  let best = null;
  let bestScore = 0;
  for (const m of models) {
    const normalizedModel = normalizePath(m);
    if (ignoredExactValue && normalizedModel === ignoredExactValue) continue;
    const variants = basenameVariants(m, postfixes);
    // 4: postfix-aware exact basename; 3: separator-insensitive; 2: ignoring quant/precision tokens
    const score = variants.some((variant) => wantedVariants.includes(variant))
      ? 4
      : looseMatchScore(wantedVariants, m, postfixes);
    if (score > bestScore) {
      best = m;
      bestScore = score;
    }
  }
  return best;
}

function getModelTypeCandidates(modelType) {
  if (!modelType) return [];
  return [modelType, ...(MODEL_TYPE_ALIASES[modelType] || [])]
    .filter(Boolean)
    .filter((value, index, items) => items.indexOf(value) === index);
}

function containsModel(models, value) {
  if (!Array.isArray(models)) return false;
  const wanted = normalizePath(value);
  return models.some((model) => normalizePath(model) === wanted);
}

export function autoResolveWidgetWithPostfixes(registryEntry, widgetValue, node, allAvailable, postfixes = [], widgetOptions = null) {
  // already a valid choice: nothing to fix, never "improve" it to a same-named model in another folder
  if (containsModel(widgetOptions, widgetValue)) return widgetValue;
  for (const modelType of getModelTypeCandidates(registryEntry?.modelType)) {
    if (containsModel(allAvailable?.[modelType], widgetValue)) return widgetValue;
  }
  if (!registryEntry?.modelType && Object.values(allAvailable || {}).some((models) => containsModel(models, widgetValue))) {
    return widgetValue;
  }

  const wantedVariants = basenameVariants(widgetValue, postfixes);
  if (wantedVariants.length === 0) return null;

  const optionMatch = findAvailableModelMatch(widgetOptions, wantedVariants, postfixes, {
    ignoreExactValue: widgetValue,
  });
  if (optionMatch) return optionMatch;

  for (const modelType of getModelTypeCandidates(registryEntry?.modelType)) {
    const match = findAvailableModelMatch(allAvailable?.[modelType], wantedVariants, postfixes);
    if (match) return match;
  }

  if (registryEntry?.modelType) {
    return null;
  }

  for (const models of Object.values(allAvailable || {})) {
    const match = findAvailableModelMatch(models, wantedVariants, postfixes);
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

function getRegistryWidgetIndex(registryEntry, widgetName) {
  const index = registryEntry?.widgets?.indexOf(widgetName);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

function getPathWidgetValue(node, widgetName, registryEntry = null) {
  const widget = node.widgets?.find((item) => item.name === widgetName);
  if (widget) {
    const index = Number.isInteger(widget.index)
      ? widget.index
      : node.widgets?.indexOf(widget);
    return {
      widget,
      value: widget.value ?? node.widgets_values?.[index],
      options: getRuntimeWidgetOptions(widget),
    };
  }

  const detail = getDiscoveredWidgetDetailsForNode(node)
    .find((item) => item.widgetName === widgetName);
  if (detail && Array.isArray(node.widgets_values)) {
    return {
      widget: null,
      value: node.widgets_values[detail.index],
      options: detail.options,
    };
  }

  const inputWidgetIndex = getInputWidgetIndex(node, widgetName);
  if (Number.isInteger(inputWidgetIndex) && Array.isArray(node.widgets_values)) {
    return {
      widget: null,
      value: node.widgets_values[inputWidgetIndex],
      options: null,
    };
  }

  const registryWidgetIndex = getRegistryWidgetIndex(registryEntry, widgetName);
  if (Number.isInteger(registryWidgetIndex) && Array.isArray(node.widgets_values)) {
    return {
      widget: null,
      value: node.widgets_values[registryWidgetIndex],
      options: null,
    };
  }

  return {
    widget: null,
    value: undefined,
    options: null,
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

function getGraphNodes(graph) {
  return graph?._nodes || graph?.nodes || [];
}

function getNodeById(graph, nodeId) {
  return getGraphNodes(graph).find((node) => String(node.id) === String(nodeId)) || null;
}

function collectGraphs(graph, seen = new Set()) {
  if (!graph || seen.has(graph)) {
    return [];
  }
  seen.add(graph);

  const graphs = [graph];
  const definitionSubgraphs = graph.definitions?.subgraphs || graph.extra?.definitions?.subgraphs || [];
  for (const subgraph of definitionSubgraphs) {
    if (subgraph?.nodes || subgraph?._nodes) {
      graphs.push(...collectGraphs(subgraph, seen));
    }
  }

  for (const node of getGraphNodes(graph)) {
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

async function reloadCurrentGraphLikeUndoRedo() {
  if (typeof app.loadGraphData !== "function") {
    notifyGraphChanged();
    return;
  }

  const workflow = getActiveWorkflowForReload();
  if (!workflow) {
    console.warn("[Fix Model Paths] Active workflow object not found; skipping loadGraphData refresh to avoid opening an untitled workflow");
    notifyGraphChanged();
    return;
  }

  const graphData = typeof app.rootGraph?.serialize === "function"
    ? app.rootGraph.serialize()
    : app.graph?.serialize?.();
  if (!graphData) {
    notifyGraphChanged();
    return;
  }

  await app.loadGraphData(graphData, false, false, workflow, {
    showMissingModelsDialog: false,
    showMissingNodesDialog: false,
    checkForRerouteMigration: false,
  });
  workflow.changeTracker?.reset?.(graphData);
  workflow.changeTracker?.restore?.();
  notifyGraphChanged();
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
  for (const node of getGraphNodes(localGraph)) {
    let registryEntry = PATH_NODE_REGISTRY.find((entry) => entry.matches(node));
    const discoveredEntry = getDiscoveredNodeEntryForNode(node);
    const discoveredWidgets = discoveredEntry?.widgets || [];
    const runtimeWidgets = getRuntimePathWidgetNames(node);

    const objectPathWidgets = getObjectPathWidgets(node);

    if (!registryEntry && discoveredWidgets.length === 0 && runtimeWidgets.length === 0 && objectPathWidgets.length === 0) {
      continue;
    }

    if (!registryEntry) {
      registryEntry = discoveredEntry || { widgets: runtimeWidgets, modelType: null, source: "runtime" };
    }

    const nodeIsInErrors = errorWidgetMap.has(String(node.id));

    const pathWidgets = [];
    const effectiveWidgets = registryWidgetsForNode(node, registryEntry);

    for (const widgetName of effectiveWidgets) {
      const { widget, value, options: widgetOptions } = getPathWidgetValue(node, widgetName, registryEntry);

      if (typeof value !== "string") {
        continue;
      }

      if (isSkippablePathValue(value)) {
        reportSkipped(report, node, widgetName, "empty/none value");
        continue;
      }

      pathWidgets.push({ widget, widgetName, value, widgetOptions });
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
        const canAttemptAutoResolve = !options.onlyErrorNodes || nodeIsInErrors || canResolveOutsideErrors || Boolean(registryEntry?.modelType);
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
            if (normalizePath(replacement) !== normalizePath(specialValue)) {
              console.log("[Fix Model Paths] Auto-resolved", specialValue, "->", replacement, "on node", node.id, node.type, "slot", slotName);
            }
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
      const canAttemptAutoResolve = !options.onlyErrorNodes || nodeIsInErrors || pathWidget.isLinkedInput || canResolveOutsideErrors || Boolean(registryEntry?.modelType);
      const canReportNoMapping = !options.onlyErrorNodes || nodeIsInErrors || pathWidget.isLinkedInput;
      let replacement = findMappingForPath(pathWidget.value, mappings, matchMode, {
        postfixes: options.postfixes || [],
      });
      let autoResolved = false;

      if (!replacement && !isLikelyModelPathValue(pathWidget.value)) {
        continue;
      }

      if (!replacement && options.autoResolve && canAttemptAutoResolve) {
        replacement = autoResolveWidgetWithPostfixes(
          registryEntry,
          pathWidget.value,
          node,
          availableModels,
          options.postfixes || [],
          pathWidget.widgetOptions,
        );
        if (replacement) {
          autoResolved = true;
          if (normalizePath(replacement) !== normalizePath(pathWidget.value)) {
            console.log("[Fix Model Paths] Auto-resolved", pathWidget.value, "->", replacement, "on node", node.id, node.type);
          }
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
    loadMatchingRules(),
  ]).then((results) => results.slice(0, 3));

  console.log("[Fix Model Paths] Mappings loaded:", mappings.length, "postfixes:", postfixes);
  console.table(describeMappings(mappings));

  const report = createFixReport();
  const fixes = scanGraphForPathWidgets(app.graph, mappings, {
    onlyErrorNodes,
    nodeErrors: validation.node_errors,
    matchMode: "auto",
    autoResolve: true,
    allowGlobalAutoResolve,
    availableModels,
    postfixes,
    report,
  });

  console.log("[Fix Model Paths] Fixes found:", fixes.length, fixes);

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

  app.canvas?.setDirty(true, true);
  if (typeof app.graph?.setDirtyCanvas === "function") {
    app.graph.setDirtyCanvas(true, true);
  }
  notifyGraphChanged();

  const nextPromptResult = await app.graphToPrompt();
  const nextValidation = await validateWorkflow(nextPromptResult.output);
  const remainingNodeIds = new Set(Object.keys(nextValidation.node_errors || {}));

  await reloadCurrentGraphLikeUndoRedo();

  const resolvedNodeIds = new Set([...fixedNodeIds].filter((nodeId) => !remainingNodeIds.has(String(nodeId))));
  console.log("[Fix Model Paths] Reloaded workflow state. Resolved fixed nodes:", [...resolvedNodeIds]);

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

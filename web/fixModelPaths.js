import { app } from "/scripts/app.js";
import { PATH_NODE_REGISTRY } from "./pathNodeRegistry.js";
import { fixAllModelPaths } from "./workflowFixer.js";
import { showToast } from "./feedback.js";
import {
  hasPendingNodeFix,
  cancelNodeFix,
  fixNode,
  saveFixedNode,
  lastCaptures,
} from "./nodeFixCapture.js";
import {
  discoverPathWidgetsFromNodeDef,
  getDiscoveredNodeEntryForNode,
  getDiscoveredWidgetsForNode,
} from "./nodeDiscovery.js";
import { loadNodeLibrary, refreshNodeLibrary, showAddNodeToLibraryDialog } from "./nodeLibrary.js";
import { getPostfixes, savePostfixes } from "./mappingApi.js";
import { registerPathNodeRegistryEntry } from "./pathNodeRegistry.js";
import {
  getUnmatchedModelBasenamesForNode,
  openModelSearch,
  refreshAndGetUnmatchedModelBasenamesForNode,
  warmModelSearchCache,
} from "./modelSearchMenu.js";

const EXTENSION_NAME = "fix_names.fixModelPaths";
const pendingLibraryNodeIds = new Set();
let nodeMenuPatched = false;

console.log("[Fix Model Paths] Extension loaded", { registrySize: PATH_NODE_REGISTRY?.length });

const style = document.createElement("style");
style.textContent = `
.fix-model-paths-ready {
  background: #2d9f5b;
  color: #ffffff;
  border: 1px solid #8cffb0;
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  font-family: inherit;
}
.fix-model-paths-cancel {
  background: #5c5c66;
  border-color: #8a8a94;
}
`;
document.head.appendChild(style);

async function onFixAllPaths() {
  console.log("[Fix Model Paths] Canvas menu: Fix Model Paths clicked");
  try {
    const result = await fixAllModelPaths();
    showToast(result.message);

    if (Object.keys(result.remainingNodeErrors || {}).length > 0) {
      showToast("Some validation errors remain. Use Fix Node on remaining nodes.");
    }
  } catch (error) {
    console.error(error);
    showToast(`Fix Model Paths failed: ${error.message}`);
  }
}

async function onEditPostfixes() {
  try {
    const current = await getPostfixes();
    const value = window.prompt(
      "Model name postfixes, comma-separated. Example: kj, fp8, q4_k_s",
      current.join(", "),
    );

    if (value == null) {
      return;
    }

    const postfixes = value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    const result = await savePostfixes(postfixes);
    showToast(`Saved ${result.postfixes?.length || 0} postfix(es)`);
  } catch (error) {
    console.error(error);
    showToast(`Postfix edit failed: ${error.message}`);
  }
}

async function onFindModel(node, modelName = null) {
  try {
    const names = modelName
      ? [modelName]
      : await refreshAndGetUnmatchedModelBasenamesForNode(node);

    if (names.length === 0) {
      showToast("No unmatched model names found on this node");
      return;
    }

    openModelSearch(names[0]);
  } catch (error) {
    console.error(error);
    showToast(`Find Model failed: ${error.message}`);
  }
}

function getPathWidgetNames(node) {
  const registryEntry = PATH_NODE_REGISTRY.find((entry) => entry.matches(node));
  const names = new Set();
  if (registryEntry) {
    for (const w of registryEntry.widgets) names.add(w);
  }
  for (const w of getDiscoveredWidgetsForNode(node)) names.add(w);
  return [...names];
}

function getAllStringWidgets(node) {
  const widgets = [];
  if (node.widgets) {
    for (const w of node.widgets) {
      if (typeof w.value === "string" && w.value.trim()) {
        widgets.push(w.name || w.type || `widget_${widgets.length}`);
      }
    }
  }
  if (node.widgets_values) {
    const vals = Array.isArray(node.widgets_values) ? node.widgets_values : [node.widgets_values];
    for (let i = 0; i < vals.length; i++) {
      if (typeof vals[i] === "string" && vals[i].trim() && !widgets.includes(`inline_${i}`)) {
        widgets.push(`inline_${i}`);
      }
    }
  }
  return [...new Set(widgets)];
}

async function onNodeMenuAction(node, action, widgetFilter) {
  try {
    if (action === "cancel") {
      const result = cancelNodeFix(node);
      pendingLibraryNodeIds.delete(String(node.id));
      showToast(result.message);
      return;
    }

    if (action === "save") {
      const result = await saveFixedNode(node);
      showToast(result.message);
      return;
    }

    const registryWidgets = getPathWidgetNames(node);
    const allStringWidgets = getAllStringWidgets(node);

    let targetWidgets;
    if (registryWidgets.length > 0) {
      targetWidgets = registryWidgets;
    } else if (allStringWidgets.length > 0) {
      targetWidgets = allStringWidgets;
    } else {
      showToast("No string path widgets found on this node");
      return;
    }

    const captures = fixNode(node, targetWidgets, {
      onCancel: () => onNodeMenuAction(node, "cancel"),
    });
    showToast(captures.length ? "Node ready for new model value" : "No path widgets found");
  } catch (error) {
    console.error(error);
    showToast(`Fix Node failed: ${error.message}`);
  }
}

async function onNodeMenuActionWithLibrary(node, action) {
  try {
    if (action === "cancel") {
      const result = cancelNodeFix(node);
      pendingLibraryNodeIds.delete(String(node.id));
      showToast(result.message);
      return;
    }

    if (action === "save") {
      const result = await saveFixedNode(node);
      pendingLibraryNodeIds.delete(String(node.id));
      if (result.saved && result.isUnknownNode) {
        const captures = lastCaptures || [];
        const widgetNames = captures.map((c) => c.widgetName);
        const firstCapture = captures[0];
        showAddNodeToLibraryDialog(
          node,
          widgetNames,
          firstCapture ? { before: firstCapture.before, after: result.after || "" } : null,
          getDiscoveredNodeEntryForNode(node)?.modelType || "",
        );
      }
      await refreshNodeLibrary();
      showToast(result.message);
      return;
    }

    const pathWidgets = getPathWidgetNames(node);
    const allStringWidgets = getAllStringWidgets(node);
    const targetWidgets = pathWidgets.length > 0 ? pathWidgets : allStringWidgets;
    if (targetWidgets.length === 0) {
      showToast("No string path widgets found on this node");
      return;
    }

    const captures = fixNode(node, targetWidgets, {
      onSave: () => onNodeMenuActionWithLibrary(node, "save"),
      onCancel: () => onNodeMenuActionWithLibrary(node, "cancel"),
    });
    if (captures.length) {
      pendingLibraryNodeIds.add(String(node.id));
    }
    showToast(captures.length ? "Node ready — select new value, then Save Fixed" : "No path widgets found");
  } catch (error) {
    console.error(error);
    showToast(`Fix Node failed: ${error.message}`);
  }
}

async function initNodeLibrary() {
  const library = await loadNodeLibrary();
  for (const entry of library) {
    if (!entry?.node_type || !entry?.model_type || !Array.isArray(entry.widgets)) {
      continue;
    }
    registerPathNodeRegistryEntry({
      nodeType: entry.node_type,
      comfyClass: entry.node_type,
      modelType: entry.model_type,
      widgets: entry.widgets,
      matches(n) {
        return n.type === entry.node_type || n.comfyClass === entry.node_type;
      },
    });
  }
  console.log("[Fix Model Paths] Node library loaded:", library.length, "entries");
}

function scheduleNodeLibraryInit() {
  const run = () => {
    initNodeLibrary().catch((error) => {
      console.warn("[Fix Model Paths] Failed to load node library", error);
    });
  };

  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(run, { timeout: 3000 });
    return;
  }

  window.setTimeout(run, 0);
}

scheduleNodeLibraryInit();
warmModelSearchCache();

function buildNodeMenuItems(node) {
  const items = [];

  if (hasPendingNodeFix(node)) {
    const saveAction = pendingLibraryNodeIds.has(String(node.id))
      ? () => onNodeMenuActionWithLibrary(node, "save")
      : () => onNodeMenuAction(node, "save");

    items.push({
      content: "Save Fixed 🦊",
      callback: saveAction,
    });
    items.push({
      content: "Cancel Fix 🦊",
      callback: () => onNodeMenuAction(node, "cancel"),
    });
  }

  const registryEntry = PATH_NODE_REGISTRY.find((entry) => entry.matches(node));
  const discoveredWidgets = getDiscoveredWidgetsForNode(node);
  const hasStringWidgets = getAllStringWidgets(node).length > 0;

  if (registryEntry || discoveredWidgets.length > 0 || hasStringWidgets) {
    items.push({
      content: "Fix Node 🦊",
      callback: () => onNodeMenuActionWithLibrary(node, "fix"),
    });
  }

  const unmatchedModels = getUnmatchedModelBasenamesForNode(node);
  if (unmatchedModels.length === 1) {
    items.push({
      content: `Find Model: ${unmatchedModels[0]} 🦊`,
      callback: () => onFindModel(node, unmatchedModels[0]),
    });
  } else if (unmatchedModels.length > 1) {
    items.push({
      content: "Find Model 🦊",
      submenu: {
        options: unmatchedModels.map((modelName) => ({
          content: modelName,
          callback: () => onFindModel(node, modelName),
        })),
      },
    });
  }

  return items;
}

function isFixModelPathsMenuItem(item) {
  return typeof item?.content === "string" && item.content.includes("🦊");
}

function removeExistingNodeMenuItems(options) {
  for (let i = options.length - 1; i >= 0; i--) {
    if (isFixModelPathsMenuItem(options[i])) {
      options.splice(i, 1);
    }
  }

  for (let i = options.length - 1; i > 0; i--) {
    if (options[i] === null && options[i - 1] === null) {
      options.splice(i, 1);
    }
  }

  if (options[0] === null) {
    options.shift();
  }
  if (options[options.length - 1] === null) {
    options.pop();
  }
}

function findNodeMenuInsertIndex(options) {
  const preferredLabels = [
    "Recreate node",
    "Clone",
    "Remove",
  ];

  for (const label of preferredLabels) {
    const index = options.findIndex((item) => item?.content === label);
    if (index >= 0) {
      return index;
    }
  }

  return options.length;
}

function insertNodeMenuBlock(options, items) {
  if (items.length === 0) {
    return;
  }

  removeExistingNodeMenuItems(options);
  const insertIndex = findNodeMenuInsertIndex(options);
  const block = [];

  if (insertIndex > 0 && options[insertIndex - 1] !== null) {
    block.push(null);
  }

  block.push(...items);

  if (insertIndex < options.length && options[insertIndex] !== null) {
    block.push(null);
  }

  options.splice(insertIndex, 0, ...block);
}

function patchNodeMenuOptions() {
  if (nodeMenuPatched || typeof LGraphCanvas === "undefined" || !LGraphCanvas?.prototype?.getNodeMenuOptions) {
    return;
  }

  nodeMenuPatched = true;
  const originalGetNodeMenuOptions = LGraphCanvas.prototype.getNodeMenuOptions;

  LGraphCanvas.prototype.getNodeMenuOptions = function getFixModelPathsNodeMenuOptions(node) {
    const options = originalGetNodeMenuOptions.apply(this, arguments) || [];
    insertNodeMenuBlock(options, buildNodeMenuItems(node));
    return options;
  };
}

console.log("[Fix Model Paths] Registering extension");
app.registerExtension({
  name: EXTENSION_NAME,

  setup() {
    patchNodeMenuOptions();
  },

  beforeRegisterNodeDef(nodeType, nodeData) {
    discoverPathWidgetsFromNodeDef(nodeData?.name || nodeType.comfyClass || nodeType.name, nodeData);
  },

  getCanvasMenuItems(canvas) {
    return [
      null,
      {
        content: "Fix Model Paths 🦊",
        callback: onFixAllPaths,
      },
      {
        content: "Edit Model Postfixes 🦊",
        callback: onEditPostfixes,
      },
    ];
  },

  getNodeMenuItems(node) {
    return [];
  },
});

# ComfyUI Fix Model Paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a ComfyUI custom-node extension that adds a canvas right-click menu item `Fix Model Paths`, fixes only model/LoRA path widgets that are actually failing validation, and supports a two-step per-node capture flow: `Fix Node` stores the current bad value, then `Save Fixed` stores the newly selected value and persists the pair locally.

**Architecture:** Implement a client-side ComfyUI extension plus a small Python server API. The Python module exports `WEB_DIRECTORY` so ComfyUI loads JavaScript from `web/`. The JavaScript uses official context-menu hooks when available: `getCanvasMenuItems(canvas)` and `getNodeMenuItems(node)`. For legacy ComfyUI frontends where those hooks are not called, add guarded fallback monkey-patching for `LGraphCanvas.prototype.getCanvasMenuOptions` and `nodeType.prototype.getExtraMenuOptions`. Local mappings are stored in a plugin-local ignored file, for example `<plugin>/model_path_mappings.local.json`, not under `ComfyUI/user/`.

**Tech Stack:** Python 3, `aiohttp` routes exposed as `server.web`, ComfyUI extension JavaScript hooks, LiteGraph/Comfy node graph objects, Comfy prompt validation via `execution.validate_prompt`.

---

### Task 1: Create the custom-node extension skeleton and plugin-local mapping storage

**Files:**
- Create: `__init__.py`
- Create: `web/fixModelPaths.js`
- Create: `web/pathNodeRegistry.js`
- Create: `.gitignore`

- [ ] **Step 1: Add Python entry point with plugin-local mapping file**

```python
from aiohttp import web
import os
import json
import server

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MAPPING_FILE = os.path.join(BASE_DIR, "model_path_mappings.local.json")


def read_mappings():
    if not os.path.exists(MAPPING_FILE):
        return []

    try:
        with open(MAPPING_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def write_mappings(items):
    tmp_path = f"{MAPPING_FILE}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, MAPPING_FILE)
```

- [ ] **Step 2: Add empty extension JavaScript**

```javascript
import { app } from "../../scripts/app.js";
import { PATH_NODE_REGISTRY } from "./pathNodeRegistry.js";

const EXTENSION_NAME = "fix_names.fixModelPaths";

app.registerExtension({
  name: EXTENSION_NAME,

  getCanvasMenuItems(canvas) {
    return [
      null,
      {
        content: "Fix Model Paths",
        callback: async () => {
          console.log("Fix Model Paths clicked", { canvas, registry: PATH_NODE_REGISTRY });
        },
      },
    ];
  },

  getNodeMenuItems(node) {
    const registryEntry = PATH_NODE_REGISTRY.find((entry) =>
      entry.matches(node),
    );

    if (!registryEntry) {
      return [];
    }

    return [
      {
        content: "Fix Node",
        callback: async () => {
          console.log("Fix Node clicked", { node, registryEntry });
        },
      },
    ];
  },
});
```

- [ ] **Step 3: Add registry shape**

```javascript
export const PATH_NODE_REGISTRY = [
  {
    nodeType: "CheckpointLoaderSimple",
    comfyClass: "CheckpointLoaderSimple",
    widgets: ["ckpt_name"],
    matches(node) {
      return (
        this.nodeType === node.type ||
        this.comfyClass === node.comfyClass ||
        this.comfyClass === node.constructor?.ComfyClass
      );
    },
  },
];
```

- [ ] **Step 4: Ignore the local mapping file**

```gitignore
model_path_mappings.local.json
model_path_mappings.local.json.tmp
__pycache__/
*.pyc
```

- [ ] **Step 5: Verify skeleton imports**

Run:

```powershell
python -m py_compile __init__.py
```

Expected: no output and exit code `0`.

---

### Task 2: Add server API for mapping persistence and validation without queueing

**Files:**
- Modify: `__init__.py:1-80`
- Add: `web/mappingApi.js`

- [ ] **Step 1: Add mapping GET/POST routes**

```python
@server.PromptServer.instance.routes.get("/fix_model_paths/mappings")
async def get_model_path_mappings(request):
    try:
        return web.json_response(read_mappings())
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@server.PromptServer.instance.routes.post("/fix_model_paths/mappings")
async def upsert_model_path_mapping(request):
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    before = payload.get("before")
    after = payload.get("after")

    if not isinstance(before, str) or not before.strip():
        return web.json_response({"error": "before must be a non-empty string"}, status=400)
    if not isinstance(after, str) or not after.strip():
        return web.json_response({"error": "after must be a non-empty string"}, status=400)

    items = [item for item in read_mappings() if isinstance(item, dict)]
    key_before = before.strip().lower()

    for item in items:
        if str(item.get("before", "")).lower() == key_before:
            item["before"] = before.strip()
            item["after"] = after.strip()
            break
    else:
        items.append({"before": before.strip(), "after": after.strip()})

    write_mappings(items)
    return web.json_response({"ok": True, "mappings": items})
```

- [ ] **Step 2: Add validation-without-queue route**

```python
import uuid
import execution

@server.PromptServer.instance.routes.post("/fix_model_paths/validate")
async def validate_workflow_without_queue(request):
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    prompt = payload.get("prompt")
    if not isinstance(prompt, dict):
        return web.json_response({"error": "prompt must be an object"}, status=400)

    valid, error, good_outputs, node_errors = await execution.validate_prompt(
        str(uuid.uuid4()),
        prompt,
        None,
    )

    return web.json_response({
        "valid": valid,
        "error": error,
        "good_outputs": good_outputs,
        "node_errors": node_errors or {},
    })
```

- [ ] **Step 3: Add client mapping API helper**

```javascript
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
```

- [ ] **Step 4: Verify server route compiles**

Run:

```powershell
python -m py_compile __init__.py
```

Expected: no output and exit code `0`.

---

### Task 3: Implement path matching, validation filtering, and bulk workflow repair

**Files:**
- Modify: `web/fixModelPaths.js`
- Add: `web/pathResolver.js`
- Add: `web/workflowFixer.js`

- [ ] **Step 1: Add path normalization and matching**

The saved pair is the full widget value shown in ComfyUI, usually a model-relative path such as `checkpoints/OldFolder/Model.safetensors`. For the first version, matching is case-insensitive and compares the filename by default, because the common problem is the same filename under different subfolders. Keep a subpath mode available later.

```javascript
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

function subpathKey(value) {
  return normalizePath(value);
}

export function findMappingForPath(path, mappings, mode = "basename") {
  if (!path || typeof path !== "string") {
    return null;
  }

  const wanted = mode === "subpath" ? subpathKey(path) : basenameKey(path);
  if (!wanted) {
    return null;
  }

  for (const mapping of mappings) {
    const mappingKey = mode === "subpath"
      ? subpathKey(mapping.before)
      : basenameKey(mapping.before);

    if (mappingKey === wanted) {
      return mapping.after;
    }
  }

  return null;
}
```

- [ ] **Step 2: Add validation-error filtering**

Only nodes reported by Comfy validation are eligible for bulk repair. For each node error, prefer exact widget names from `extra_info.input_name`; if a configured path node has only one path widget and the error lacks `input_name`, include it as a fallback.

```javascript
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

  return pathWidgetCount === 1;
}
```

- [ ] **Step 3: Add graph scanner**

```javascript
import { findMappingForPath } from "./pathResolver.js";
import {
  buildErrorWidgetMap,
  isWidgetInError,
} from "./workflowFixer.js";
import { PATH_NODE_REGISTRY } from "./pathNodeRegistry.js";

export function scanGraphForPathWidgets(graph, mappings, options = {}) {
  const errorWidgetMap = options.errorWidgetMap || buildErrorWidgetMap(options.nodeErrors || {});
  const results = [];

  for (const node of graph._nodes || []) {
    const registryEntry = PATH_NODE_REGISTRY.find((entry) => entry.matches(node));
    if (!registryEntry) {
      continue;
    }

    const pathWidgets = [];

    for (const widgetName of registryEntry.widgets) {
      const widget = node.widgets?.find((item) => item.name === widgetName);
      const value = widget?.value ?? node.widgets_values?.[widget?.index ?? -1];

      if (typeof value !== "string") {
        continue;
      }

      pathWidgets.push({ widget, widgetName, value });
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
        continue;
      }

      const replacement = findMappingForPath(pathWidget.value, mappings, options.matchMode);
      if (!replacement) {
        continue;
      }

      results.push({
        node,
        widget: pathWidget.widget,
        widgetName: pathWidget.widgetName,
        before: pathWidget.value,
        after: replacement,
      });
    }
  }

  return results;
}
```

- [ ] **Step 4: Add apply and validate loop**

```javascript
import { validateWorkflow } from "./mappingApi.js";
import { scanGraphForPathWidgets } from "./workflowFixer.js";

export async function fixAllModelPaths() {
  const promptResult = await app.graphToPrompt();
  const validation = await validateWorkflow(promptResult.output);

  if (validation.valid) {
    return { fixed: 0, remainingNodeErrors: {}, message: "Workflow already validates" };
  }

  const mappings = await getMappings();
  const fixes = scanGraphForPathWidgets(app.graph, mappings, {
    onlyErrorNodes: true,
    nodeErrors: validation.node_errors,
  });

  for (const fix of fixes) {
    if (fix.widget) {
      fix.widget.value = fix.after;
      if (typeof fix.widget.callback === "function") {
        fix.widget.callback(fix.after);
      }
    }

    const index = fix.widget?.index;
    if (Array.isArray(fix.node.widgets_values) && Number.isInteger(index)) {
      fix.node.widgets_values[index] = fix.after;
    }
  }

  app.graph.setDirtyCanvas(true, true);

  const nextPromptResult = await app.graphToPrompt();
  const nextValidation = await validateWorkflow(nextPromptResult.output);

  return {
    fixed: fixes.length,
    remainingNodeErrors: nextValidation.node_errors || {},
    message: fixes.length
      ? `Fixed ${fixes.length} path widget(s)`
      : "No mapped path fixes found for validation errors",
  };
}
```

Expected: clicking canvas `Fix Model Paths` validates the workflow first, changes only path widgets attached to validation errors, then revalidates.

---

### Task 4: Implement per-node two-step capture flow

**Files:**
- Modify: `web/fixModelPaths.js`
- Add: `web/nodeFixCapture.js`

- [ ] **Step 1: Add pending capture state**

```javascript
const pendingNodeFixes = new Map();

export function captureNodeFix(node, widgetName, before) {
  const key = String(node.id);
  pendingNodeFixes.set(key, {
    nodeId: node.id,
    widgetName,
    before,
  });
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
```

- [ ] **Step 2: Capture current node value and mark node ready**

`Fix Node` does not ask for the new path. It stores the current bad value in memory and shows a ready indicator.

```javascript
import { captureNodeFix, hasPendingNodeFix } from "./nodeFixCapture.js";

export function fixNode(node, registryEntry) {
  const captures = [];

  for (const widgetName of registryEntry.widgets) {
    const widget = node.widgets?.find((item) => item.name === widgetName);
    const currentValue = widget?.value ?? node.widgets_values?.[widget?.index ?? -1];

    if (typeof currentValue !== "string") {
      continue;
    }

    captureNodeFix(node, widgetName, currentValue);
    captures.push({ widgetName, before: currentValue });
  }

  showNodeReadyIndicator(node);

  return captures;
}
```

- [ ] **Step 3: Save fixed value from current widget state**

After `Fix Node`, the user selects the correct model in the same widget. `Save Fixed` uses the current widget value as `after`.

```javascript
import { saveMapping } from "./mappingApi.js";
import {
  clearPendingNodeFix,
  getPendingNodeFix,
} from "./nodeFixCapture.js";

export async function saveFixedNode(node) {
  const pending = getPendingNodeFix(node);
  if (!pending) {
    return { saved: 0, message: "No pending node fix" };
  }

  const widget = node.widgets?.find((item) => item.name === pending.widgetName);
  const after = widget?.value ?? node.widgets_values?.[widget?.index ?? -1];

  if (typeof after !== "string" || !after.trim()) {
    return { saved: 0, message: "New path is empty" };
  }

  if (after === pending.before) {
    return { saved: 0, message: "New path is the same as old path" };
  }

  await saveMapping(pending.before, after);

  if (widget) {
    widget.value = after;
    if (typeof widget.callback === "function") {
      widget.callback(after);
    }
  }

  const index = widget?.index;
  if (Array.isArray(node.widgets_values) && Number.isInteger(index)) {
    node.widgets_values[index] = after;
  }

  clearPendingNodeFix(node);
  hideNodeReadyIndicator(node);
  app.graph.setDirtyCanvas(true, true);

  return { saved: 1, message: "Saved fixed path mapping" };
}
```

- [ ] **Step 4: Add ready indicator near the node**

```javascript
let readyIndicatorEl = null;

export function showNodeReadyIndicator(node) {
  hideNodeReadyIndicator();

  readyIndicatorEl = document.createElement("button");
  readyIndicatorEl.type = "button";
  readyIndicatorEl.className = "fix-model-paths-ready";
  readyIndicatorEl.textContent = "Ready: Save Fixed";
  readyIndicatorEl.style.position = "absolute";
  readyIndicatorEl.style.zIndex = "9999";
  readyIndicatorEl.style.pointerEvents = "auto";

  readyIndicatorEl.addEventListener("click", async () => {
    await saveFixedNode(node);
  });

  document.body.appendChild(readyIndicatorEl);
  positionNodeReadyIndicator(node);
}

export function hideNodeReadyIndicator() {
  readyIndicatorEl?.remove();
  readyIndicatorEl = null;
}

function positionNodeReadyIndicator(node) {
  if (!readyIndicatorEl || !app?.canvas) {
    return;
  }

  const scale = app.canvas.ds?.scale || 1;
  const offset = app.canvas.ds?.offset || [0, 0];
  const x = node.pos[0] * scale + offset[0] + 12;
  const y = node.pos[1] * scale + offset[1] + 12;

  readyIndicatorEl.style.left = `${x}px`;
  readyIndicatorEl.style.top = `${y}px`;
}
```

Expected: right-click node → `Fix Node` stores the bad value and shows `Ready: Save Fixed`; user selects the correct model; click indicator or menu `Save Fixed` stores the pair.

---

### Task 5: Wire canvas and node menus with bulk and point flows

**Files:**
- Modify: `web/fixModelPaths.js`

- [ ] **Step 1: Wire canvas menu to bulk repair only**

```javascript
import { fixAllModelPaths } from "./workflowFixer.js";
import { showToast } from "./feedback.js";

async function onFixAllPaths() {
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
```

- [ ] **Step 2: Wire node menu to Fix Node and Save Fixed**

```javascript
import { saveFixedNode } from "./nodeFixCapture.js";
import { hasPendingNodeFix } from "./nodeFixCapture.js";
import { fixNode } from "./nodeFixCapture.js";

async function onNodeMenuAction(node, action) {
  try {
    if (action === "save") {
      const result = await saveFixedNode(node);
      showToast(result.message);
      return;
    }

    const registryEntry = PATH_NODE_REGISTRY.find((entry) => entry.matches(node));
    if (!registryEntry) {
      return;
    }

    const captures = fixNode(node, registryEntry);
    showToast(captures.length ? "Node ready for new model value" : "No path widgets found");
  } catch (error) {
    console.error(error);
    showToast(`Fix Node failed: ${error.message}`);
  }
}
```

- [ ] **Step 3: Add menu hook**

```javascript
app.registerExtension({
  name: EXTENSION_NAME,

  getCanvasMenuItems(canvas) {
    return [
      null,
      {
        content: "Fix Model Paths",
        callback: onFixAllPaths,
      },
    ];
  },

  getNodeMenuItems(node) {
    const items = [];

    if (hasPendingNodeFix(node)) {
      items.push({
        content: "Save Fixed",
        callback: () => onNodeMenuAction(node, "save"),
      });
    }

    const registryEntry = PATH_NODE_REGISTRY.find((entry) => entry.matches(node));
    if (registryEntry) {
      items.push({
        content: "Fix Node",
        callback: () => onNodeMenuAction(node, "fix"),
      });
    }

    return items.length ? items : [];
  },
});
```

Expected:
- Empty canvas right-click → `Fix Model Paths` runs bulk validation-filtered repair.
- Node right-click → `Fix Node` captures the current bad value.
- After selecting a new model, click `Ready: Save Fixed` or node menu `Save Fixed`.

---

### Task 6: Add registry entries and adaptive custom-node discovery

**Files:**
- Modify: `web/pathNodeRegistry.js`
- Add: `web/nodeDiscovery.js`

- [ ] **Step 1: Add core built-in entries**

```javascript
export const PATH_NODE_REGISTRY = [
  {
    nodeType: "CheckpointLoaderSimple",
    comfyClass: "CheckpointLoaderSimple",
    widgets: ["ckpt_name"],
    matches(node) {
      return this.nodeType === node.type || this.comfyClass === node.comfyClass;
    },
  },
  {
    nodeType: "DiffusersLoader",
    comfyClass: "DiffusersLoader",
    widgets: ["model_path"],
    matches(node) {
      return this.nodeType === node.type || this.comfyClass === node.comfyClass;
    },
  },
  {
    nodeType: "LoraLoader",
    comfyClass: "LoraLoader",
    widgets: ["lora_name"],
    matches(node) {
      return this.nodeType === node.type || this.comfyClass === node.comfyClass;
    },
  },
  {
    nodeType: "LoraLoaderModelOnly",
    comfyClass: "LoraLoaderModelOnly",
    widgets: ["lora_name"],
    matches(node) {
      return this.nodeType === node.type || this.comfyClass === node.comfyClass;
    },
  },
  {
    nodeType: "VAELoader",
    comfyClass: "VAELoader",
    widgets: ["vae_name"],
    matches(node) {
      return this.nodeType === node.type || this.comfyClass === node.comfyClass;
    },
  },
  {
    nodeType: "ControlNetLoader",
    comfyClass: "ControlNetLoader",
    widgets: ["control_net_name"],
    matches(node) {
      return this.nodeType === node.type || this.comfyClass === node.comfyClass;
    },
  },
  {
    nodeType: "UpscaleModelLoader",
    comfyClass: "UpscaleModelLoader",
    widgets: ["model_name"],
    matches(node) {
      return this.nodeType === node.type || this.comfyClass === node.comfyClass;
    },
  },
  {
    nodeType: "CLIPLoader",
    comfyClass: "CLIPLoader",
    widgets: ["clip_name"],
    matches(node) {
      return this.nodeType === node.type || this.comfyClass === node.comfyClass;
    },
  },
  {
    nodeType: "DualCLIPLoader",
    comfyClass: "DualCLIPLoader",
    widgets: ["clip_name1", "clip_name2"],
    matches(node) {
      return this.nodeType === node.type || this.comfyClass === node.comfyClass;
    },
  },
  {
    nodeType: "CLIPVisionLoader",
    comfyClass: "CLIPVisionLoader",
    widgets: ["clip_name"],
    matches(node) {
      return this.nodeType === node.type || this.comfyClass === node.comfyClass;
    },
  },
];
```

- [ ] **Step 2: Add external registration helper**

```javascript
export function registerPathNodeRegistryEntry(entry) {
  if (!entry?.matches || !Array.isArray(entry.widgets)) {
    throw new Error("Path registry entry requires matches() and widgets[]");
  }

  PATH_NODE_REGISTRY.push(entry);
}
```

- [ ] **Step 3: Add custom node widget discovery**

Discovery is for custom nodes not present in the built-in registry. It records likely path widgets from node definitions and merges them at runtime.

```javascript
const DISCOVERED_WIDGETS = new Map();
const PATH_WIDGET_KEYWORDS = [
  "ckpt",
  "checkpoint",
  "model",
  "lora",
  "vae",
  "clip",
  "unet",
  "control_net",
  "style_model",
  "diffusion",
  "upscale",
  "path",
];

function normalizeNodeKey(nodeType, nodeData) {
  return nodeType || nodeData?.name || nodeData?.display_name || "";
}

function isLikelyPathWidgetName(widgetName) {
  const normalized = String(widgetName || "").toLowerCase();
  return PATH_WIDGET_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

export function discoverPathWidgetsFromNodeDef(nodeType, nodeData) {
  const widgets = [];
  const inputs = nodeData?.input || {};

  for (const section of ["required", "optional"]) {
    const sectionInputs = inputs[section] || {};

    for (const [widgetName, widgetDef] of Object.entries(sectionInputs)) {
      if (!isLikelyPathWidgetName(widgetName)) {
        continue;
      }

      const isCombo = Array.isArray(widgetDef);
      const options = isCombo ? widgetDef[0] : widgetDef?.options;
      const isLongModelList = Array.isArray(options) && options.length > 20;

      if (isCombo || isLongModelList || String(widgetName).toLowerCase().includes("path")) {
        widgets.push(widgetName);
      }
    }
  }

  if (widgets.length > 0) {
    DISCOVERED_WIDGETS.set(normalizeNodeKey(nodeType, nodeData), widgets);
  }
}

export function getDiscoveredWidgetsForNode(node) {
  const key = node.type || node.comfyClass || node.constructor?.ComfyClass || "";
  return DISCOVERED_WIDGETS.get(key) || [];
}
```

- [ ] **Step 4: Merge discovered widgets into matching**

```javascript
import { getDiscoveredWidgetsForNode } from "./nodeDiscovery.js";

function registryWidgetsForNode(node, registryEntry) {
  const widgets = new Set(registryEntry?.widgets || []);

  for (const widgetName of getDiscoveredWidgetsForNode(node)) {
    widgets.add(widgetName);
  }

  return [...widgets];
}
```

Expected: built-in nodes are handled explicitly, custom nodes can be registered by other extensions, and unknown custom nodes are discovered from node definitions when their widget names look like model/path selectors.

---

### Task 7: Add legacy ComfyUI frontend compatibility fallback

**Files:**
- Modify: `web/fixModelPaths.js`
- Add: `web/legacyMenuFallback.js`

- [ ] **Step 1: Add legacy fallback installer**

```javascript
let installed = false;

export function installLegacyMenuFallback(extension) {
  if (installed || typeof window.LiteGraph === "undefined") {
    return;
  }

  installed = true;

  const originalCanvasMenu = window.LiteGraph.LGraphCanvas?.prototype?.getCanvasMenuOptions;
  if (originalCanvasMenu) {
    window.LiteGraph.LGraphCanvas.prototype.getCanvasMenuOptions = function (...args) {
      const options = originalCanvasMenu.apply(this, args) || [];
      return [
        ...options,
        null,
        {
          content: "Fix Model Paths",
          callback: () => extension.onFixAllPaths?.(),
        },
      ];
    };
  }
}
```

- [ ] **Step 2: Add legacy node menu fallback in beforeRegisterNodeDef**

```javascript
import { installLegacyMenuFallback } from "./legacyMenuFallback.js";

app.registerExtension({
  name: EXTENSION_NAME,

  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    const originalExtraMenu = nodeType.prototype.getExtraMenuOptions;

    nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
      originalExtraMenu?.apply(this, arguments);

      const node = this;
      const registryEntry = PATH_NODE_REGISTRY.find((entry) => entry.matches(node));
      const items = [];

      if (hasPendingNodeFix(node)) {
        items.push({
          content: "Save Fixed",
          callback: () => onNodeMenuAction(node, "save"),
        });
      }

      if (registryEntry) {
        items.push({
          content: "Fix Node",
          callback: () => onNodeMenuAction(node, "fix"),
        });
      }

      options.push(...items);
    };
  },

  getCanvasMenuItems(canvas) {
    return [
      null,
      {
        content: "Fix Model Paths",
        callback: onFixAllPaths,
      },
    ];
  },

  getNodeMenuItems(node) {
    const items = [];

    if (hasPendingNodeFix(node)) {
      items.push({
        content: "Save Fixed",
        callback: () => onNodeMenuAction(node, "save"),
      });
    }

    const registryEntry = PATH_NODE_REGISTRY.find((entry) => entry.matches(node));
    if (registryEntry) {
      items.push({
        content: "Fix Node",
        callback: () => onNodeMenuAction(node, "fix"),
      });
    }

    return items;
  },

  async setup() {
    installLegacyMenuFallback({ onFixAllPaths });
  },
});
```

Expected: current ComfyUI uses the official menu hooks; older ComfyUI gets the same canvas/node menu items through guarded legacy fallback.

---

### Task 8: Add feedback, indicators, and UX polish

**Files:**
- Add: `web/feedback.js`
- Modify: `web/fixModelPaths.js`
- Modify: `web/nodeFixCapture.js`

- [ ] **Step 1: Add toast helper**

```javascript
export function showToast(message, duration = 3000) {
  if (typeof app?.ui?.toast === "function") {
    app.ui.toast(message, duration);
    return;
  }

  console.log(message);
}
```

- [ ] **Step 2: Style the ready indicator**

```css
.fix-model-paths-ready {
  background: #2d9f5b;
  color: #ffffff;
  border: 1px solid #8cffb0;
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
}
```

- [ ] **Step 3: Report useful bulk results**

```javascript
async function onFixAllPaths() {
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
```

Expected: user sees whether the workflow was already valid, how many path widgets were fixed, and whether point fixes are still needed.

---

### Task 9: Package as a proper ComfyUI custom node

**Files:**
- Modify: `__init__.py`
- Create: `README.md`

- [ ] **Step 1: Add package metadata**

```python
WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
```

- [ ] **Step 2: Add README**

```markdown
# ComfyUI Fix Model Paths

Adds a ComfyUI canvas right-click menu item named `Fix Model Paths`.

## What it does

`Fix Model Paths` validates the current workflow without queueing it. It only changes model/LoRA path widgets that are part of ComfyUI validation errors. If the workflow already validates, nothing is changed.

## Bulk flow

1. Right-click empty canvas.
2. Choose `Fix Model Paths`.
3. The extension validates the workflow.
4. Matching path widgets on failed nodes are replaced using the local mapping file.
5. The workflow is validated again.
6. If errors remain, use the node-level flow.

## Node-level flow

1. Right-click a node with a broken model/LoRA path.
2. Choose `Fix Node`.
3. The current bad value is stored in memory and the node shows `Ready: Save Fixed`.
4. Select the correct model in the same widget.
5. Click `Ready: Save Fixed` or right-click the node and choose `Save Fixed`.
6. The old value → new value pair is saved locally.

## Local mapping file

Mappings are stored in this plugin folder as:

```text
model_path_mappings.local.json
```

This file is ignored by git.
```

Expected: ComfyUI Manager detects the extension via `__init__.py`, and the local mapping file stays with the plugin but is not committed.

---

### Task 10: Verify in ComfyUI

**Files:**
- None

- [ ] **Step 1: Static Python check**

Run:

```powershell
python -m py_compile __init__.py
```

Expected: exit code `0`.

- [ ] **Step 2: JavaScript syntax check**

Run:

```powershell
node --check web/fixModelPaths.js
node --check web/pathNodeRegistry.js
node --check web/pathResolver.js
node --check web/workflowFixer.js
node --check web/nodeFixCapture.js
node --check web/mappingApi.js
node --check web/nodeDiscovery.js
node --check web/legacyMenuFallback.js
node --check web/feedback.js
```

Expected: each command exits with code `0`.

- [ ] **Step 3: Manual bulk test**

1. Start ComfyUI with this custom node installed.
2. Open a workflow with a broken checkpoint or LoRA path.
3. Confirm ComfyUI validation reports an error.
4. Add a matching `before → after` pair to `model_path_mappings.local.json`.
5. Reload ComfyUI.
6. Right-click empty canvas and choose `Fix Model Paths`.
7. Confirm only the failed path widget changes.
8. Confirm a workflow with no validation errors is not modified.

Expected: bulk repair changes only validation-failing path widgets.

- [ ] **Step 4: Manual node-level test**

1. Open a workflow with a broken model/LoRA node.
2. Right-click the node and choose `Fix Node`.
3. Confirm the node shows `Ready: Save Fixed`.
4. Select the correct model in the same widget.
5. Click `Ready: Save Fixed`.
6. Confirm `model_path_mappings.local.json` contains the old value → new value pair.
7. Reload ComfyUI and confirm the mapping is reused by `Fix Model Paths`.

Expected: per-node capture saves the pair and reuses it later.

---

## Updated decisions

1. Menu label is `Fix Model Paths`, not the typo.
2. Compatibility target: latest/default ComfyUI frontend plus legacy fallback. Legacy support is prioritized with guarded fallback menu hooks.
3. Mapping file is plugin-local: `model_path_mappings.local.json`, ignored by git.
4. Bulk repair validates first and only touches nodes/widgets involved in model/path validation errors.
5. Saved mapping pair:
   - `before`: current bad widget value, usually a model-relative path such as `checkpoints/OldFolder/Model.safetensors`;
   - `after`: newly selected widget value, such as `checkpoints/NewFolder/Model.safetensors`.
6. Matching is case-insensitive. First version compares filename by default to solve same filename under different subfolders; subpath mode is kept as an explicit option.
7. Node handling has two layers:
   - explicit built-in registry for core ComfyUI nodes;
   - discovery/registration support for custom nodes with path-like widgets.

## Spec coverage

- Canvas empty-space right-click menu: Task 5, Task 7.
- Correct menu label `Fix Model Paths`: Task 1, Task 5, Task 7.
- Only failed model/path nodes in bulk mode: Task 2, Task 3.
- Extendable node list: Task 6.
- Custom-node discovery: Task 6.
- Plugin-local non-git mapping file: Task 1, Task 2, Task 9.
- Per-node `Fix Node` capture: Task 4, Task 5.
- Per-node `Save Fixed`: Task 4, Task 5.
- Ready indicator: Task 4, Task 8.
- Case-insensitive matching: Task 3.
- Latest/default plus legacy frontend support: Task 7.

import { DEFAULT_PATH_NODE_LIBRARY } from "./defaultPathNodes.js";

function buildEntry(definition) {
  const entry = {
    nodeType: definition.nodeType,
    comfyClass: definition.comfyClass || definition.nodeType,
    modelType: definition.modelType,
    widgets: [...definition.widgets],
    valueSlots: Array.isArray(definition.valueSlots)
      ? definition.valueSlots.map((slot) => ({ ...slot }))
      : null,
    matches(node) {
      return this.nodeType === node.type || this.comfyClass === node.comfyClass;
    },
  };

  if (entry.valueSlots) {
    entry.getWidgetsFromValues = (node) => {
      const vals = node.widgets_values || [];
      const result = [];

      for (const slot of entry.valueSlots) {
        if (vals[slot.enabledIdx] === "On" && typeof vals[slot.nameIdx] === "string") {
          result.push(vals[slot.nameIdx]);
        }
      }

      return result;
    };
  }

  return entry;
}

export const PATH_NODE_REGISTRY = DEFAULT_PATH_NODE_LIBRARY.map(buildEntry);

export function registerPathNodeRegistryEntry(entry) {
  if (!entry?.nodeType || !Array.isArray(entry.widgets)) {
    throw new Error("Path registry entry requires nodeType and widgets[]");
  }

  const normalized = buildEntry(entry);
  const keyNode = String(normalized.nodeType || "").toLowerCase();
  const keyClass = String(normalized.comfyClass || "").toLowerCase();
  const existingIndex = PATH_NODE_REGISTRY.findIndex((item) => {
    return (
      String(item.nodeType || "").toLowerCase() === keyNode ||
      String(item.comfyClass || "").toLowerCase() === keyClass
    );
  });

  if (existingIndex >= 0) {
    PATH_NODE_REGISTRY[existingIndex] = normalized;
    return;
  }

  PATH_NODE_REGISTRY.push(normalized);
}

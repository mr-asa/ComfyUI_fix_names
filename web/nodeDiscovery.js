const DISCOVERED_NODES = new Map();

const MODEL_TYPE_RULES = [
  {
    modelType: "checkpoints",
    score: 90,
    names: ["ckpt", "checkpoint"],
    outputs: ["model", "clip", "vae"],
  },
  {
    modelType: "loras",
    score: 90,
    names: ["lora"],
    outputs: ["lora"],
  },
  {
    modelType: "vae",
    score: 90,
    names: ["vae"],
    outputs: ["vae"],
  },
  {
    modelType: "controlnet",
    score: 90,
    names: ["control_net", "controlnet", "control net"],
    outputs: ["control_net", "controlnet"],
  },
  {
    modelType: "clips",
    score: 85,
    names: ["clip", "text_encoder", "text encoder"],
    outputs: ["clip"],
  },
  {
    modelType: "diffusers",
    score: 80,
    names: ["diffusers", "diffusion"],
    outputs: ["model"],
  },
  {
    modelType: "upscale_models",
    score: 80,
    names: ["upscale"],
    outputs: ["upscale_model"],
  },
  {
    modelType: "unet",
    score: 75,
    names: ["unet"],
    outputs: ["model"],
  },
  {
    modelType: null,
    score: 55,
    names: ["model", "path", "safetensors", "ckpt", "pth", "pt"],
    outputs: [],
  },
];

const MODEL_FILE_EXTENSIONS = [
  ".safetensors",
  ".ckpt",
  ".pt",
  ".pth",
  ".bin",
  ".gguf",
];

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[\s-]+/g, "_");
}

function normalizeNodeKey(nodeType, nodeData) {
  return nodeData?.name || nodeData?.display_name || nodeType || "";
}

function getOutputNames(nodeData) {
  const outputs = [];
  for (const value of nodeData?.output || []) {
    outputs.push(normalize(value));
  }
  for (const value of nodeData?.output_name || []) {
    outputs.push(normalize(value));
  }
  return outputs;
}

function getWidgetOptions(widgetDef) {
  if (Array.isArray(widgetDef)) {
    return Array.isArray(widgetDef[0]) ? widgetDef[0] : null;
  }

  if (Array.isArray(widgetDef?.options)) {
    return widgetDef.options;
  }

  return null;
}

function hasModelFileOption(options) {
  if (!Array.isArray(options)) return false;
  return options.some((item) => {
    const value = normalize(item);
    return MODEL_FILE_EXTENSIONS.some((ext) => value.endsWith(ext));
  });
}

function guessModelType(widgetName, nodeType, nodeData, options) {
  const nameKey = normalize(widgetName);
  const nodeKey = normalize(`${nodeType} ${nodeData?.display_name || ""}`);
  const outputs = getOutputNames(nodeData);
  const hasModelFiles = hasModelFileOption(options);
  const isLongList = Array.isArray(options) && options.length > 20;
  const genericWidgetHit = ["model", "path"].some((key) => nameKey.includes(key));

  let best = null;
  for (const rule of MODEL_TYPE_RULES) {
    const widgetNameHit = rule.names.some((name) => {
      const key = normalize(name);
      return nameKey.includes(key);
    });
    const nodeNameHit = rule.names.some((name) => {
      const key = normalize(name);
      return nodeKey.includes(key);
    });
    const outputHit = rule.outputs.some((name) => {
      const key = normalize(name);
      return outputs.some((output) => output.includes(key));
    });

    if (!widgetNameHit && !hasModelFiles && !genericWidgetHit) {
      continue;
    }

    let confidence = rule.score;
    if (widgetNameHit) confidence += 12;
    if (nodeNameHit) confidence += 4;
    if (outputHit) confidence += 5;
    if (hasModelFiles) confidence += 10;
    if (isLongList) confidence += 5;

    if (!best || confidence > best.confidence) {
      best = {
        modelType: rule.modelType,
        confidence,
      };
    }
  }

  if (best) {
    return best;
  }

  if (hasModelFiles || nameKey.includes("path")) {
    return {
      modelType: null,
      confidence: hasModelFiles ? 70 : 60,
    };
  }

  return null;
}

function isPathCandidate(widgetName, widgetDef, nodeType, nodeData) {
  const options = getWidgetOptions(widgetDef);
  const nameKey = normalize(widgetName);
  const hasExplicitPathName =
    nameKey.includes("path") ||
    nameKey.includes("name") ||
    nameKey === "model" ||
    nameKey.includes("model_name") ||
    nameKey.includes("model_path") ||
    nameKey.includes("ckpt") ||
    nameKey.includes("checkpoint") ||
    nameKey.includes("lora") ||
    nameKey.includes("vae") ||
    nameKey.includes("clip");
  const optionsLookLikeModelList =
    Array.isArray(options) &&
    (options.length > 20 || hasModelFileOption(options));

  if (!hasExplicitPathName && !optionsLookLikeModelList) {
    return null;
  }

  const guess = guessModelType(widgetName, nodeType, nodeData, options);

  if (!guess) {
    return null;
  }

  if (!optionsLookLikeModelList && guess.confidence < 75) {
    return null;
  }

  return {
    widgetName,
    modelType: guess.modelType,
    confidence: guess.confidence,
  };
}

export function discoverPathWidgetsFromNodeDef(nodeType, nodeData) {
  const widgets = [];
  const inputs = nodeData?.input || {};
  let inputIndex = 0;

  for (const section of ["required", "optional"]) {
    const sectionInputs = inputs[section] || {};

    for (const [widgetName, widgetDef] of Object.entries(sectionInputs)) {
      const candidate = isPathCandidate(widgetName, widgetDef, nodeType, nodeData);
      if (candidate) {
        widgets.push({
          ...candidate,
          index: inputIndex,
          options: getWidgetOptions(widgetDef),
        });
      }

      inputIndex += 1;
    }
  }

  if (widgets.length === 0) {
    return;
  }

  const modelTypeCounts = new Map();
  for (const widget of widgets) {
    if (!widget.modelType) continue;
    modelTypeCounts.set(widget.modelType, (modelTypeCounts.get(widget.modelType) || 0) + 1);
  }

  const modelType = [...modelTypeCounts.entries()]
    .sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const confidence = Math.max(...widgets.map((widget) => widget.confidence));

  DISCOVERED_NODES.set(normalizeNodeKey(nodeType, nodeData), {
    nodeType: normalizeNodeKey(nodeType, nodeData),
    comfyClass: normalizeNodeKey(nodeType, nodeData),
    modelType,
    widgets: widgets.map((widget) => widget.widgetName),
    widgetDetails: widgets,
    confidence,
    source: "discovered",
  });
}

export function getDiscoveredNodeEntryForNode(node) {
  const key = node.type || node.comfyClass || node.constructor?.ComfyClass || "";
  return DISCOVERED_NODES.get(key) || null;
}

export function getDiscoveredWidgetDetailsForNode(node) {
  return getDiscoveredNodeEntryForNode(node)?.widgetDetails || [];
}

export function getDiscoveredWidgetsForNode(node) {
  return getDiscoveredNodeEntryForNode(node)?.widgets || [];
}

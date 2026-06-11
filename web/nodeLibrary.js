import { app } from "/scripts/app.js";
import { showToast } from "./feedback.js";
import { getNodeLibrary, saveNodeLibraryEntry } from "./mappingApi.js";
import { PATH_NODE_REGISTRY, registerPathNodeRegistryEntry } from "./pathNodeRegistry.js";

const KNOWN_MODEL_TYPES = [
  "checkpoints",
  "loras",
  "vae",
  "controlnet",
  "clips",
  "diffusers",
  "upscale_models",
  "embeddings",
  "text_encoders",
];

let libraryCache = null;

export async function loadNodeLibrary() {
  if (libraryCache) return libraryCache;
  try {
    libraryCache = await getNodeLibrary();
  } catch {
    libraryCache = [];
  }
  return libraryCache;
}

export async function refreshNodeLibrary() {
  libraryCache = null;
  return loadNodeLibrary();
}

function buildModelTypeOptions() {
  return KNOWN_MODEL_TYPES.map((t) => `<option value="${t}">${t}</option>`).join("");
}

export function showAddNodeToLibraryDialog(node, widgetNames, beforeAfter) {
  const nodeType = node.type || node.comfyClass || "Unknown";

  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:100000;display:flex;align-items:center;justify-content:center;font-family:system-ui;";

  const dialog = document.createElement("div");
  dialog.style.cssText = "background:#1a1a2e;color:#e0e0e0;border-radius:8px;padding:24px;min-width:420px;max-width:520px;box-shadow:0 8px 32px rgba(0,0,0,0.5);";

  dialog.innerHTML = `
    <h3 style="margin:0 0 16px;font-size:16px;color:#8cffb0;">Add Node to Library</h3>
    <div style="margin-bottom:12px;font-size:13px;">
      <div style="color:#aaa;">Node type:</div>
      <div style="font-weight:bold;color:#fff;">${escapeHtml(nodeType)}</div>
    </div>
    <div style="margin-bottom:12px;font-size:13px;">
      <div style="color:#aaa;">Model type:</div>
      <select id="mpl-model-type" style="width:100%;padding:6px;background:#2a2a4a;color:#e0e0e0;border:1px solid #555;border-radius:4px;margin-top:4px;">
        ${buildModelTypeOptions()}
      </select>
    </div>
    <div style="margin-bottom:12px;font-size:13px;">
      <div style="color:#aaa;">Widgets to track:</div>
      <div id="mpl-widget-list" style="max-height:120px;overflow-y:auto;margin-top:4px;"></div>
    </div>
    ${beforeAfter ? `
    <div style="margin-bottom:16px;font-size:12px;padding:8px;background:#2a2a4a;border-radius:4px;">
      <div style="color:#aaa;">Path mapping saved:</div>
      <div style="color:#8cffb0;word-break:break-all;">${escapeHtml(beforeAfter.before)} → ${escapeHtml(beforeAfter.after)}</div>
    </div>
    ` : ""}
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
      <button id="mpl-cancel" style="padding:8px 16px;background:#444;color:#fff;border:none;border-radius:4px;cursor:pointer;">Cancel</button>
      <button id="mpl-save" style="padding:8px 16px;background:#2d9f5b;color:#fff;border:none;border-radius:4px;cursor:pointer;">Save & Add</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const widgetList = dialog.querySelector("#mpl-widget-list");
  for (const name of widgetNames) {
    const label = document.createElement("label");
    label.style.cssText = "display:flex;align-items:center;gap:6px;padding:3px 0;font-size:12px;";
    label.innerHTML = `<input type="checkbox" value="${escapeHtml(name)}" checked style="accent-color:#2d9f5b;"> ${escapeHtml(name)}`;
    widgetList.appendChild(label);
  }

  dialog.querySelector("#mpl-cancel").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  dialog.querySelector("#mpl-save").addEventListener("click", async () => {
    const modelType = dialog.querySelector("#mpl-model-type").value;
    const checkedWidgets = [...dialog.querySelectorAll("#mpl-widget-list input:checked")].map((cb) => cb.value);

    if (checkedWidgets.length === 0) {
      showToast("Select at least one widget");
      return;
    }

    try {
      await saveNodeLibraryEntry(nodeType, modelType, checkedWidgets);

      registerPathNodeRegistryEntry({
        nodeType,
        comfyClass: nodeType,
        modelType,
        widgets: checkedWidgets,
        matches(n) {
          return n.type === nodeType || n.comfyClass === nodeType;
        },
      });

      showToast(`Node "${nodeType}" added to library`);
    } catch (err) {
      console.error(err);
      showToast(`Failed to save: ${err.message}`);
    }

    overlay.remove();
  });
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

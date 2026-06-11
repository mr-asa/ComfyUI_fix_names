let installed = false;

export function installLegacyCanvasMenu(onFixAllPaths) {
  if (installed || typeof window.LiteGraph === "undefined") {
    return;
  }

  installed = true;

  const originalCanvasMenu =
    window.LiteGraph.LGraphCanvas?.prototype?.getCanvasMenuOptions;

  if (originalCanvasMenu) {
    window.LiteGraph.LGraphCanvas.prototype.getCanvasMenuOptions =
      function (...args) {
        const options = originalCanvasMenu.apply(this, args) || [];
        return [
          ...options,
        null,
        {
          content: "Fix Model Paths 🦊",
          callback: onFixAllPaths,
        },
      ];
      };
  }
}

# ComfyUI Fix Model Paths 🦊

[English](README.md) | [Русский](README.ru.md)

Fixes broken model paths in ComfyUI workflows by trying to find the same name, or the needed variant, in subfolders.

## Installation

Copy or clone the plugin folder into:

```text
ComfyUI/custom_nodes/
```

Restart ComfyUI.

No extra Python packages are required.

## How to use

### Fix the whole workflow

- Open the workflow in ComfyUI.
- Right-click an empty area of the canvas.
- Click `Fix Model Paths 🦊`.

The plugin will try to replace missing paths with matching local models.

### Fix one node manually

Use this if the automatic fix cannot choose the right model.

- Right-click the broken node.
- Click `Fix Node 🦊`.
- Select the correct model in the node itself.
- Confirm the replacement:
  - either right-click the node again and click `Save Fixed 🦊`;
  - or click `Save Fixed 🦊` in the menu that appears in the upper-left part of the node.

The saved fix will be reused next time.

### Search for a missing model

Right-click a broken node and click `Find Model 🦊`.

This opens a web search for the missing model name.

## Matching rules

Names are matched loosely: case and separators are ignored (`flux_dev` = `FluxDev`), and precision/quantization words (`fp8`, `bf16`, `Q4_K_S`, `e4m3fn`, `scaled`, ...) are ignored.

To adjust this, open:

```text
Right-click canvas -> Model Name Rules 🦊
```

- **Ignored words**: add your own words such as `kj` or `comfy-org`, or switch built-in groups off.
- **Aliases**: treat one word as another, e.g. `encoder` = `enc`.
- **Saved replacements**: exact replacements saved by `Save Fixed 🦊`; remove the wrong ones.

Everything is edited with buttons, nothing to type as JSON. Your rules are stored in `model_matching_rules.local.json` (a `.bak` copy is kept on every save); old "model postfixes" are migrated into ignored words automatically. After `Save Fixed 🦊` the plugin may offer to remember a replacement as a general rule. Version numbers (`2509` vs `2511`) never become rules.

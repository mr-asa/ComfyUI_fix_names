# ComfyUI Fix Model Paths

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
- Click `Fix Model Paths`.

The plugin will try to replace missing paths with matching local models.

### Fix one node manually

Use this if the automatic fix cannot choose the right model.

- Right-click the broken node.
- Click `Fix Node`.
- Select the correct model in the node itself.
- Confirm the replacement:
  - either right-click the node again and click `Save Fixed`;
  - or click `Save Fixed` in the menu that appears in the upper-left part of the node.

The saved fix will be reused next time.

### Search for a missing model

Right-click a broken node and click `Find Model`.

This opens a web search for the missing model name.

## Model suffixes

If file names have suffixes like `Comfu-ui`, `kj`, or any other text that is sometimes added to the standard model name, open:

```text
Right-click canvas -> Edit Model Postfixes
```

Add suffixes separated by commas:

```text
kj, comfu-ui
```

This helps the plugin find renamed model variants.

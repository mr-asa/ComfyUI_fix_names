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

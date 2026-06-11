from aiohttp import web
import os
import json
import logging
import server

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY", "read_node_library", "write_node_library"]

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MAPPING_FILE = os.path.join(BASE_DIR, "model_path_mappings.local.json")
NODE_LIBRARY_FILE = os.path.join(BASE_DIR, "custom_node_library.local.json")
POSTFIX_FILE = os.path.join(BASE_DIR, "model_name_postfixes.local.json")


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


def read_node_library():
    if not os.path.exists(NODE_LIBRARY_FILE):
        return []
    try:
        with open(NODE_LIBRARY_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def write_node_library(items):
    tmp_path = f"{NODE_LIBRARY_FILE}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, NODE_LIBRARY_FILE)


def read_postfixes():
    if not os.path.exists(POSTFIX_FILE):
        return []

    try:
        with open(POSTFIX_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, list):
            return []
        return [str(item).strip() for item in data if str(item).strip()]
    except (OSError, json.JSONDecodeError):
        return []


def write_postfixes(items):
    normalized = []
    seen = set()
    for item in items:
        value = str(item).strip()
        key = value.lower()
        if value and key not in seen:
            normalized.append(value)
            seen.add(key)

    tmp_path = f"{POSTFIX_FILE}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(normalized, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, POSTFIX_FILE)


def _log_report_items(title, items, fields):
    if not items:
        return

    print(f"[Fix Model Paths] {title} ({len(items)})")
    for item in items[:200]:
        parts = []
        for field in fields:
            value = item.get(field)
            if value is not None:
                parts.append(f"{field}={value}")
        print("[Fix Model Paths]   " + " | ".join(parts))

    if len(items) > 200:
        print(f"[Fix Model Paths]   ... {len(items) - 200} more")


class _ComfyValidationNoiseFilter(logging.Filter):
    def filter(self, record):
        if os.path.basename(getattr(record, "pathname", "")) != "execution.py":
            return True

        message = record.getMessage()
        return not (
            message.startswith("Failed to validate prompt for output ")
            or message.startswith("* ")
            or message.startswith("  - ")
            or message == "Output will be ignored"
        )


async def validate_prompt_quietly(prompt_id, prompt, partial_execution_list):
    import execution

    root_logger = logging.getLogger()
    noise_filter = _ComfyValidationNoiseFilter()
    root_logger.addFilter(noise_filter)
    try:
        return await execution.validate_prompt(prompt_id, prompt, partial_execution_list)
    finally:
        root_logger.removeFilter(noise_filter)


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


@server.PromptServer.instance.routes.post("/fix_model_paths/validate")
async def validate_workflow_without_queue(request):
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    prompt = payload.get("prompt")
    if not isinstance(prompt, dict):
        return web.json_response({"error": "prompt must be an object"}, status=400)

    import uuid
    valid, error, good_outputs, node_errors = await validate_prompt_quietly(
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


@server.PromptServer.instance.routes.post("/fix_model_paths/log")
async def log_fix_model_paths_report(request):
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    if not isinstance(payload, dict):
        return web.json_response({"error": "payload must be an object"}, status=400)

    fixed = payload.get("fixed") if isinstance(payload.get("fixed"), list) else []
    no_mapping = payload.get("noMapping") if isinstance(payload.get("noMapping"), list) else []
    no_op = payload.get("noOp") if isinstance(payload.get("noOp"), list) else []
    skipped = payload.get("skipped") if isinstance(payload.get("skipped"), list) else []
    remaining_errors = payload.get("remainingErrors")

    print(
        "[Fix Model Paths] Summary: "
        f"fixed={len(fixed)}, noMapping={len(no_mapping)}, "
        f"noOp={len(no_op)}, skipped={len(skipped)}, "
        f"remainingErrors={remaining_errors}"
    )
    _log_report_items("Fixed", fixed, ["nodeId", "nodeType", "widget", "before", "after", "source"])
    _log_report_items("No mapping / no matching available model", no_mapping, ["nodeId", "nodeType", "widget", "value"])
    _log_report_items("Already correct / no-op", no_op, ["nodeId", "nodeType", "widget", "value", "replacement"])
    _log_report_items("Skipped", skipped, ["nodeId", "nodeType", "widget", "reason"])

    return web.json_response({"ok": True})


@server.PromptServer.instance.routes.get("/fix_model_paths/available")
async def get_available_models(request):
    from folder_paths import get_filename_list, folder_names_and_paths

    models = {}
    for model_type in folder_names_and_paths.keys():
        models[model_type] = get_filename_list(model_type)
    return web.json_response(models)


@server.PromptServer.instance.routes.get("/fix_model_paths/node_library")
async def get_node_library(request):
    try:
        return web.json_response(read_node_library())
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@server.PromptServer.instance.routes.post("/fix_model_paths/node_library")
async def save_node_library_entry(request):
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    node_type = payload.get("node_type")
    model_type = payload.get("model_type")
    widgets = payload.get("widgets")

    if not isinstance(node_type, str) or not node_type.strip():
        return web.json_response({"error": "node_type must be a non-empty string"}, status=400)
    if not isinstance(model_type, str) or not model_type.strip():
        return web.json_response({"error": "model_type must be a non-empty string"}, status=400)
    if not isinstance(widgets, list) or len(widgets) == 0:
        return web.json_response({"error": "widgets must be a non-empty array"}, status=400)

    items = [item for item in read_node_library() if isinstance(item, dict)]
    key_node = node_type.strip().lower()

    for item in items:
        if str(item.get("node_type", "")).lower() == key_node:
            item["model_type"] = model_type.strip()
            item["widgets"] = [str(w) for w in widgets]
            break
    else:
        items.append({
            "node_type": node_type.strip(),
            "model_type": model_type.strip(),
            "widgets": [str(w) for w in widgets],
        })

    write_node_library(items)
    return web.json_response({"ok": True, "library": items})


@server.PromptServer.instance.routes.get("/fix_model_paths/postfixes")
async def get_model_name_postfixes(request):
    try:
        return web.json_response(read_postfixes())
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@server.PromptServer.instance.routes.post("/fix_model_paths/postfixes")
async def save_model_name_postfixes(request):
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    postfixes = payload.get("postfixes")
    if not isinstance(postfixes, list):
        return web.json_response({"error": "postfixes must be an array"}, status=400)

    write_postfixes(postfixes)
    return web.json_response({"ok": True, "postfixes": read_postfixes()})

import { getMatchingRules, suggestRuleFromPair } from "./pathResolver.js";
import {
  deleteMapping,
  getMappings,
  getUserMatchingRules,
  loadMatchingRules,
  saveUserMatchingRules,
} from "./mappingApi.js";
import { showToast } from "./feedback.js";

function describeSuggestion(suggestion) {
  if (suggestion.aliases) {
    return Object.entries(suggestion.aliases).map(([from, to]) => `treat "${from}" as "${to}"`).join(", ");
  }
  return `ignore the word(s): ${suggestion.ignore_tokens.join(", ")}`;
}

// After a manual before -> after fix, offers to remember a general rule instead of only the exact pair.
export async function offerRuleSuggestion(before, after) {
  try {
    await loadMatchingRules();
    const suggestion = suggestRuleFromPair(before, after);
    if (!suggestion) return;

    const ok = window.confirm(
      `Remember a general matching rule?\n\n${before}\n-> ${after}\n\nRule: ${describeSuggestion(suggestion)}\n\n` +
      "It will also apply to other model names. You can change it later via 'Model Name Rules'.",
    );
    if (!ok) return;

    const user = await getUserMatchingRules();
    const next = {
      ignore_tokens: [...new Set([...(user.ignore_tokens || []), ...(suggestion.ignore_tokens || [])])],
      aliases: { ...(user.aliases || {}), ...(suggestion.aliases || {}) },
      disabled_defaults: user.disabled_defaults || [],
    };
    await saveUserMatchingRules(next);
    showToast("Matching rule saved");
  } catch (error) {
    console.error(error);
    showToast(`Saving matching rule failed: ${error.message}`);
  }
}

const STYLE = `
.fmr-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10000;display:flex;align-items:center;justify-content:center}
.fmr-box{background:#222;color:#eee;padding:16px;border-radius:8px;width:min(680px,94vw);max-height:90vh;display:flex;flex-direction:column;gap:10px;font:13px sans-serif}
.fmr-title{font-weight:bold;font-size:15px}
.fmr-tabs{display:flex;gap:4px;border-bottom:1px solid #444}
.fmr-tab{background:none;border:none;color:#aaa;padding:6px 12px;cursor:pointer;border-bottom:2px solid transparent}
.fmr-tab.active{color:#fff;border-bottom-color:#2d9f5b}
.fmr-panel{overflow:auto;min-height:200px;max-height:56vh;display:flex;flex-direction:column;gap:8px}
.fmr-help{opacity:.75}
.fmr-chips{display:flex;flex-wrap:wrap;gap:6px}
.fmr-chip{background:#3a3a44;border-radius:12px;padding:2px 4px 2px 10px;display:inline-flex;align-items:center;gap:4px}
.fmr-x{background:none;border:none;color:#e88;cursor:pointer;font-size:14px;padding:0 4px}
.fmr-row{display:flex;gap:6px;align-items:center}
.fmr-row input[type=text]{flex:1;background:#111;color:#eee;border:1px solid #555;padding:4px 6px;border-radius:4px;min-width:0}
.fmr-btn{background:#3a3a44;color:#eee;border:1px solid #666;border-radius:4px;padding:4px 12px;cursor:pointer}
.fmr-btn.primary{background:#2d9f5b;border-color:#8cffb0}
.fmr-btn:disabled{opacity:.4;cursor:default}
.fmr-error{color:#ff8a8a;min-height:16px}
.fmr-pair{display:flex;gap:6px;align-items:center;background:#2c2c33;border-radius:4px;padding:4px 6px}
.fmr-pair span{flex:1;word-break:break-all}
.fmr-list{display:flex;flex-direction:column;gap:6px}
.fmr-card{display:flex;align-items:center;gap:6px;background:#2c2c33;border-radius:4px;padding:5px 8px}
.fmr-card-body{flex:1;min-width:0}
.fmr-line{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fmr-from{color:#c9a0a0;font-size:12px}
.fmr-from::before{content:"was  ";opacity:.6}
.fmr-to{color:#9fe0b4}
.fmr-to::before{content:"now  ";opacity:.6;color:#ccc}
.fmr-folder{opacity:.55;font-size:11px;color:#ccc}
.fmr-panel input[type=text]{background:#111;color:#eee;border:1px solid #555;padding:4px 6px;border-radius:4px}
.fmr-footer{display:flex;gap:8px;justify-content:space-between;align-items:center}
.fmr-check{display:flex;gap:6px;align-items:flex-start;margin:4px 0}
`;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node[key] = value;
  }
  node.append(...children.filter((child) => child != null));
  return node;
}

function cleanWord(value) {
  return String(value || "").trim().toLowerCase();
}

function hasLettersOrDigits(value) {
  return /[a-z0-9]/.test(value);
}

export async function openMatchingRulesEditor() {
  let user;
  let pairs;
  try {
    await loadMatchingRules();
    [user, pairs] = await Promise.all([getUserMatchingRules(), getMappings()]);
  } catch (error) {
    showToast(`Unable to load rules: ${error.message}`);
    return;
  }

  const defaults = getMatchingRules().defaults;
  const state = {
    words: [...(user.ignore_tokens || [])],
    aliases: Object.entries(user.aliases || {}),
    disabled: new Set(user.disabled_defaults || []),
    pairs: pairs.filter((pair) => pair && typeof pair === "object").map((pair) => ({ ...pair })),
    removedPairs: [],
  };
  let activeTab = "words";

  const style = el("style", { textContent: STYLE });
  const overlay = el("div", { class: "fmr-overlay" });
  const box = el("div", { class: "fmr-box" });
  const tabs = el("div", { class: "fmr-tabs" });
  const panel = el("div", { class: "fmr-panel" });
  const error = el("div", { class: "fmr-error" });
  const saveButton = el("button", { class: "fmr-btn primary", textContent: "Save" });
  const cancelButton = el("button", { class: "fmr-btn", textContent: "Cancel" });
  const resetButton = el("button", { class: "fmr-btn", textContent: "Reset my rules" });

  const close = () => {
    overlay.remove();
    style.remove();
  };

  const setError = (message) => {
    error.textContent = message || "";
  };

  function removeButton(onclick) {
    return el("button", { class: "fmr-x", title: "Remove", textContent: "×", onclick });
  }

  function renderWords() {
    const input = el("input", { type: "text", placeholder: "word to ignore, e.g. kj or comfy-org" });
    const add = () => {
      const word = cleanWord(input.value);
      if (!word) return;
      if (!hasLettersOrDigits(word)) {
        setError("A word needs at least one letter or digit.");
        return;
      }
      if (state.words.some((item) => cleanWord(item) === word)) {
        setError(`"${word}" is already in the list.`);
        return;
      }
      state.words.push(word);
      setError("");
      render();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") add();
    });

    const chips = el("div", { class: "fmr-chips" });
    for (const word of state.words) {
      chips.append(el("span", { class: "fmr-chip" }, word, removeButton(() => {
        state.words = state.words.filter((item) => item !== word);
        render();
      })));
    }
    if (state.words.length === 0) {
      chips.append(el("span", { class: "fmr-help", textContent: "No custom words yet." }));
    }

    const builtIn = el("details", {}, el("summary", { textContent: `Built-in word groups (${(defaults.ignore_groups || []).length})` }));
    for (const group of defaults.ignore_groups || []) {
      const checkbox = el("input", {
        type: "checkbox",
        checked: !state.disabled.has(group.id),
        onchange: () => {
          if (checkbox.checked) state.disabled.delete(group.id);
          else state.disabled.add(group.id);
        },
      });
      builtIn.append(el("label", { class: "fmr-check" }, checkbox, group.label));
    }

    panel.append(
      el("div", { class: "fmr-help", textContent: "Words ignored when comparing model names, anywhere in the name (e.g. \"kj\" makes model_kj.safetensors match model.safetensors)." }),
      el("div", { class: "fmr-row" }, input, el("button", { class: "fmr-btn", textContent: "Add", onclick: add })),
      chips,
      builtIn,
    );
  }

  function renderAliases() {
    const from = el("input", { type: "text", placeholder: "word, e.g. encoder" });
    const to = el("input", { type: "text", placeholder: "same as, e.g. enc" });
    const add = () => {
      const a = cleanWord(from.value);
      const b = cleanWord(to.value);
      if (!hasLettersOrDigits(a) || !hasLettersOrDigits(b)) {
        setError("Both words are required.");
        return;
      }
      if (a === b) {
        setError("The two words must differ.");
        return;
      }
      if (state.aliases.some(([key]) => cleanWord(key) === a)) {
        setError(`"${a}" already has an alias.`);
        return;
      }
      state.aliases.push([a, b]);
      setError("");
      render();
    };

    panel.append(
      el("div", { class: "fmr-help", textContent: "Treat one word as another when comparing names." }),
      el("div", { class: "fmr-row" }, from, "=", to, el("button", { class: "fmr-btn", textContent: "Add", onclick: add })),
    );
    for (const [key, value] of state.aliases) {
      panel.append(el("div", { class: "fmr-pair" }, el("span", { textContent: `${key}  =  ${value}` }), removeButton(() => {
        state.aliases = state.aliases.filter(([k]) => k !== key);
        render();
      })));
    }
    if (state.aliases.length === 0) {
      panel.append(el("span", { class: "fmr-help", textContent: "No aliases yet." }));
    }
  }

  function splitPath(value) {
    const text = String(value || "");
    const index = Math.max(text.lastIndexOf("/"), text.lastIndexOf(String.fromCharCode(92)));
    return { folder: index >= 0 ? text.slice(0, index) : "", name: text.slice(index + 1) };
  }

  function renderPairs() {
    const search = el("input", { type: "text", placeholder: "Filter replacements..." });
    const list = el("div", { class: "fmr-list" });

    const fill = () => {
      const query = cleanWord(search.value);
      const items = state.pairs
        .filter((pair) => !query || `${pair.before} ${pair.after}`.toLowerCase().includes(query))
        .sort((x, y) => String(x.after).localeCompare(String(y.after)) || String(x.before).localeCompare(String(y.before)));
      list.replaceChildren();
      for (const pair of items) {
        const from = splitPath(pair.before);
        const to = splitPath(pair.after);
        const card = el("div", { class: "fmr-card" },
          el("div", { class: "fmr-card-body" },
            el("div", { class: "fmr-line fmr-from", title: pair.before, textContent: from.name }),
            el("div", { class: "fmr-line fmr-to", title: pair.after },
              el("span", { textContent: to.name }),
              to.folder ? el("span", { class: "fmr-folder", textContent: `  ${to.folder}` }) : null)),
          removeButton(() => {
            state.removedPairs.push(pair.before);
            state.pairs = state.pairs.filter((item) => item !== pair);
            render();
          }));
        list.append(card);
      }
      if (items.length === 0) {
        list.append(el("span", { class: "fmr-help", textContent: state.pairs.length ? "Nothing matches the filter." : "No saved replacements." }));
      }
    };
    search.addEventListener("input", fill);

    panel.append(
      el("div", { class: "fmr-help", textContent: "Exact replacements saved with 'Save Fixed' (old name, then the model it is replaced with). Hover a line to see the full path. Remove the ones that are no longer right." }),
      search,
      list,
    );
    fill();
  }

  function render() {
    const tabDefs = [
      ["words", "Ignored words"],
      ["aliases", "Aliases"],
      ["pairs", `Saved replacements (${state.pairs.length})`],
    ];
    tabs.replaceChildren(...tabDefs.map(([id, label]) => el("button", {
      class: `fmr-tab${activeTab === id ? " active" : ""}`,
      textContent: label,
      onclick: () => {
        activeTab = id;
        setError("");
        render();
      },
    })));
    panel.replaceChildren();
    if (activeTab === "words") renderWords();
    else if (activeTab === "aliases") renderAliases();
    else renderPairs();
  }

  cancelButton.onclick = close;
  resetButton.onclick = () => {
    if (!window.confirm("Remove all your own words and aliases and re-enable all built-in groups? (Saved replacements are kept.)")) return;
    state.words = [];
    state.aliases = [];
    state.disabled = new Set();
    render();
  };
  saveButton.onclick = async () => {
    saveButton.disabled = true;
    try {
      await saveUserMatchingRules({
        ignore_tokens: state.words,
        aliases: Object.fromEntries(state.aliases),
        disabled_defaults: [...state.disabled],
      });
      for (const before of state.removedPairs) await deleteMapping(before);
      showToast("Rules saved");
      close();
    } catch (err) {
      console.error(err);
      setError(`Save failed: ${err.message}`);
      saveButton.disabled = false;
    }
  };

  box.append(
    el("div", { class: "fmr-title", textContent: "Model name rules" }),
    tabs,
    panel,
    error,
    el("div", { class: "fmr-footer" }, resetButton, el("div", { class: "fmr-row" }, cancelButton, saveButton)),
  );
  overlay.append(box);
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) close();
  });
  document.head.append(style);
  document.body.append(overlay);
  render();
}

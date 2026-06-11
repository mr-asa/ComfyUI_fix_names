import { app } from "/scripts/app.js";

export function showToast(message, duration = 3000) {
  if (typeof app?.ui?.toast === "function") {
    app.ui.toast(message, duration);
    return;
  }

  console.log(message);
}

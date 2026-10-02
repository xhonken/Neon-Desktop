import { t } from "./i18n.js";
export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on"))
      e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v != null) e.setAttribute(k, v);
  }
  e.append(...children.filter((x) => x != null));
  return e;
}
export function button(text, fn, cls = "btn btn-sm btn-neon") {
  return el("button", { type: "button", class: cls, onclick: fn, text });
}
export function field(label, value = "", type = "text") {
  const input = el("input", {
    class: "form-control form-control-sm",
    type,
    value,
  });
  return {
    input,
    row: el("label", { class: "field" }, el("span", { text: label }), input),
  };
}
export function bytes(n) {
  return n >= 2 ** 30
    ? (n / 2 ** 30).toFixed(1) + " GiB"
    : n >= 2 ** 20
      ? (n / 2 ** 20).toFixed(1) + " MiB"
      : n >= 1024
        ? (n / 1024).toFixed(1) + " KiB"
        : n + " B";
}
export function base64(data) {
  let s = "";
  for (let i = 0; i < data.length; i += 8192)
    s += String.fromCharCode(...data.subarray(i, i + 8192));
  return btoa(s);
}
export function unbase64(s) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
export function download(name, data) {
  const a = el("a", {
    href: URL.createObjectURL(new Blob([data])),
    download: name,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
export async function ask(title, initial = "") {
  return new Promise((resolve) => {
    const dialog = el("dialog", { class: "neon-dialog" });
    const f = el("form");
    const input = el("input", {
      class: "form-control",
      value: initial,
      required: true,
    });
    const finish = (value) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    f.append(
      el("h3", { text: title }),
      input,
      el(
        "div",
        { class: "dialog-actions" },
        button(t("Cancel"), () => finish(null)),
        el("button", {
          type: "submit",
          class: "btn btn-primary",
          text: t("Continue"),
        }),
      ),
    );
    f.onsubmit = (e) => {
      e.preventDefault();
      finish(input.value);
    };
    dialog.append(f);
    document.body.append(dialog);
    dialog.addEventListener("cancel", () => finish(null));
    dialog.showModal();
    input.focus();
    input.select();
  });
}
export async function confirmAction(message) {
  return new Promise((resolve) => {
    const d = el("dialog", { class: "neon-dialog" });
    const finish = (v) => {
      d.close();
      d.remove();
      resolve(v);
    };
    d.append(
      el("h3", { text: t("Confirm") }),
      el("p", { text: message }),
      el(
        "div",
        { class: "dialog-actions" },
        button(t("Cancel"), () => finish(false)),
        button(t("Continue"), () => finish(true), "btn btn-danger"),
      ),
    );
    document.body.append(d);
    d.addEventListener("cancel", () => finish(false));
    d.showModal();
  });
}

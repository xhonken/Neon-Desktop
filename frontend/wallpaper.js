import { el, button, base64, unbase64 } from "./ui.js";
export const DEFAULT_WALLPAPER = "/assets/wallpapers/neon-glass.png";
const TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

// Decode and re-encode raster uploads. No SVG, remote URL, or original metadata
// is persisted. The existing UID-bound HOME API remains the only file boundary.
export async function prepareWallpaper(file) {
  if (!TYPES.has(file.type) || file.size > 10 * 1024 ** 2)
    throw Error("Choose a PNG, JPEG or WebP image up to 10 MiB.");
  const bitmap = await createImageBitmap(file);
  try {
    if (
      !bitmap.width ||
      !bitmap.height ||
      bitmap.width * bitmap.height > 40_000_000
    )
      throw Error("Choose an image with at most 40 megapixels.");
    const scale = Math.min(1, 2560 / bitmap.width, 2560 / bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#090e12";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.88),
    );
    if (!blob || blob.size > 5 * 1024 ** 2)
      throw Error("The image is too large after optimization.");
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

export function createWallpaper(host, config, device, call, notify) {
  const layer = el("div", {
    class: "desktop-wallpaper",
    "aria-hidden": "true",
  });
  host.prepend(layer);
  const events = new EventTarget();
  const path = `.config/neon-desktop/wallpaper-${device}.jpg`;
  let cachedVersion,
    cachedUrl,
    pending,
    serial = 0,
    lastFailure;
  const state = {
    url: DEFAULT_WALLPAPER,
    mode: "neon",
    fit: "cover",
    brightness: 1,
  };
  function paint(url, mode) {
    state.url = url;
    state.mode = mode;
    state.fit = config.wallpaperFit === "contain" ? "contain" : "cover";
    state.brightness = Math.max(
      0.25,
      Math.min(1, Number(config.wallpaperBrightness) || 1),
    );
    layer.style.backgroundImage = url ? `url("${url}")` : "none";
    layer.style.backgroundSize = state.fit;
    layer.style.filter = `brightness(${state.brightness})`;
    host.dataset.wallpaper = mode;
    events.dispatchEvent(new Event("change"));
  }
  async function update() {
    const ticket = ++serial;
    const mode = ["neon", "custom", "grid", "plain"].includes(config.wallpaper)
      ? config.wallpaper
      : "neon";
    if (mode !== "custom")
      return paint(mode === "neon" ? DEFAULT_WALLPAPER : "", mode);
    const version = config.wallpaperImage;
    if (typeof version !== "string" || !/^[a-f0-9-]{36}$/.test(version))
      return paint(DEFAULT_WALLPAPER, "neon");
    try {
      if (cachedVersion !== version) {
        if (!pending || pending.version !== version)
          pending = {
            version,
            promise: call("files.read", { path }).then(async (b) => {
              if (typeof b.data !== "string" || b.data.length > 7 * 1024 ** 2)
                throw Error("Invalid background image");
              const bytes = unbase64(b.data);
              if (bytes[0] !== 0xff || bytes[1] !== 0xd8)
                throw Error("Invalid background image");
              const url = `data:image/jpeg;base64,${b.data}`;
              const image = new Image();
              image.src = url;
              await image.decode();
              return url;
            }),
          };
        const work = pending;
        const url = await work.promise;
        if (ticket !== serial) return;
        cachedUrl = url;
        cachedVersion = version;
      }
      if (ticket === serial) paint(cachedUrl, mode);
    } catch {
      pending = null;
      if (ticket !== serial) return;
      paint(DEFAULT_WALLPAPER, "neon");
      if (lastFailure !== version)
        notify(
          "Your background could not be loaded. Neon Glass is shown; choose the image again in Settings.",
        );
      lastFailure = version;
    }
  }
  return { update, events, state, path };
}

export function wallpaperControls(w, c) {
  const box = el("section", {
    class: "wallpaper-settings",
    "aria-label": "Desktop background",
  });
  const preview = el("div", {
    class: "wallpaper-preview",
    role: "img",
    "aria-label": "Background preview",
  });
  const mode = el(
    "select",
    { class: "form-select form-select-sm", "aria-label": "Background" },
    ...[
      ["neon", "Neon Glass"],
      ["grid", "Classic grid"],
      ["plain", "Dark graphite"],
      ["custom", "My image"],
    ].map(([value, text]) => el("option", { value, text })),
  );
  const fit = el(
    "select",
    { class: "form-select form-select-sm", "aria-label": "Image fit" },
    el("option", { value: "cover", text: "Fill screen (crop edges)" }),
    el("option", { value: "contain", text: "Fit entire image" }),
  );
  const dim = el("input", {
    type: "range",
    min: "25",
    max: "100",
    step: "5",
    "aria-label": "Background brightness",
  });
  const amount = el("output");
  const status = el("p", { class: "muted", role: "status" });
  const file = el("input", {
    type: "file",
    accept: "image/png,image/jpeg,image/webp",
    hidden: "",
    "aria-label": "Choose background image",
  });
  let busy = false;
  const upload = button("Choose image…", () => file.click());
  const remove = button("Remove my image", async () => {
    if (busy) return;
    busy = true;
    refresh();
    try {
      await c.call("files.delete", { path: c.wallpaper.path });
      delete c.config.wallpaperImage;
      c.config.wallpaper = "neon";
      c.apply();
      await c.flush();
      status.textContent = "Personal background removed.";
    } catch (e) {
      status.textContent = e.message;
    } finally {
      busy = false;
      refresh();
    }
  });
  function refresh() {
    const s = c.wallpaper.state;
    preview.style.backgroundImage = s.url ? `url("${s.url}")` : "none";
    preview.style.backgroundSize = s.fit;
    preview.style.filter = `brightness(${s.brightness})`;
    preview.dataset.wallpaper = s.mode;
    mode.value = c.config.wallpaper || "neon";
    mode.querySelector('[value="custom"]').disabled = !c.config.wallpaperImage;
    fit.value = s.fit;
    dim.value = String(Math.round(s.brightness * 100));
    amount.textContent = `${dim.value}%`;
    upload.disabled = remove.disabled = mode.disabled = busy;
    remove.hidden = !c.config.wallpaperImage;
  }
  function change(key, value) {
    c.config[key] = value;
    c.apply();
    c.save();
    refresh();
  }
  mode.onchange = () => change("wallpaper", mode.value);
  fit.onchange = () => change("wallpaperFit", fit.value);
  dim.oninput = () => change("wallpaperBrightness", Number(dim.value) / 100);
  file.onchange = async () => {
    const selected = file.files[0];
    if (!selected || busy) return;
    busy = true;
    refresh();
    status.textContent = "Preparing your image…";
    try {
      const data = await prepareWallpaper(selected);
      await c.call("files.write", {
        path: c.wallpaper.path,
        data: base64(data),
      });
      c.config.wallpaperImage = crypto.randomUUID();
      c.config.wallpaper = "custom";
      await c.wallpaper.update();
      await c.flush();
      status.textContent =
        "Background saved for this desktop. Your original file is unchanged.";
    } catch (e) {
      status.textContent = e.message;
    } finally {
      busy = false;
      file.value = "";
      refresh();
    }
  };
  box.append(
    el("h3", { class: "h6 mt-4", text: "Desktop background" }),
    preview,
    el("label", { class: "field" }, el("span", { text: "Background" }), mode),
    el("label", { class: "field" }, el("span", { text: "Image fit" }), fit),
    el(
      "label",
      { class: "field" },
      el("span", { text: "Brightness" }),
      el("div", { class: "wallpaper-brightness" }, dim, amount),
    ),
    el("div", { class: "wallpaper-actions" }, upload, remove),
    file,
    status,
    el("p", {
      class: "muted",
      text: "PNG, JPEG or WebP · up to 10 MiB / 40 MP. Stored privately in your HOME, optimized to a maximum 2560-pixel edge. Background preferences follow this browser's desktop layout.",
    }),
  );
  c.wallpaper.events.addEventListener("change", refresh);
  refresh();
  return {
    element: box,
    cleanup: () => c.wallpaper.events.removeEventListener("change", refresh),
  };
}

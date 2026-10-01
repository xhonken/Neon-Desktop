import { el, button, confirmAction } from "../ui.js";
export async function mount(w, c) {
  const toolbar = el("div", { class: "toolbar" }),
    address = el("input", {
      class: "form-control form-control-sm path-input",
      "aria-label": "Web address",
      placeholder: "https://…",
    }),
    screen = el("div", {
      class: "browser-screen",
      tabindex: "0",
      "aria-label": "Remote browser view",
    }),
    img = el("img", { alt: "Remote Chromium display", draggable: "false" }),
    status = el("div", {
      class: "app-status",
      text: "Starting isolated Chromium…",
    });
  screen.append(img);
  w.content.append(toolbar, screen, status);
  let ws,
    objectURL,
    disposed = false;
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      c.notify(e.message);
    }
  };
  async function navigate() {
    let url = address.value;
    if (!url.includes("://")) url = "https://" + url;
    status.textContent = "Loading…";
    const b = await c.call("browser.navigate", { url });
    address.value = b.url;
    status.textContent = b.error || "Chromium · private Linux user profile";
  }
  toolbar.append(
    button(
      "←",
      run(async () => {
        const b = await c.call("browser.back");
        address.value = b.url;
      }),
    ),
    button(
      "↻",
      run(async () => c.call("browser.reload")),
    ),
    address,
    button("Go", run(navigate)),
    button(
      "End session",
      run(async () => {
        if (
          await confirmAction(
            "Stop Chromium? Open pages will close; your profile is retained.",
          )
        ) {
          await c.call("browser.stop");
          status.textContent = "Browser session stopped";
        }
      }),
    ),
  );
  address.onkeydown = (e) => {
    if (e.key === "Enter") run(navigate)();
  };
  const b = await c.call("browser.start");
  address.value = b.url === "about:blank" ? "" : b.url;
  ws = new WebSocket(
    `${location.origin.replace("https:", "wss:")}/api/v1/stream/browser/view?app=${c.app.id}&csrf=${encodeURIComponent(c.identity.csrf)}`,
  );
  ws.binaryType = "blob";
  const send = (b) => {
    if (ws?.readyState === 1) ws.send(JSON.stringify(b));
  };
  let resizeTimer;
  const observer = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (screen.clientWidth > 0)
        send({
          type: "resize",
          width: screen.clientWidth,
          height: screen.clientHeight,
        });
    }, 150);
  });
  observer.observe(screen);
  ws.onopen = () => {
    send({
      type: "resize",
      width: screen.clientWidth,
      height: screen.clientHeight,
    });
    status.textContent = "Chromium · private Linux user profile";
  };
  ws.onmessage = (e) => {
    if (e.data instanceof Blob) {
      const old = objectURL;
      objectURL = URL.createObjectURL(e.data);
      img.src = objectURL;
      if (old) URL.revokeObjectURL(old);
    } else {
      const b = JSON.parse(e.data);
      if (b.error) c.notify(b.error);
    }
  };
  ws.onclose = () => {
    if (!disposed)
      status.textContent = "Browser disconnected. Reopen the app to reconnect.";
  };
  const pointer = (e, event) => {
    e.preventDefault();
    screen.focus();
    const r = img.getBoundingClientRect();
    send({
      type: "mouse",
      event,
      x: (e.clientX - r.left) * (img.naturalWidth / r.width || 1),
      y: (e.clientY - r.top) * (img.naturalHeight / r.height || 1),
      button: e.button === 2 ? "right" : "left",
      dx: 0,
      dy: 0,
    });
  };
  img.onpointerdown = (e) => pointer(e, "mousePressed");
  img.onpointerup = (e) => pointer(e, "mouseReleased");
  img.oncontextmenu = (e) => e.preventDefault();
  screen.onwheel = (e) => {
    e.preventDefault();
    const r = img.getBoundingClientRect();
    send({
      type: "mouse",
      event: "mouseWheel",
      x: e.clientX - r.left,
      y: e.clientY - r.top,
      dx: e.deltaX,
      dy: e.deltaY,
    });
  };
  screen.onkeydown = (e) => {
    e.preventDefault();
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey)
      send({ type: "text", text: e.key });
    else {
      const key = [
        e.ctrlKey ? "Control" : null,
        e.altKey ? "Alt" : null,
        e.shiftKey ? "Shift" : null,
        e.metaKey ? "Meta" : null,
        e.key === " " ? "Space" : e.key,
      ]
        .filter(Boolean)
        .join("+");
      send({ type: "key", key });
    }
  };
  screen.onpaste = (e) => {
    e.preventDefault();
    send({ type: "text", text: e.clipboardData.getData("text") });
  };
  w.cleanup = () => {
    disposed = true;
    clearTimeout(resizeTimer);
    observer.disconnect();
    ws?.close();
    if (objectURL) URL.revokeObjectURL(objectURL);
  };
}

// Installed HTTPS/PAM acceptance; synthetic credentials arrive through stdin.
import assert from "node:assert/strict";
import fs from "node:fs";
import puppeteer from "puppeteer-core";

const [origin, username] = process.argv.slice(2);
let { password } = JSON.parse(fs.readFileSync(0, "utf8"));
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  pipe: true,
  acceptInsecureCerts: true,
  args: ["--disable-dev-shm-usage"],
});
const errors = [],
  results = {};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function device(width, height) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width, height });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.evaluateOnNewDocument(() => {
    const Base = window.WebSocket;
    window.neonTestSockets = [];
    window.WebSocket = class extends Base {
      constructor(...args) {
        super(...args);
        window.neonTestSockets.push(this);
      }
    };
  });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.type("#username", username);
  await page.type("#password", password);
  await page.click("#login button");
  await page.waitForSelector(".desktop-surface", { timeout: 20000 });
  return page;
}
async function rpc(page, app, action, args = {}) {
  return page.evaluate(
    async ({ app, action, args }) => {
      const me = await (await fetch("/api/v1/me")).json();
      const r = await fetch("/api/v1/rpc", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": me.csrf,
        },
        body: JSON.stringify({ app, action, ...args }),
      });
      const result = await r.json();
      if (!r.ok) throw Error(result.error || `RPC failed: ${r.status}`);
      return result;
    },
    { app, action, args },
  );
}
const windows = (page) =>
  page.$$eval(".desktop-window", (nodes) =>
    nodes.map((n) => n.dataset.windowId),
  );
const win = (id) => `.desktop-window[data-window-id="${id}"]`;
async function launch(page, name) {
  const before = await windows(page);
  await page.click(".launcher-toggle");
  await page.evaluate((name) => {
    [...document.querySelectorAll(".launcher-app")]
      .find((n) => n.lastElementChild?.textContent === name)
      ?.click();
  }, name);
  await page.waitForFunction(
    (before) =>
      [...document.querySelectorAll(".desktop-window")].some(
        (n) => !before.includes(n.dataset.windowId),
      ),
    {},
    before,
  );
  const id = (await windows(page)).find((i) => !before.includes(i));
  await page.waitForFunction(
    (id) => !document.querySelector(`[data-window-id="${id}"] .loading`),
    {},
    id,
  );
  return id;
}
async function saved(page, count) {
  for (let i = 0; i < 60; i++) {
    const d = await rpc(page, "org.neon.settings", "config.get");
    if (d.windows.length === count) return d.windows;
    await pause(100);
  }
  throw Error(`Shared layout did not reach ${count} windows`);
}
async function type(page, id, command) {
  await page.waitForSelector(`${win(id)} .xterm-screen`);
  await page.waitForFunction(
    (id) =>
      document
        .querySelector(`[data-window-id="${id}"] .app-status`)
        ?.textContent.startsWith("Connected") ||
      document
        .querySelector(`[data-window-id="${id}"] .app-status`)
        ?.textContent.startsWith("View only"),
    {},
    id,
  );
  const point = await page.evaluate((id) => {
    const nodes = [...document.querySelectorAll(".desktop-window")];
    const index = nodes.findIndex((n) => n.dataset.windowId === id);
    const box = document
      .querySelectorAll(".taskbar .task")
      [index].getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }, id);
  await page.mouse.click(point.x, point.y);
  await page.click(`${win(id)} .terminal-host`);
  // Begin immediately: the first character must survive an in-flight claim.
  await page.keyboard.type(command, { delay: 1 });
  await page.keyboard.press("Enter");
}
async function file(page, name, expected) {
  for (let i = 0; i < 60; i++) {
    try {
      const data = await rpc(page, "org.neon.files", "files.read", {
        path: name,
      });
      if (Buffer.from(data.data, "base64").toString() === expected) return;
    } catch {}
    await pause(100);
  }
  throw Error(`Expected real PTY output in ${name}`);
}
try {
  const a = await device(1440, 1000);
  const first = await launch(a, "Terminal");
  const me = await a.evaluate(async () => (await fetch("/api/v1/me")).json());
  await type(a, first, "id -u > continuity-uid.txt");
  await file(a, "continuity-uid.txt", `${me.uid}\n`);
  console.log("Installed PAM login and actual PTY UID PASS");
  const second = await launch(a, "Terminal");
  await a.click(`${win(second)} button[aria-label="Minimize"]`);
  const files = await launch(a, "Files");
  await a.click(`${win(files)} button[aria-label="Maximize or restore"]`);
  const code = await launch(a, "Code");
  await a.waitForSelector(`${win(code)} .cm-content`);
  await a.click(`${win(code)} .cm-content`);
  await a.keyboard.type("private unsaved continuity draft");
  await pause(1500);
  const original = await saved(a, 4);
  const processes = (
    await rpc(a, "org.neon.terminal", "terminal.list")
  ).terminals.map((t) => ({ id: t.id, pid: t.pid }));
  assert.equal(processes.length, 2);
  assert.equal(
    await a.$eval("body", (n) => n.textContent.includes("Take control")),
    false,
  );

  const b = await device(1100, 800);
  await b.waitForFunction(
    () => document.querySelectorAll(".desktop-window").length === 4,
  );
  await b.waitForSelector(`${win(code)} .cm-content`);
  assert.deepEqual((await windows(b)).sort(), original.map((w) => w.id).sort());
  assert.equal(await b.$eval(win(second), (n) => n.hidden), true);
  assert.match(
    await b.$eval(`${win(code)} .cm-content`, (n) => n.textContent),
    /private unsaved continuity draft/,
  );
  const geometry = await b.$eval(win(files), (n) => ({
    w: n.offsetWidth,
    x: n.offsetLeft,
  }));
  assert.equal(geometry.x, 0);
  assert.equal(geometry.w, 1100);
  assert.deepEqual(
    (await rpc(b, "org.neon.terminal", "terminal.list")).terminals.map((t) => ({
      id: t.id,
      pid: t.pid,
    })),
    processes,
  );
  results.crossDeviceWindowsAndDraft = true;
  results.sameTerminalProcesses = true;
  fs.mkdirSync("artifacts", { recursive: true, mode: 0o700 });
  await b.screenshot({ path: "artifacts/continuity-second-device.png" });
  console.log(
    "Cross-device windows, draft, minimization, maximization and same PIDs PASS",
  );
  await type(b, first, "printf B > continuity-input.txt");
  await file(b, "continuity-input.txt", "B");
  await type(a, first, "printf A > continuity-input.txt");
  await file(a, "continuity-input.txt", "A");
  results.clickTransfersControl = true;

  await a.setOfflineMode(true);
  await a.evaluate(() => window.neonTestSockets.forEach((s) => s.close()));
  await pause(300);
  await a.click(`${win(first)} .terminal-host`);
  await a.keyboard.type("printf OFFLINE > continuity-input.txt");
  await a.keyboard.press("Enter");
  await a.setOfflineMode(false);
  await a.waitForFunction(
    (id) =>
      document
        .querySelector(`[data-window-id="${id}"] .app-status`)
        ?.textContent.startsWith("Connected"),
    { timeout: 20000 },
    first,
  );
  await file(a, "continuity-input.txt", "A");
  await type(a, first, "printf RESUMED > continuity-input.txt");
  await file(a, "continuity-input.txt", "RESUMED");
  results.reconnectAndNoOfflineReplay = true;

  // A stale view on B must not resurrect a window explicitly closed on A.
  await a.click(`${win(files)} button[aria-label="Close"]`);
  await saved(a, 3);
  await b.click(`${win(first)} .terminal-host`);
  await pause(600);
  assert.equal(
    (await rpc(b, "org.neon.settings", "config.get")).windows.some(
      (w) => w.id === files,
    ),
    false,
  );
  await b.reload({ waitUntil: "domcontentloaded" });
  await b.waitForFunction(
    () => document.querySelectorAll(".desktop-window").length === 3,
  );
  await b.waitForSelector(`${win(code)} .cm-content`);
  assert.equal(await b.$(win(files)), null);
  await type(b, first, "printf RELOADED > continuity-input.txt");
  await file(b, "continuity-input.txt", "RELOADED");
  assert.deepEqual(
    (await rpc(b, "org.neon.terminal", "terminal.list")).terminals.map((t) => ({
      id: t.id,
      pid: t.pid,
    })),
    processes,
  );
  results.reloadAndStaleLayout = true;
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      { ...results, uid: me.uid, javascriptErrors: errors },
      null,
      2,
    ),
  );
} finally {
  password = null;
  await browser.close();
}

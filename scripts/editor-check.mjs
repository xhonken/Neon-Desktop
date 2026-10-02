import puppeteer from "puppeteer-core";
import readline from "node:readline/promises";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const [origin, username, sshPort] = process.argv.slice(2);
const rl = readline.createInterface({ input: process.stdin, terminal: false });
const secrets = JSON.parse((await rl[Symbol.asyncIterator]().next()).value);
rl.close();
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  pipe: true,
  acceptInsecureCerts: true,
  defaultViewport: { width: 1540, height: 1040 },
});
const page = await browser.newPage(),
  errors = [],
  results = {};
page.on("pageerror", (e) => errors.push(e.message));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const client = randomUUID(),
  other = randomUUID();
let me;
async function eventually(fn) {
  let error;
  for (let i = 0; i < 50; i++) {
    try {
      return await fn();
    } catch (e) {
      error = e;
      await wait(400);
    }
  }
  throw error;
}
async function login() {
  await page.waitForSelector("#login");
  await page.type("#username", username);
  await page.type("#password", secrets.password);
  await page.click("#login button");
  await page.waitForSelector(".desktop-surface", { timeout: 20000 });
  me = await page.evaluate(async () => (await fetch("/api/v1/me")).json());
}
async function rpc(action, args = {}, app = "org.neon.connections") {
  return page.evaluate(
    async ({ action, args, app, csrf, client }) => {
      const r = await fetch("/api/v1/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({ client, ...args, app, action }),
      });
      if (!r.ok) throw Error(`${action}: ${r.status} ${await r.text()}`);
      return r.json();
    },
    { action, args, app, csrf: me.csrf, client },
  );
}
const job = (action, args = {}) => rpc(action, args, "org.neon.jobs");
const file = (action, args = {}) => rpc(action, args, "org.neon.code");
async function read(path) {
  return Buffer.from(
    (await file("files.read", { path })).data,
    "base64",
  ).toString();
}
async function write(path, text, extra = {}) {
  return file("files.write", {
    path,
    data: Buffer.from(text).toString("base64"),
    ...extra,
  });
}
async function click(text, scope = "") {
  await page.evaluate(
    ({ text, scope }) => {
      const e = [...document.querySelectorAll(scope + " button")].find(
        (e) => e.textContent === text,
      );
      if (!e) throw Error("Missing button " + text);
      e.click();
    },
    { text, scope },
  );
}
async function field(label, value) {
  await page.waitForFunction(
    (label) =>
      [
        ...document.querySelectorAll(
          '.desktop-window[aria-label="SSH Connections"] label',
        ),
      ].some((e) => e.firstElementChild?.textContent === label),
    {},
    label,
  );
  await page.evaluate(
    ({ label, value }) => {
      const e = [
        ...document.querySelectorAll(
          '.desktop-window[aria-label="SSH Connections"] label',
        ),
      ]
        .find((e) => e.firstElementChild?.textContent === label)
        ?.querySelector("input");
      if (!e) throw Error("Missing field " + label);
      e.value = value;
      e.dispatchEvent(new Event("input", { bubbles: true }));
    },
    { label, value },
  );
}
async function launch(name) {
  await page.click(".launcher-toggle");
  await page.$eval(".launcher-search", (e) => {
    e.value = "";
    e.dispatchEvent(new Event("input"));
  });
  await page.type(".launcher-search", name);
  await page.evaluate(
    (name) =>
      [...document.querySelectorAll(".launcher-app")]
        .find((e) => e.lastElementChild.textContent === name)
        .click(),
    name,
  );
  await page.waitForSelector(`.desktop-window[aria-label="${name}"]`);
  await wait(600);
}
async function input(id, text, view = client, claim = true) {
  if (claim)
    await rpc("terminal.claim", { id, client: view }, "org.neon.terminal");
  return page.evaluate(
    async ({ id, text, csrf, view }) => {
      const ws = new WebSocket(
        `${location.origin.replace("https:", "wss:")}/api/v1/stream/terminal/${id}?app=org.neon.terminal&csrf=${encodeURIComponent(csrf)}&view=${view}`,
      );
      let out = "",
        readonly;
      ws.onmessage = (e) => {
        if (typeof e.data === "string") {
          const b = JSON.parse(e.data);
          if ("readonly" in b) readonly = b.readonly;
        } else e.data.text().then((t) => (out += t));
      };
      await new Promise((r, j) => {
        ws.onopen = r;
        ws.onerror = j;
      });
      await new Promise((r) => setTimeout(r, 100));
      ws.send(JSON.stringify({ type: "input", data: text }));
      await new Promise((r) => setTimeout(r, 600));
      ws.close();
      return { out, readonly };
    },
    { id, text, csrf: me.csrf, view },
  );
}
try {
  await page.goto(origin);
  await login();
  await write("history.txt", "before");
  await write("history.txt", "taken over");

  await file("document.lease", {
    path: "history.txt",
    client: other,
    release: true,
  });
  await launch("Code");
  await click("Open", '.desktop-window[aria-label="Code"]');
  await page.waitForSelector("dialog form input");
  await page.$eval("dialog form input", (e) => (e.value = "history.txt"));
  await page.click("dialog form button[type=submit]");
  await page.waitForFunction(() =>
    document.querySelector(".cm-content")?.textContent.includes("taken over"),
  );
  await click("History", '.desktop-window[aria-label="Code"]');
  await page.waitForSelector(".history-dialog .settings-item");
  await page.click(".history-dialog .settings-item");
  await page.waitForSelector(".history-comparison");
  assert.equal((await page.$$(".history-comparison pre")).length, 2);
  await click("Restore this version", ".history-dialog");
  await page.waitForSelector("dialog .btn-danger");
  await page.click("dialog .btn-danger");
  await page.waitForFunction(() => !document.querySelector(".history-dialog"));
  assert.equal(
    await page.$eval(".cm-content", (e) => e.textContent),
    await read("history.txt"),
  );
  results.historyGraphicalCompareRestore = true;
  await page.click(".cm-content");
  await page.keyboard.press("End");
  await page.keyboard.type(" first-view-draft");
  await wait(1500);
  const secondPage = await browser.newPage();
  secondPage.on("pageerror", (e) => errors.push(e.message));
  await secondPage.goto(origin);
  await secondPage.waitForSelector(".cm-content");
  assert.equal(
    await secondPage.$eval(".cm-content", (e) =>
      e.getAttribute("contenteditable"),
    ),
    "false",
  );
  await secondPage.evaluate(() =>
    [...document.querySelectorAll('.desktop-window[aria-label="Code"] button')]
      .find((e) => e.textContent === "Take editing control")
      .click(),
  );
  await secondPage.waitForSelector("dialog .btn-danger");
  await secondPage.click("dialog .btn-danger");
  await secondPage.waitForFunction(
    () =>
      document.querySelector(".cm-content")?.getAttribute("contenteditable") ===
      "true",
  );
  await page.bringToFront();
  await page.waitForFunction(
    () =>
      document.querySelector(".cm-content")?.getAttribute("contenteditable") ===
      "false",
    { timeout: 30000 },
  );
  assert.match(
    await page.$eval(".cm-content", (e) => e.textContent),
    /first-view-draft/,
  );
  await secondPage.close();
  results.twoLiveEditorViewsAndDraftPreservation = true;

  assert.deepEqual(errors, []);
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}

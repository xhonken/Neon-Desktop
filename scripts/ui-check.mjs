import puppeteer from "puppeteer-core";
import readline from "node:readline/promises";
import assert from "node:assert/strict";
import fs from "node:fs";
const origin = process.argv[2],
  username = process.argv[3];
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});
let password = await rl.question("PAM password (echo disabled): ");
rl.close();
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  pipe: true,
  acceptInsecureCerts: true,
  defaultViewport: { width: 1440, height: 1000 },
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let me, ownedFile;
const results = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(app, action, args = {}) {
  return page.evaluate(
    async ({ app, action, args, csrf }) => {
      const r = await fetch("/api/v1/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({ app, action, ...args }),
      });
      if (!r.ok) throw Error(await r.text());
      return r.json();
    },
    { app, action, args, csrf: me.csrf },
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
        .find((e) => e.lastElementChild?.textContent === name)
        ?.click(),
    name,
  );
  await sleep(500);
  return (await page.$$(`.desktop-window[aria-label="${name}"]`)).at(-1);
}
try {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.type("#username", username);
  await page.type("#password", password);
  password = null;
  await page.click("#login button");
  await page.waitForSelector(".desktop-surface");
  me = await page.evaluate(
    async () => await (await fetch("/api/v1/me")).json(),
  );
  await sleep(1500);
  const code = await launch("Code");
  await code.waitForSelector(".cm-content");
  const title = await code.$(".window-titlebar"),
    tb = await title.boundingBox(),
    old = await code.boundingBox();
  await page.mouse.move(tb.x + 150, tb.y + 15);
  await page.mouse.down();
  await page.mouse.move(tb.x + 90, tb.y - 30, { steps: 8 });
  await page.mouse.up();
  const moved = await code.boundingBox();
  assert(Math.abs(moved.x - old.x) > 20);
  assert(Math.abs(moved.y - old.y) > 20);
  results.move = true;
  const handle = await code.$(".resize-handle.se"),
    hb = await handle.boundingBox();
  await page.mouse.move(hb.x + 5, hb.y + 5);
  await page.mouse.down();
  await page.mouse.move(hb.x - 70, hb.y - 60, { steps: 8 });
  await page.mouse.up();
  const resized = await code.boundingBox();
  assert(resized.width < moved.width - 30);
  assert(resized.height < moved.height - 30);
  results.cornerResize = true;
  const east = await code.$(".resize-handle.e"),
    eb = await east.boundingBox();
  await page.mouse.move(eb.x + 3, eb.y + 80);
  await page.mouse.down();
  await page.mouse.move(eb.x - 50, eb.y + 80, { steps: 8 });
  await page.mouse.up();
  assert((await code.boundingBox()).width < resized.width - 20);
  results.edgeResize = true;
  await (await code.$('button[aria-label="Maximize or restore"]')).click();
  assert((await code.boundingBox()).width >= 1435);
  await (await code.$('button[aria-label="Maximize or restore"]')).click();
  assert((await code.boundingBox()).width < 1400);
  results.maximizeRestore = true;
  await (await code.$('button[aria-label="Minimize"]')).click();
  assert.equal(await code.evaluate((e) => e.hidden), true);
  await page.evaluate(() =>
    [...document.querySelectorAll(".task")]
      .filter((e) => e.textContent.includes("Code"))
      .at(-1)
      .click(),
  );
  assert.equal(await code.evaluate((e) => e.hidden), false);
  results.minimizeRestore = true;
  await (await code.$(".cm-content")).click();
  await page.keyboard.type('print("Neon editor save verified")\n');
  await page.keyboard.down("Control");
  await page.keyboard.press("s");
  await page.keyboard.up("Control");
  await page.waitForSelector("dialog[open] input");
  ownedFile = ".neon-ui-" + Date.now() + ".py";
  await page.$eval("dialog[open] input", (e, p) => (e.value = p), ownedFile);
  await page.click('dialog[open] button[type="submit"]');
  await sleep(500);
  assert.equal(
    fs.readFileSync(`${me.home}/${ownedFile}`, "utf8"),
    'print("Neon editor save verified")\n',
  );
  results.editorSave = true;
  await page.screenshot({ path: "artifacts/editor-verified.png" });
  const app = await launch("SDK Example");
  await page.waitForSelector("dialog[open]", { timeout: 1500 }).catch(() => {});
  await page.evaluate(() =>
    [...document.querySelectorAll("dialog[open] button")]
      .find((e) => e.textContent === "Continue")
      ?.click(),
  );
  await app.waitForSelector("iframe");
  const frame = await (await app.$("iframe")).contentFrame();
  await frame.waitForSelector("#notify");
  const isolation = await frame.evaluate(() => {
    let dom = false,
      cookie = false;
    try {
      void parent.document.body;
    } catch {
      dom = true;
    }
    try {
      void document.cookie;
    } catch {
      cookie = true;
    }
    return { dom, cookie };
  });
  assert(isolation.dom && isolation.cookie);
  await frame.click("#notify");
  await frame.waitForFunction(
    () =>
      document.querySelector("#result").textContent === "Notification sent.",
  );
  results.sdkOpaqueOrigin = true;
  results.sdkNotification = true;
  const denied = await frame.evaluate(async () => {
    return await new Promise((resolve) => {
      const id = crypto.randomUUID();
      addEventListener("message", function handler(e) {
        if (e.source === parent && e.data?.id === id) {
          removeEventListener("message", handler);
          resolve(e.data.error);
        }
      });
      parent.postMessage(
        {
          channel: "neon-sdk-v1",
          id,
          action: "files.list",
          args: { path: "." },
        },
        "*",
      );
    });
  });
  assert(denied);
  results.sdkUndeclaredFilesDenied = true;
  const forged = await frame.evaluate(
    async () =>
      await new Promise((resolve) => {
        const id = crypto.randomUUID();
        addEventListener("message", function handler(e) {
          if (e.source === parent && e.data?.id === id) {
            removeEventListener("message", handler);
            resolve(e.data.error);
          }
        });
        parent.postMessage(
          {
            channel: "neon-sdk-v1",
            id,
            action: "files.list",
            args: { app: "org.neon.terminal", action: "terminal.create" },
          },
          "*",
        );
      }),
  );
  assert(forged);
  results.sdkIdentityOverrideDenied = true;

  await page.screenshot({ path: "artifacts/sdk-verified.png" });
  assert.deepEqual(errors, []);
  results.consoleErrors = errors;
  fs.writeFileSync("artifacts/ui-check.json", JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} catch (e) {
  await page.screenshot({ path: "artifacts/ui-failure.png" }).catch(() => {});
  console.error(e.stack);
  console.error(errors);
  process.exitCode = 1;
} finally {
  if (ownedFile && me)
    await rpc("org.neon.files", "files.delete", { path: ownedFile }).catch(
      () => {},
    );
  await page
    .evaluate(async () => {
      const r = await fetch("/api/v1/me");
      if (r.ok) {
        const m = await r.json();
        await fetch("/api/v1/logout", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": m.csrf,
          },
          body: "{}",
        });
      }
    })
    .catch(() => {});
  await browser.close();
}

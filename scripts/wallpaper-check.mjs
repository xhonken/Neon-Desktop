import puppeteer from "puppeteer-core";
import assert from "node:assert/strict";
import readline from "node:readline/promises";
const rl = readline.createInterface({ input: process.stdin, terminal: false });
const fixture = JSON.parse((await rl[Symbol.asyncIterator]().next()).value);
rl.close();
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  pipe: true,
  acceptInsecureCerts: true,
  defaultViewport: { width: 1440, height: 900 },
});
const errors = [];
async function click(page, text) {
  await page.evaluate((text) => {
    const b = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === text,
    );
    if (!b) throw Error("Missing " + text);
    b.click();
  }, text);
}
async function login(user) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(fixture.origin);
  await page.type("#username", user.name);
  await page.type("#password", user.password);
  await page.click("#login button");
  await page.waitForSelector(".desktop-wallpaper");
  await page.waitForFunction(() =>
    getComputedStyle(
      document.querySelector(".desktop-wallpaper"),
    ).backgroundImage.includes("neon-glass.png"),
  );
  return { page, context };
}
async function settings(page) {
  await page.click(".launcher-toggle");
  await click(page, "⚙Settings").catch(async () => {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll(".launcher button")].find((b) =>
        b.textContent.includes("Settings"),
      );
      if (!b) throw Error("Missing Settings");
      b.click();
    });
  });
  await page.waitForSelector('[aria-label="Background"]');
}
async function rpc(page, action, args = {}) {
  return page.evaluate(
    async ({ action, args }) => {
      const me = await (await fetch("/api/v1/me")).json();
      const r = await fetch("/api/v1/rpc", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": me.csrf,
        },
        body: JSON.stringify({ app: "org.neon.settings", action, ...args }),
      });
      return { status: r.status, body: await r.json() };
    },
    { action, args },
  );
}
const pause = () => new Promise((r) => setTimeout(r, 800));
try {
  const anon = await browser.newPage();
  const response = await anon.goto(
    fixture.origin + "/assets/wallpapers/neon-glass.png",
  );
  assert.equal(response.status(), 401);
  await anon.close();
  const a = await login(fixture.users[0]);
  await a.page.screenshot({ path: fixture.output + "/neon-glass-desktop.png" });
  await settings(a.page);
  await a.page.select('[aria-label="Background"]', "plain");
  await a.page.waitForFunction(
    () =>
      document.querySelector(".desktop-surface").dataset.wallpaper === "plain",
  );
  await a.page.select('[aria-label="Background"]', "grid");
  await a.page.waitForFunction(
    () =>
      document.querySelector(".desktop-surface").dataset.wallpaper === "grid",
  );
  await a.page.select('[aria-label="Background"]', "neon");
  const input = await a.page.$("input[type=file]");
  await input.uploadFile(fixture.image);
  await a.page.waitForFunction(
    () =>
      document
        .querySelector(".wallpaper-settings [role=status]")
        .textContent.startsWith("Background saved"),
    { timeout: 20000 },
  );
  await a.page.waitForFunction(
    () =>
      document.querySelector(".desktop-surface").dataset.wallpaper === "custom",
  );
  await a.page.select('[aria-label="Image fit"]', "contain");
  await a.page.$eval('[aria-label="Background brightness"]', (e) => {
    e.value = "60";
    e.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await pause();
  const device = await a.page.evaluate(() =>
    localStorage.getItem(
      [...Object.keys(localStorage)].find((k) => /^neon-device-\d+$/.test(k)),
    ),
  );
  const config = await rpc(a.page, "config.get", { device });
  assert.equal(config.body.wallpaper, "custom");
  assert.equal(config.body.wallpaperBrightness, 0.6);
  assert.equal(config.body.wallpaperFit, "contain");
  assert(JSON.stringify(config.body).length < 50000);
  const file = await rpc(a.page, "files.read", {
    path: `.config/neon-desktop/wallpaper-${device}.jpg`,
  });
  assert.equal(file.status, 200);
  assert(Buffer.from(file.body.data, "base64")[0] === 255);
  await a.page.reload();
  await a.page.waitForSelector(".desktop-wallpaper");
  await a.page.waitForFunction(
    () =>
      document.querySelector(".desktop-surface").dataset.wallpaper === "custom",
  );
  assert.equal(
    await a.page.$eval(".desktop-wallpaper", (e) => e.style.backgroundSize),
    "contain",
  );
  assert.equal(
    await a.page.$eval(".desktop-wallpaper", (e) => e.style.filter),
    "brightness(0.6)",
  );
  const b = await login(fixture.users[1]);
  assert.notEqual(
    (
      await rpc(b.page, "files.read", {
        path: `../${fixture.users[0].name}/.config/neon-desktop/wallpaper-${device}.jpg`,
      })
    ).status,
    200,
  );
  // A restored Settings window is normally present; open it if recovery is off.
  if (!(await a.page.$('[aria-label="Background"]'))) await settings(a.page);
  await a.page.screenshot({
    path: fixture.output + "/neon-wallpaper-settings.png",
  });
  // Unsupported SVG must be rejected by the actual file selection handler.
  const input2 = await a.page.$("input[type=file]");
  await input2.uploadFile(fixture.invalid);
  await a.page.waitForFunction(() =>
    document
      .querySelector(".wallpaper-settings [role=status]")
      .textContent.includes("Choose a PNG"),
  );
  await click(a.page, "Remove my image");
  await a.page.waitForFunction(
    () =>
      document.querySelector(".wallpaper-settings [role=status]")
        .textContent === "Personal background removed.",
  );
  assert.notEqual(
    (
      await rpc(a.page, "files.read", {
        path: `.config/neon-desktop/wallpaper-${device}.jpg`,
      })
    ).status,
    200,
  );
  await a.page.reload();
  await a.page.waitForSelector(".desktop-wallpaper");
  await a.page.waitForFunction(
    () =>
      document.querySelector(".desktop-surface").dataset.wallpaper === "neon",
  );
  await a.page.setViewport({ width: 600, height: 800 });
  await a.page.waitForFunction(
    () =>
      document.querySelector(".desktop-surface").getBoundingClientRect()
        .width <= 600,
  );
  assert.equal(
    await a.page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        defaultWallpaper: true,
        authenticatedAsset: true,
        personalUploadReloadFitBrightness: true,
        privateAcrossAccounts: true,
        svgRejected: true,
        removeAndReset: true,
        responsive: true,
        consoleErrors: errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}

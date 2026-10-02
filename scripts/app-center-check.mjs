import puppeteer from "puppeteer-core";
import assert from "node:assert/strict";
import readline from "node:readline/promises";
const rl = readline.createInterface({ input: process.stdin, terminal: false });
const fixture = JSON.parse((await rl[Symbol.asyncIterator]().next()).value);
rl.close();
const origin = process.argv[2],
  browser = await puppeteer.launch({
    executablePath: "/usr/bin/chromium",
    headless: true,
    pipe: true,
    acceptInsecureCerts: true,
    defaultViewport: { width: 1440, height: 1000 },
  }),
  errors = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(fn) {
  let error;
  for (let i = 0; i < 70; i++) {
    try {
      return await fn();
    } catch (e) {
      error = e;
      await wait(500);
    }
  }
  throw error;
}
async function login(user) {
  const context = await browser.createBrowserContext(),
    page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  await page.type("#username", user.username);
  await page.type("#password", user.password);
  await page.click("#login button");
  await page.waitForSelector(".desktop-surface", { timeout: 20000 });
  const me = await page.evaluate(async () =>
    (await fetch("/api/v1/me")).json(),
  );
  return { page, context, me };
}
async function api(s, path, body) {
  return s.page.evaluate(
    async ({ path, body, csrf }) => {
      const r = await fetch("/api/v1/" + path, {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: body ? JSON.stringify(body) : undefined,
      });
      let data;
      try {
        data = await r.json();
      } catch {
        data = {};
      }
      return { status: r.status, data };
    },
    { path, body, csrf: s.me.csrf },
  );
}
async function rpc(s, action, args = {}, app = "org.neon.applications") {
  const r = await api(s, "rpc", { ...args, action, app });
  if (r.status !== 200)
    throw Error(`${action}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}
async function click(page, text, scope = "") {
  await page.evaluate(
    ({ text, scope }) => {
      const b = [...document.querySelectorAll(scope + " button")].find(
        (b) => b.textContent === text,
      );
      if (!b) throw Error("Missing button " + text);
      b.click();
    },
    { text, scope },
  );
}
async function launch(page, name) {
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
  await wait(300);
}
async function consent(page) {
  await page.waitForSelector("dialog .btn-danger", { timeout: 45000 });
  await page.click("dialog .btn-danger");
}
async function frame(s, id) {
  await eventually(() => {
    const f = s.page
      .frames()
      .find((f) => f.url().includes("/app-assets/" + id + "/"));
    assert(f);
    return f;
  });
  return s.page
    .frames()
    .find((f) => f.url().includes("/app-assets/" + id + "/"));
}
const result = {};
try {
  const a = await login(fixture.users[0]),
    b = await login(fixture.users[1]);
  for (const s of [a, b]) {
    assert(
      s.me.apps.some((v) => v.id === fixture.global && v.scope === "system"),
    );
    assert(!s.me.apps.some((v) => v.id === fixture.personal));
  }
  await launch(a.page, "App Center");
  await a.page.waitForSelector(`[data-app="${fixture.personal}"]`);
  const card = `[data-app="${fixture.personal}"]`;
  assert(
    !(
      await a.page.$eval(`[data-app="${fixture.global}"]`, (e) => e.textContent)
    ).includes("Install for me"),
  );
  assert.equal(
    (
      await api(a, "rpc", {
        app: "org.neon.applications",
        action: "apps.prepare",
        target: fixture.global,
      })
    ).status,
    403,
  );
  await assert.rejects(rpc(a, "apps.prepare", { target: fixture.bad }));
  result.backendAndSymlinkGuards = true;
  await click(a.page, "Install for me", card);
  await consent(a.page);
  const installed = await eventually(async () => {
    const me = (await api(a, "me")).data;
    const m = me.apps.find((x) => x.id === fixture.personal);
    assert(m);
    return m;
  });
  assert.equal(installed.scope, "user");
  assert.equal(installed.runtime, "sandbox");
  assert(
    !(await api(b, "me")).data.apps.some((m) => m.id === fixture.personal),
  );
  assert.equal(
    (await api(b, "app-launch", { app: fixture.personal })).status,
    404,
  );
  result.personalVisibilityAndSystemVisibility = true;
  await click(a.page, "Open", card);
  await consent(a.page);
  let f = await frame(a, fixture.personal);
  await f.waitForSelector("#version");
  assert.equal(await f.$eval("#version", (e) => e.textContent), "1.0.0");
  assert.equal(
    await f.evaluate(() => {
      try {
        return !!parent.document.body;
      } catch {
        return false;
      }
    }),
    false,
  );
  await f.click("#notify");
  await f.waitForFunction(() =>
    document.querySelector("#result").textContent.includes('"ok":true'),
  );
  result.actualSandboxAndPermissionGrant = true;
  const oldTicket = (await api(a, "app-launch", { app: fixture.personal })).data
    .src;
  const stale = await rpc(a, "apps.prepare", { target: fixture.personal });
  console.log("CATALOG_V2");
  await eventually(async () =>
    assert.equal(
      (await rpc(a, "apps.catalog")).apps.find((x) => x.id === fixture.personal)
        .version,
      "2.0.0",
    ),
  );
  await assert.rejects(
    rpc(a, "apps.install", {
      target: fixture.personal,
      token: stale.token,
      expected: installed.revision,
    }),
  );
  assert.equal(
    (await api(a, "me")).data.apps.find((x) => x.id === fixture.personal)
      .version,
    "1.0.0",
  );
  result.staleReviewCannotChangeInstalledApp = true;
  await click(
    a.page,
    "Refresh catalog",
    '.desktop-window[aria-label="App Center"]',
  );
  await a.page.waitForFunction(
    (id) =>
      document
        .querySelector(`[data-app="${id}"]`)
        ?.textContent.includes("Update to 2.0.0"),
    {},
    fixture.personal,
  );
  await click(a.page, "Update to 2.0.0", card);
  await consent(a.page);
  const updated = await eventually(async () => {
    const m = (await api(a, "me")).data.apps.find(
      (x) => x.id === fixture.personal,
    );
    assert.equal(m.version, "2.0.0");
    return m;
  });
  assert.deepEqual(updated.granted, []);
  assert.notEqual(updated.revision, installed.revision);
  assert.equal(
    await a.page.evaluate(async (url) => (await fetch(url)).status, oldTicket),
    404,
  );
  assert.equal(
    (
      await api(a, "rpc", {
        app: fixture.personal,
        action: "notifications.check",
        appRevision: installed.revision,
      })
    ).status,
    403,
  );
  result.updateRevokesOldAssetsAndGrants = true;
  await click(a.page, "Open", card);
  await consent(a.page);
  f = await frame(a, fixture.personal);
  await f.waitForSelector("#version");
  assert.equal(await f.$eval("#version", (e) => e.textContent), "2.0.0");
  await f.click("#write");
  await f.waitForFunction(() =>
    document.querySelector("#result").textContent.includes('"ok":true'),
  );
  for (const s of [a, b]) {
    await launch(s.page, "Verification Global");
    await consent(s.page);
    const global = await frame(s, fixture.global);
    await global.waitForSelector("#write");
    await global.click("#write");
    await global.waitForFunction(() =>
      document.querySelector("#result").textContent.includes('"ok":true'),
    );
  }
  result.globalAppUsesEachUserFiles = true;
  await click(a.page, "Uninstall", card);
  await consent(a.page);
  await eventually(async () =>
    assert(
      !(await api(a, "me")).data.apps.some((x) => x.id === fixture.personal),
    ),
  );
  assert.equal(
    (await api(a, "app-launch", { app: fixture.personal })).status,
    404,
  );
  const proof = await rpc(
    a,
    "files.read",
    { path: "appcenter-proof.txt" },
    "org.neon.files",
  );
  assert.equal(
    Buffer.from(proof.data, "base64").toString(),
    "owned by signed-in user",
  );
  result.uninstallPreservesUserDocuments = true;
  assert.equal(
    (
      await api(a, "rpc", {
        app: "org.neon.applications",
        action: "apps.remove",
        target: fixture.global,
        expected: "fake",
      })
    ).status,
    403,
  );
  assert.deepEqual(errors, []);
  result.consoleErrors = errors;
  console.log(JSON.stringify(result, null, 2));
} finally {
  fixture.users.forEach((u) => (u.password = null));
  await browser.close();
}

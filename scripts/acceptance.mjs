// Run on the target as its development user. Password read from hidden stdin, never saved.
import puppeteer from "puppeteer-core";
import readline from "node:readline/promises";
import fs from "node:fs";
import assert from "node:assert/strict";
const origin = process.argv[2],
  username = process.argv[3];
if (!origin || !username)
  throw Error("Usage: node scripts/acceptance.mjs HTTPS_ORIGIN USERNAME");
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});
let password = await rl.question(
  "PAM password (terminal echo must be disabled): ",
);
rl.close();
fs.mkdirSync("artifacts", { recursive: true, mode: 0o700 });
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  pipe: true,
  acceptInsecureCerts: true,
  args: ["--disable-dev-shm-usage"],
  defaultViewport: { width: 1440, height: 1000 },
});
const page = await browser.newPage(),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const results = {};
try {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  results.anonymousTitle = await page.title();
  assert.equal(results.anonymousTitle, "Sign in");
  await page.type("#username", username);
  await page.type("#password", password);
  password = null;
  await page.click("#login button");
  await page.waitForSelector(".desktop-surface", { timeout: 20000 });
  await page
    .waitForNetworkIdle({ idleTime: 200, timeout: 5000 })
    .catch(() => {});
  results.login = true;
  await page.screenshot({ path: "artifacts/desktop.png" });
  const me = await page.evaluate(
    async () => await (await fetch("/api/v1/me")).json(),
  );
  assert.equal(me.username, username);
  results.uid = me.uid;
  async function rpc(app, action, args = {}) {
    return await page.evaluate(
      async ({ app, action, args, csrf }) => {
        const r = await fetch("/api/v1/rpc", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
          body: JSON.stringify({ app, action, ...args }),
        });
        const raw = await r.text();
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          body = { error: raw };
        }
        return { status: r.status, body };
      },
      { app, action, args, csrf: me.csrf },
    );
  }
  results.csrf = await page.evaluate(async () => {
    const r = await fetch("/api/v1/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    return r.status;
  });
  assert.equal(results.csrf, 403);
  const file = ".neon-acceptance-" + Date.now() + ".txt";
  let r = await rpc("org.neon.files", "files.write", {
    path: file,
    data: Buffer.from("Verified real Linux filesystem\n").toString("base64"),
    exclusive: true,
  });
  assert.equal(r.status, 200);
  assert.equal(
    fs.readFileSync(`${me.home}/${file}`, "utf8"),
    "Verified real Linux filesystem\n",
  );
  assert.equal(fs.statSync(`${me.home}/${file}`).uid, me.uid);
  results.realFile = true;
  assert.notEqual(
    (await rpc("org.neon.files", "files.read", { path: "../etc/passwd" }))
      .status,
    200,
  );
  assert.equal(
    (await rpc("org.neon.applications", "files.list", { path: "." })).status,
    403,
  );
  results.pathAndPermissions = true;
  async function launch(name) {
    await page.click(".launcher-toggle");
    await page.click(".launcher-search");
    await page.evaluate(
      () => (document.querySelector(".launcher-search").value = ""),
    );
    await page.type(".launcher-search", name);
    await page.evaluate((name) => {
      [...document.querySelectorAll(".launcher-app")]
        .find((e) => e.lastElementChild?.textContent === name)
        ?.click();
    }, name);
    await page.waitForFunction(
      (name) =>
        [...document.querySelectorAll(".window-caption")].some(
          (e) => e.textContent === name,
        ),
      {},
      name,
    );
    await page
      .waitForNetworkIdle({ idleTime: 200, timeout: 5000 })
      .catch(() => {});
  }
  await launch("Files");
  await page.waitForSelector(".files-table tbody tr");
  results.fileManager = true;
  await launch("Code");
  await page.waitForSelector(".cm-editor");
  results.codeMirror = true;
  await page.screenshot({ path: "artifacts/code.png" });
  await launch("Terminal");
  await page.waitForSelector(".xterm-screen");
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".app-status")].some((e) =>
      e.textContent.startsWith("Connected"),
    ),
  );
  results.terminalUI = true;
  const terms = await rpc("org.neon.terminal", "terminal.list");
  const tid = terms.body.terminals.at(-1).id;
  const terminalCheck = await page.evaluate(
    async ({ tid, csrf }) =>
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(
          `${location.origin.replace("https:", "wss:")}/api/v1/stream/terminal/${tid}?app=org.neon.terminal&csrf=${encodeURIComponent(csrf)}`,
        );
        ws.binaryType = "arraybuffer";
        let output = "";
        const timer = setTimeout(() => {
          ws.close();
          reject(Error("PTY timeout " + output));
        }, 10000);
        ws.onopen = () =>
          ws.send(
            JSON.stringify({
              type: "input",
              data: "printf '\\nNEON_UID='; id -u; printf 'NEON_END\\n'\n",
            }),
          );
        ws.onmessage = (e) => {
          if (e.data instanceof ArrayBuffer) {
            output += new TextDecoder().decode(e.data);
            if (/NEON_UID=\d+\r?\nNEON_END/.test(output)) {
              clearTimeout(timer);
              ws.close();
              resolve(output.match(/NEON_UID=(\d+)/)[1]);
            }
          }
        };
      }),
    { tid, csrf: me.csrf },
  );
  assert.equal(Number(terminalCheck), me.uid);
  results.ptyUid = terminalCheck;
  // Wait for state persistence, then prove process identity survives browser reload.
  await new Promise((r) => setTimeout(r, 600));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".desktop-surface");
  const after = await rpc("org.neon.terminal", "terminal.list");
  assert(after.body.terminals.some((t) => t.id === tid && t.alive));
  results.ptyReload = true;
  await launch("Settings");
  await page.waitForSelector(".settings-main");
  results.settings = true;
  await page.screenshot({ path: "artifacts/desktop-apps.png" });
  const browserStart = await rpc("org.neon.browser", "browser.start");
  assert.equal(browserStart.status, 200);
  results.browserStart = browserStart.body;
  const nav = await rpc("org.neon.browser", "browser.navigate", {
    url: "https://example.com",
  });
  assert.equal(nav.status, 200);
  if (nav.body.error) throw Error(nav.body.error);
  await launch("Browser");
  await page.waitForFunction(
    () => document.querySelector(".browser-screen img")?.naturalWidth > 0,
    { timeout: 20000 },
  );
  results.browserStream = true;
  await page.screenshot({ path: "artifacts/browser.png" });
  // Close only resources created by this test, not unrelated user sessions.
  await rpc("org.neon.browser", "browser.stop");
  await rpc("org.neon.terminal", "terminal.stop", { id: tid });
  await rpc("org.neon.files", "files.delete", { path: file });
  results.consoleErrors = errors;
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(results, null, 2));
  fs.writeFileSync(
    "artifacts/acceptance.json",
    JSON.stringify(results, null, 2),
  );
} catch (e) {
  await page.screenshot({ path: "artifacts/failure.png" }).catch(() => {});
  console.error("Acceptance failed:", e.message);
  console.error("Browser errors:", errors);
  fs.writeFileSync(
    "artifacts/acceptance-failure.json",
    JSON.stringify({ results, error: e.message, errors }, null, 2),
  );
  process.exitCode = 1;
} finally {
  password = null;
  await page
    .evaluate(async () => {
      const r = await fetch("/api/v1/me");
      if (r.ok) {
        const me = await r.json();
        await fetch("/api/v1/logout", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": me.csrf,
          },
          body: "{}",
        });
      }
    })
    .catch(() => {});
  await browser.close();
}

// Installed HTTPS/PAM acceptance; only the root fixture can age its own account.
import assert from "node:assert/strict";
import readline from "node:readline";
import puppeteer from "puppeteer-core";

const [origin, username] = process.argv.slice(2);
const input = readline.createInterface({
  input: process.stdin,
  terminal: false,
});
const lines = input[Symbol.asyncIterator]();
let { password } = JSON.parse((await lines.next()).value);
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  pipe: true,
  acceptInsecureCerts: true,
  args: ["--disable-dev-shm-usage"],
  defaultViewport: { width: 1440, height: 1000 },
});
const page = await browser.newPage();
const errors = [],
  results = {};
page.on("pageerror", (error) => errors.push(error.message));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function control(operation, details = {}) {
  console.log(JSON.stringify({ control: operation, ...details }));
  const result = JSON.parse((await lines.next()).value);
  if (!result.ok) throw Error("Root test fixture rejected operation");
  return result;
}
async function signin() {
  await page.type("#password", password);
  await page.click("#login button");
}
async function unlock() {
  await page.waitForSelector(".reconnect-login[open]", { timeout: 40000 });
  await page.type(".reconnect-login input[type=password]", password);
  await page.click(".reconnect-login button[type=submit]");
  await page.waitForFunction(() => !document.querySelector(".reconnect-login"));
  assert.equal(
    await page.evaluate(() => window.neonTestDocument),
    "same-document",
  );
}
async function rpc(action, args = {}) {
  return page.evaluate(
    async ({ action, args }) => {
      const me = await (
        await fetch("/api/v1/me", { headers: { "X-Neon-Background": "1" } })
      ).json();
      const r = await fetch("/api/v1/rpc", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": me.csrf,
        },
        body: JSON.stringify({ app: "org.neon.terminal", action, ...args }),
      });
      if (!r.ok) throw Error("Test RPC failed: " + r.status);
      return r.json();
    },
    { action, args },
  );
}
async function launch(name) {
  await page.click(".launcher-toggle");
  await page.evaluate(
    (name) =>
      [...document.querySelectorAll(".launcher-app")]
        .find((node) => node.lastElementChild.textContent === name)
        .click(),
    name,
  );
}
try {
  // The first failed configuration read must leave a usable sign-in form.
  let failStartup = true;
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (
      failStartup &&
      request.url().endsWith("/api/v1/rpc") &&
      request.postData()?.includes('"config.get"')
    ) {
      failStartup = false;
      request.respond({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Temporary fixture outage" }),
      });
    } else request.continue();
  });
  await page.goto(origin);
  await page.type("#username", username);
  await signin();
  await page.waitForFunction(() =>
    document.querySelector("#login-error")?.textContent.includes("try again"),
  );
  assert.ok(await page.$("#login"));
  assert.equal(await page.$(".desktop-surface"), null);
  await signin();
  await page.waitForSelector(".desktop-surface");
  await page.evaluate(() => {
    window.neonTestDocument = "same-document";
  });
  results.startupFailureRetryWithoutReload = true;
  console.log(
    "PASS startup failure keeps the login form and retries in the same document",
  );

  // No app/stream is needed to notice genuine idle expiry.
  await control("expire-idle");
  await unlock();
  results.idleDesktopLocksWithoutStreams = true;
  console.log(
    "PASS idle expiry locks an otherwise empty desktop and PAM unlock preserves the document",
  );

  await launch("Code");
  await page.waitForSelector(".cm-content");
  await page.click(".cm-content");
  await page.keyboard.type("unsaved text retained across expiry");
  const editor = await page.$(".cm-content");
  await launch("Terminal");
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".app-status")].some((node) =>
      /^(Connected ·|View only ·)/.test(node.textContent),
    ),
  );
  const terminal = (await rpc("terminal.list")).terminals.find(
    (item) => item.alive,
  );
  assert.ok(terminal);
  const originalPid = terminal.pid;
  assert.ok(Number.isInteger(originalPid));
  await page.click(".terminal-host");
  await page.keyboard.type(
    "printf '%s\\n' \"$UID\" > session-recovery-uid.txt\r",
    { delay: 1 },
  );
  await wait(1000);
  await control("verify-process", { pid: originalPid });

  // Visible trusted input must renew a valid session even without an app RPC.
  await control("near-idle");
  await page.click(".connection-state");
  await page.keyboard.press("ArrowLeft");
  let renewed = false;
  for (let i = 0; i < 40; i++) {
    if ((await control("age")).age < 5) {
      renewed = true;
      break;
    }
    await wait(1000);
  }
  assert.ok(renewed, "Visible input did not renew idle access");
  results.visibleInputRenewsAccess = true;
  console.log(
    "PASS visible input renews idle access while the Linux process remains running",
  );

  // Opening a not-yet-imported app after expiry must wait for PAM, not poison import().
  await control("expire-idle");
  await launch("Files");
  await unlock();
  await page.waitForSelector(
    '.desktop-window[aria-label="Files"] .files-table',
  );
  assert.equal(
    await editor.evaluate(
      (node) =>
        node.isConnected &&
        node.textContent.includes("unsaved text retained across expiry"),
    ),
    true,
  );
  assert.equal(
    (await rpc("terminal.list")).terminals.find(
      (item) => item.id === terminal.id,
    ).pid,
    originalPid,
  );
  await control("verify-process", { pid: originalPid });
  results.lazyAppResumesAfterPam = true;
  results.sameEditorAndTerminalProcess = true;
  console.log(
    "PASS expired lazy app opens after PAM, with the same editor DOM, terminal ID/PID and Linux UID",
  );

  await control("expire-absolute");
  await unlock();
  assert.equal(
    (await rpc("terminal.list")).terminals.find(
      (item) => item.id === terminal.id,
    ).pid,
    originalPid,
  );
  results.absoluteExpiryResumesInPlace = true;

  await page.setOfflineMode(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await wait(1000);
  await page.setOfflineMode(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForFunction(
    () =>
      document.querySelector(".connection-state")?.textContent === "Connected",
  );
  assert.equal(
    await page.evaluate(() => window.neonTestDocument),
    "same-document",
  );
  assert.equal(
    (await rpc("terminal.list")).terminals.find(
      (item) => item.id === terminal.id,
    ).pid,
    originalPid,
  );
  results.networkLossRecoversInPlace = true;
  assert.deepEqual(errors, []);
  results.javascriptErrors = errors;
  console.log(JSON.stringify({ results }));
} finally {
  password = null;
  input.close();
  await browser.close();
}

import puppeteer from "puppeteer-core";
import readline from "node:readline/promises";
import assert from "node:assert/strict";
const [origin, username, sshPort, browserURL] = process.argv.slice(2);
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});
let password = await rl.question("Temporary test account password via stdin: ");
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
await page.evaluateOnNewDocument(() => {
  window.__sockets = [];
  const Original = window.WebSocket;
  window.WebSocket = new Proxy(Original, {
    construct(target, args) {
      const s = new target(...args);
      window.__sockets.push(s);
      return s;
    },
  });
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let me;
const results = {};
async function login() {
  await page.waitForSelector("#login");
  await page.type("#username", username);
  await page.type("#password", password);
  await page.click("#login button");
  await page.waitForSelector(".desktop-surface", { timeout: 20000 });
  me = await page.evaluate(
    async () => await (await fetch("/api/v1/me")).json(),
  );
}
async function rpc(app, action, args = {}) {
  return page.evaluate(
    async ({ app, action, args, csrf }) => {
      const r = await fetch("/api/v1/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({ ...args, app, action }),
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
        .find((e) => e.lastElementChild.textContent === name)
        .click(),
    name,
  );
  await page.waitForSelector(`.desktop-window[aria-label="${name}"]`);
  await wait(500);
}
async function input(id, text) {
  await page.evaluate(
    async ({ id, text, csrf }) => {
      const ws = new WebSocket(
        `${location.origin.replace("https:", "wss:")}/api/v1/stream/terminal/${id}?app=org.neon.terminal&csrf=${encodeURIComponent(csrf)}`,
      );
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
      });
      ws.send(JSON.stringify({ type: "input", data: text }));
      await new Promise((r) => setTimeout(r, 100));
      ws.close();
    },
    { id, text, csrf: me.csrf },
  );
}
async function read(path) {
  const b = await rpc("org.neon.files", "files.read", { path });
  return Buffer.from(b.data, "base64").toString();
}
async function eventually(fn) {
  let last;
  for (let n = 0; n < 40; n++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await wait(500);
    }
  }
  throw last;
}
try {
  await page.goto(origin);
  await login();
  await launch("Terminal");
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".app-status")].some((e) =>
      e.textContent.startsWith("Connected ·"),
    ),
  );
  const initial = (await rpc("org.neon.terminal", "terminal.list")).terminals;
  assert.equal(initial.length, 1);
  const local = initial[0].id;
  await input(
    local,
    "printf '%s\\n' \"$$\" > .neon-local-pid; sleep 5; printf finished > .neon-local-done\r",
  );
  const pid = await eventually(() => read(".neon-local-pid"));
  assert.match(pid, /\d+/);
  await page.setOfflineMode(true);
  await page.evaluate(() => window.__sockets.forEach((s) => s.close()));
  await wait(8000);
  await page.setOfflineMode(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".app-status")].some((e) =>
        e.textContent.startsWith("Connected ·"),
      ),
    { timeout: 25000 },
  );
  assert.equal(await read(".neon-local-done"), "finished");
  assert.equal(await read(".neon-local-pid"), pid);
  assert.deepEqual(
    (await rpc("org.neon.terminal", "terminal.list")).terminals.map(
      (t) => t.id,
    ),
    [local],
  );
  results.networkDropSameLocalProcess = true;
  // OpenSSH really connects to this test Linux account; fixture host key was pinned by the root runner.
  await rpc("org.neon.terminal", "ssh.save", {
    hosts: [
      {
        name: "Loopback verification",
        host: "127.0.0.1",
        username,
        port: Number(sshPort),
        group: "Tests",
      },
    ],
  });
  const ssh = (
    await rpc("org.neon.terminal", "terminal.create", {
      kind: "ssh",
      profile: 0,
    })
  ).id;
  await wait(1800);
  await page.evaluate(() =>
    [...document.querySelectorAll(".top-icon")]
      .find((e) => e.textContent === "Sessions")
      .click(),
  );
  await page.waitForSelector(".session-picker");
  await page.evaluate(
    (id) =>
      [...document.querySelectorAll(".session-picker button")]
        .find((e) => e.textContent.includes(id.slice(0, 8)))
        .click(),
    ssh,
  );
  await wait(500);
  await input(
    ssh,
    "printf '%s\\n' \"$$\" > .neon-ssh-pid; sleep 5; printf finished > .neon-ssh-done\r",
  );
  const sshPid = await eventually(() => read(".neon-ssh-pid"));
  assert.match(sshPid, /\d+/);
  assert.notEqual(sshPid, pid);
  await launch("Code");
  await page.waitForSelector(".cm-content");
  await page.click(".cm-content");
  await page.keyboard.type("unsaved recovery proof");
  await page.click('[aria-label="Sign out"]');
  await page.waitForSelector("#login", { timeout: 20000 });
  await wait(6000);
  await login();
  await page.waitForFunction(
    () =>
      document
        .querySelector(".cm-content")
        ?.textContent.includes("unsaved recovery proof"),
    { timeout: 20000 },
  );
  assert.equal(await read(".neon-ssh-done"), "finished");
  assert.equal(await read(".neon-ssh-pid"), sshPid);
  assert.deepEqual(
    new Set(
      (await rpc("org.neon.terminal", "terminal.list")).terminals
        .filter((t) => t.alive)
        .map((t) => t.id),
    ),
    new Set([local, ssh]),
  );
  results.logoutSameLocalAndSshProcesses = true;
  results.unsavedEditorRecovery = true;
  // Revoke this web session, then reauthenticate in place without discarding the editor.
  await page.evaluate(
    async (csrf) =>
      fetch("/api/v1/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: "{}",
      }),
    me.csrf,
  );
  await page.evaluate(() => window.__sockets.forEach((s) => s.close()));
  await page.waitForSelector(".reconnect-login", { timeout: 20000 });
  await page.type(".reconnect-login input[type=password]", password);
  await page.click(".reconnect-login button[type=submit]");
  await page.waitForFunction(
    () => !document.querySelector(".reconnect-login"),
    { timeout: 15000 },
  );
  me = await page.evaluate(
    async () => await (await fetch("/api/v1/me")).json(),
  );
  assert(
    (await page.$eval(".cm-content", (e) => e.textContent)).includes(
      "unsaved recovery proof",
    ),
  );
  results.reauthenticationInPlace = true;
  // Browser is a real server process: the page URL survives logout and login.
  await launch("Browser");
  await rpc("org.neon.browser", "browser.navigate", { url: browserURL });
  const before = await rpc("org.neon.browser", "browser.info");
  assert(before.url.startsWith(browserURL));
  await page.click('[aria-label="Sign out"]');
  await page.waitForSelector("#login");
  await wait(2000);
  await login();
  await page.waitForSelector(".browser-screen img");
  const after = await rpc("org.neon.browser", "browser.info");
  assert.equal(after.url, before.url);
  assert.equal(after.pid, before.pid);
  assert(Number.isInteger(before.pid));
  results.browserSurvivesLogout = true;
  // Closing a terminal window detaches; it can be found in the session picker.
  for (const win of await page.$$('.desktop-window[aria-label="Terminal"]'))
    await (await win.$('[aria-label="Close"]')).click();
  assert.equal(
    (await rpc("org.neon.terminal", "terminal.list")).terminals.filter(
      (t) => t.alive,
    ).length,
    2,
  );
  await page.evaluate(() =>
    [...document.querySelectorAll(".top-icon")]
      .find((e) => e.textContent === "Sessions")
      .click(),
  );
  await page.waitForSelector(".session-picker");
  assert(
    (await page.$eval(".session-picker", (e) => e.textContent)).includes(
      local.slice(0, 8),
    ),
  );
  results.closedWindowReattachAvailable = true;
  await page.evaluate(
    (id) =>
      [...document.querySelectorAll(".session-picker button")]
        .find((e) => e.textContent.includes(id.slice(0, 8)))
        .click(),
    local,
  );
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".app-status")].some((e) =>
      e.textContent.startsWith("Connected ·"),
    ),
  );
  assert.equal(
    (await rpc("org.neon.terminal", "terminal.list")).terminals.length,
    2,
  );
  results.reattachDoesNotCreateNewProcess = true;
  await input(ssh, "exit\r");
  await eventually(async () => {
    assert.equal(
      (await rpc("org.neon.terminal", "terminal.list")).terminals.find(
        (t) => t.id === ssh,
      ).alive,
      false,
    );
  });
  results.endedSessionReportedHonestly = true;
  assert.deepEqual(errors, []);
  results.consoleErrors = errors;
  console.log(JSON.stringify(results, null, 2));
} finally {
  password = null;
  await browser.close();
}

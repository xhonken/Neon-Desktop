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
  console.log("PAM login PASS");
  await launch("SSH Connections");
  await rpc("ssh.import", { name: "neon_fixture", data: secrets.privateKey });
  await assert.rejects(
    rpc("ssh.unlock", {
      key: "neon_fixture",
      passphrase: "deliberately incorrect",
      seconds: 60,
    }),
  );
  await click("Keys & unlock");
  await field("Key passphrase", secrets.passphrase);
  await click("Unlock key");
  await eventually(async () =>
    assert.match((await rpc("ssh.keys")).unlocked, /ED25519/),
  );
  assert.equal(
    await page.$eval(
      '.desktop-window[aria-label="SSH Connections"] input[type=password]',
      (e) => e.value,
    ),
    "",
  );
  const unlockedAt = Date.now();
  await rpc("ssh.unlock", {
    key: "neon_fixture",
    passphrase: secrets.passphrase,
    seconds: 60,
  });
  results.encryptedImportAgentAndPassphraseUI = true;
  console.log("Encrypted key import + UI unlock PASS");
  await click("New connection");
  for (const [k, v] of Object.entries({
    "Connection name": "Build server",
    "Host / IP address": "127.0.0.1",
    Port: sshPort,
    Username: username,
    Group: "Lab",
  }))
    await field(k, v);
  await page.select('[aria-label="Authentication"]', "key");
  await page.select('[aria-label="SSH key"]', "neon_fixture");
  await page.click('[aria-label="Persistent remote session"]');
  await field("Remote tmux session", "neon_acceptance");
  await click("Save & connect");
  await page.waitForSelector('.desktop-window[aria-label="Terminal"]');
  const hosts = (await rpc("ssh.list")).hosts;
  assert.equal(hosts[0].group, "Lab");
  assert.equal(hosts[0].username, username);
  assert.equal(hosts[0].persistent, true);
  let ssh;
  await eventually(async () => {
    ssh = (await rpc("terminal.list", {}, "org.neon.terminal")).terminals.find(
      (t) => t.host === "127.0.0.1",
    );
    assert(ssh?.alive);
  });
  await wait(1700);
  await input(
    ssh.id,
    "printf '%s' \"$$\" > .remote-pid; sleep 5; printf done > .remote-done\r",
  );
  const pid = await eventually(() => read(".remote-pid"));
  assert.match(pid, /^\d+$/);
  await rpc("terminal.stop", { id: ssh.id }, "org.neon.terminal");
  await wait(6000);
  assert.equal(await read(".remote-done"), "done");
  const resumed = await rpc(
    "terminal.create",
    { kind: "ssh", profile: hosts[0].id },
    "org.neon.terminal",
  );
  await wait(1800);
  await input(resumed.id, "printf '%s' \"$$\" > .remote-pid-again\r");
  assert.equal(await eventually(() => read(".remote-pid-again")), pid);
  results.realSshTmuxSameRemotePid = true;
  console.log("Real SSH + tmux transport-loss recovery PASS");
  const ro = await input(resumed.id, "touch .forbidden-input\r", other, false);
  assert.equal(ro.readonly, true);
  await assert.rejects(read(".forbidden-input"));
  await input(resumed.id, "printf yes > .takeover-proof\r", other);
  assert.equal(await eventually(() => read(".takeover-proof")), "yes");
  results.terminalControlTakeover = true;
  await job("session.rename", { id: resumed.id, name: "Retained build SSH" });
  assert(
    (await job("terminal.list")).terminals.some(
      (t) => t.name === "Retained build SSH",
    ),
  );
  await launch("Jobs & Sessions");
  assert.match(
    await page.$eval(".resource-summary", (e) => e.textContent),
    /Available RAM/,
  );
  // The child reports its own UID and actual cgroup memory limit.
  const command = `python3 -u -c 'import os,pathlib,time; print("UID",os.getuid()); p=pathlib.Path("/sys/fs/cgroup")/pathlib.Path("/proc/self/cgroup").read_text().strip().split("::")[1].lstrip("/"); print("LIMIT",(p/"memory.max").read_text().strip()); print("READY",flush=True); time.sleep(8); print("FINISHED",flush=True)'`;
  const started = await job("jobs.create", {
    name: "Acceptance job",
    command,
    memoryMiB: 128,
    cwd: ".",
  });
  await eventually(async () =>
    assert.match((await job("jobs.log", { id: started.id })).log, /READY/),
  );
  await assert.rejects(job("jobs.delete", { id: started.id }));
  await click("Refresh", '.desktop-window[aria-label="Jobs & Sessions"]');
  await page.waitForFunction(() =>
    document
      .querySelector('.desktop-window[aria-label="Jobs & Sessions"]')
      .textContent.includes("Acceptance job"),
  );
  await page.click('[aria-label="Sign out"]');
  await page.waitForSelector("#login");
  await wait(9000);
  await login();
  const log = (await job("jobs.log", { id: started.id })).log;
  assert.match(log, new RegExp("UID " + me.uid));
  assert.match(log, /LIMIT 134217728/);
  assert.match(log, /FINISHED/);
  const done = (await job("jobs.list")).jobs.find((j) => j.id === started.id);
  assert.equal(done.exitCode, 0);
  assert.equal(done.status, "completed");
  results.jobUidCgroupLogExitAndLogout = true;
  console.log("Isolated job UID/cgroup + durable output after logout PASS");
  const stopped = await job("jobs.create", {
    name: "Stop verification",
    command: "sleep 60",
    memoryMiB: 128,
  });
  await wait(400);
  await job("jobs.stop", { id: stopped.id });
  await job("jobs.delete", { id: stopped.id });
  await assert.rejects(
    job("jobs.create", { command: "true", memoryMiB: 8192 }),
  );
  const bounded = await job("jobs.create", {
    name: "Log bound",
    command: `python3 -c 'import sys; sys.stdout.write("x"*5000000)'`,
    memoryMiB: 128,
  });
  await eventually(async () =>
    assert.equal(
      (await job("jobs.list")).jobs.find((j) => j.id === bounded.id).status,
      "completed",
    ),
  );
  assert.equal(
    (await job("jobs.log", { id: bounded.id })).log.length,
    4 * 1024 * 1024,
  );
  results.jobStopLimitsAndLogBound = true;
  await write("history.txt", "first");
  const second = await write("history.txt", "second");
  const history = (await file("history.list", { path: "history.txt" }))
    .versions;
  assert.equal(history.length, 1);
  await file("history.restore", {
    path: "history.txt",
    id: history[0].id,
    expected: second.revision,
  });
  assert.equal(await read("history.txt"), "first");
  await assert.rejects(
    file("history.restore", {
      path: "history.txt",
      id: history[0].id,
      expected: second.revision,
    }),
  );
  await write(".env", "private");
  await write(".env", "changed");
  assert.equal(
    (await file("history.list", { path: ".env" })).versions.length,
    0,
  );
  assert((await file("document.lease", { path: "history.txt" })).acquired);
  assert.equal(
    (await file("document.lease", { path: "history.txt", client: other }))
      .acquired,
    false,
  );
  await assert.rejects(write("history.txt", "bad", { client: other }));
  assert(
    (
      await file("document.lease", {
        path: "history.txt",
        client: other,
        takeover: true,
      })
    ).acquired,
  );
  await write("history.txt", "taken over", { client: other });
  results.historyRestoreExclusionsAndConflictingViews = true;
  const d1 = randomUUID(),
    d2 = randomUUID();
  await rpc(
    "config.save",
    { device: d1, value: { marker: "one" } },
    "org.neon.settings",
  );
  await rpc(
    "config.save",
    { device: d2, value: { marker: "two" } },
    "org.neon.settings",
  );
  assert.equal(
    (await rpc("config.get", { device: d1 }, "org.neon.settings")).marker,
    "one",
  );
  assert.equal(
    (await rpc("config.get", { device: d2 }, "org.neon.settings")).marker,
    "two",
  );
  results.deviceLayoutsIndependent = true;
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

  // Same saved profile remains after web logout; the key expires without logging out or killing established SSH.
  const remaining = 62000 - (Date.now() - unlockedAt);
  if (remaining > 0) await wait(remaining);
  await eventually(async () =>
    assert.equal((await rpc("ssh.keys")).unlocked, ""),
  );
  assert(
    (await rpc("terminal.list", {}, "org.neon.terminal")).terminals.find(
      (t) => t.id === resumed.id,
    ).alive,
  );
  results.agentTtlWithoutEndingSsh = true;
  const bad = Buffer.from(
    `[127.0.0.1]:${sshPort} ${secrets.wrongPublicKey}\n`,
  ).toString("base64");
  await input(
    resumed.id,
    `python3 -c 'import base64,pathlib; pathlib.Path(".ssh/known_hosts").write_bytes(base64.b64decode("${bad}"))'\r`,
  );
  await wait(500);
  const rejected = await rpc(
    "terminal.create",
    { kind: "ssh", profile: hosts[0].id },
    "org.neon.terminal",
  );
  await wait(1200);
  const refusal = await input(rejected.id, "");
  assert.match(refusal.out, /REMOTE HOST IDENTIFICATION HAS CHANGED/);
  assert.equal(
    (await rpc("terminal.list", {}, "org.neon.terminal")).terminals.find(
      (t) => t.id === rejected.id,
    ).alive,
    false,
  );
  results.changedHostKeyRefused = true;
  assert.deepEqual(errors, []);
  results.consoleErrors = errors;
  console.log(JSON.stringify(results, null, 2));
} finally {
  secrets.password = secrets.passphrase = secrets.privateKey = null;
  await browser.close();
}

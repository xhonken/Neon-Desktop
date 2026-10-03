import puppeteer from "puppeteer-core";
import assert from "node:assert/strict";
import readline from "node:readline/promises";
const rl = readline.createInterface({ input: process.stdin, terminal: false });
const f = JSON.parse((await rl[Symbol.asyncIterator]().next()).value);
rl.close();
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  pipe: true,
  acceptInsecureCerts: true,
  defaultViewport: { width: 1440, height: 1000 },
});
const errors = [];
async function login(u, page) {
  page ||= await (await browser.createBrowserContext()).newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(f.origin);
  await page.waitForSelector("#username");
  await page.type("#username", u.name);
  await page.type("#password", u.password);
  await page.click("#login button");
  await page.waitForSelector(".desktop-surface");
  return page;
}
async function rpc(p, action, args = {}, app = "org.neon.codex") {
  return p.evaluate(
    async ({ action, args, app }) => {
      const me = await (await fetch("/api/v1/me")).json();
      const r = await fetch("/api/v1/rpc", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": me.csrf,
        },
        body: JSON.stringify({ app, action, ...args }),
      });
      return { status: r.status, body: await r.json() };
    },
    { action, args, app },
  );
}
async function open(p, name) {
  await p.click(".launcher-toggle");
  await p.evaluate((name) => {
    const b = [...document.querySelectorAll(".launcher-app")].find(
      (e) => e.lastElementChild?.textContent === name,
    );
    if (!b) throw Error("Missing app " + name);
    b.click();
  }, name);
  await p.waitForSelector(".coding-start");
}
async function click(p, text) {
  await p.evaluate((text) => {
    const b = [...document.querySelectorAll("button")].find(
      (e) => e.textContent === text,
    );
    if (!b) throw Error("Missing button " + text);
    b.click();
  }, text);
}
try {
  const p = await login(f.users[0]);
  assert.equal(
    (await rpc(p, "coding.info", { kind: "codex" })).body.ready,
    true,
  );
  await open(p, "Codex");
  await p.$eval(
    '[aria-label="Project folder"]',
    (e) => (e.value = "Coding test with spaces"),
  );
  await click(p, "New folder");
  await p.waitForFunction(
    () => !document.querySelector(".coding-start [role=alert]").textContent,
  );
  await click(p, "Start new session");
  await p.waitForFunction(
    () =>
      document
        .querySelector(".xterm-screen")
        ?.textContent.includes("New keyring password"),
    { timeout: 20000 },
  );
  await p.click(".xterm-helper-textarea");
  await p.keyboard.type(f.keyring);
  await p.keyboard.press("Enter");
  await p.waitForFunction(() =>
    document
      .querySelector(".xterm-screen")
      ?.textContent.includes("Repeat keyring password"),
  );
  await p.keyboard.type(f.keyring);
  await p.keyboard.press("Enter");
  await p.waitForFunction(
    () =>
      /Welcome to Codex|Sign in with ChatGPT/.test(
        document.querySelector(".xterm-screen")?.textContent || "",
      ),
    { timeout: 25000 },
  );
  await p.screenshot({ path: f.output + "/codex-installed.png" });
  let list = (await rpc(p, "terminal.list")).body.terminals;
  const session = list.find((t) => t.kind === "codex");
  assert(session?.alive);
  console.log(JSON.stringify({ sessionPid: session.pid, uid: f.users[0].uid }));
  assert.notEqual(
    (await rpc(p, "terminal.create", { kind: "codex", mode: "invalid" }))
      .status,
    200,
  );
  assert.notEqual(
    (await rpc(p, "terminal.create", { kind: "codex", cwd: "../" })).status,
    200,
  );
  await p.reload();
  await p.waitForSelector(".desktop-surface");
  assert(
    (await rpc(p, "terminal.list")).body.terminals.some(
      (t) => t.pid === session.pid && t.alive,
    ),
  );
  await p.click('[aria-label="Sign out"]');
  await p.waitForSelector("#username");
  await login(f.users[0], p);
  assert(
    (await rpc(p, "terminal.list")).body.terminals.some(
      (t) => t.pid === session.pid && t.alive,
    ),
  );
  const other = await login(f.users[1]);
  assert(
    !(await rpc(other, "terminal.list")).body.terminals.some(
      (t) => t.id === session.id,
    ),
  );
  assert.notEqual(
    (
      await rpc(other, "files.read", {
        path: "../" + f.users[0].name + "/.codex/config.toml",
      })
    ).status,
    200,
  );
  await open(other, "Qwen Coder");
  const q = (
    await rpc(other, "coding.info", { kind: "qwen" }, "org.neon.qwen-coder")
  ).body;
  await other.waitForFunction(
    () =>
      document.querySelector(".coding-start [role=status]")?.textContent
        .length > 0,
  );
  if (!q.ready)
    await other.waitForFunction(() =>
      [...document.querySelectorAll(".coding-start .toolbar button")]
        .filter((b) => /session/.test(b.textContent))
        .every((b) => b.disabled),
    );
  await other.screenshot({ path: f.output + "/qwen-installed.png" });
  assert.deepEqual(errors, []);
  console.log(
    "PASS installed HTTPS/PAM graphical launch, real Codex PTY/keyring, project path with spaces, reload/logout persistence, second-account isolation; Qwen ready=" +
      q.ready,
  );
} finally {
  await browser.close();
}

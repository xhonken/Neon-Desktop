// Per-user Chromium. CDP uses anonymous pipes, never a debugging TCP port.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { WebSocketServer } from "ws";
process.umask(0o077);
const uid = process.getuid();
if (uid < 1000) throw Error("Browser must run as a normal Linux user");
const home = os.userInfo().homedir;
const profile = path.join(home, ".local/share/neon-desktop/browser");
fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  pipe: true,
  headless: true,
  userDataDir: profile,
  args: [
    "--no-first-run",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
  ],
  defaultViewport: { width: 1100, height: 720 },
});
const page = (await browser.pages())[0] || (await browser.newPage());
const client = await page.createCDPSession();
let last = Date.now();
const peers = new Set();
let stopping = false;
function url(value) {
  const u = new URL(value);
  if (!["https:", "http:"].includes(u.protocol))
    throw Error("Only HTTP(S) navigation supported");
  return u.href;
}
const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== "POST" || req.url !== "/rpc") {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const part of req) {
      raw += part;
      if (raw.length > 65536) throw Error("Request too large");
    }
    const b = JSON.parse(raw);
    last = Date.now();
    let result = { ok: true };
    if (b.action === "browser.navigate")
      await page
        .goto(url(b.url), { waitUntil: "domcontentloaded", timeout: 20000 })
        .catch((e) => {
          result = { error: e.message.slice(0, 160) };
        });
    else if (b.action === "browser.back") {
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 });
    } else if (b.action === "browser.reload") {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
    } else if (b.action === "browser.stop") {
      stopping = true;
      setTimeout(async () => {
        await browser.close();
        process.exit(0);
      }, 100);
    } else if (b.action !== "browser.start" && b.action !== "browser.info")
      throw Error("Unknown action");
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ ...result, url: page.url() }));
  } catch (e) {
    res
      .writeHead(400, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: e.message.slice(0, 180) }));
  }
});
const wss = new WebSocketServer({ server, maxPayload: 65536 });
wss.on("connection", (ws) => {
  peers.add(ws);
  last = Date.now();
  ws.on("close", () => peers.delete(ws));
  ws.on("message", async (raw) => {
    try {
      const b = JSON.parse(raw);
      last = Date.now();
      if (b.type === "resize")
        await page.setViewport({
          width: Math.max(320, Math.min(1600, Number(b.width) || 1100)),
          height: Math.max(240, Math.min(1000, Number(b.height) || 720)),
        });
      else if (b.type === "mouse")
        await client.send("Input.dispatchMouseEvent", {
          type: b.event,
          x: Math.max(0, Math.min(1600, Number(b.x) || 0)),
          y: Math.max(0, Math.min(1000, Number(b.y) || 0)),
          button: b.button === "right" ? "right" : "left",
          clickCount: 1,
          deltaX: Number(b.dx) || 0,
          deltaY: Number(b.dy) || 0,
        });
      else if (b.type === "text" && typeof b.text === "string")
        await page.keyboard.insertText(b.text.slice(0, 10000));
      else if (
        b.type === "key" &&
        typeof b.key === "string" &&
        b.key.length < 40
      )
        await page.keyboard.press(b.key);
    } catch (e) {
      if (ws.readyState === 1)
        ws.send(JSON.stringify({ error: e.message.slice(0, 100) }));
    }
  });
});
let capture = false;
setInterval(async () => {
  if (stopping || capture) return;
  if (Date.now() - last > 20 * 60 * 1000 && peers.size === 0) {
    stopping = true;
    await browser.close();
    process.exit(0);
  }
  if (!peers.size) return;
  capture = true;
  try {
    const data = await page.screenshot({ type: "jpeg", quality: 65 });
    for (const ws of peers)
      if (ws.readyState === 1 && ws.bufferedAmount < 1024 * 1024) ws.send(data);
  } catch {
  } finally {
    capture = false;
  }
}, 140);
const sock = `/run/neon-browser-${uid}/api.sock`;
try {
  fs.unlinkSync(sock);
} catch {}
server.listen(sock, () => fs.chmodSync(sock, 0o600));
process.on("SIGTERM", async () => {
  await browser.close();
  process.exit(0);
});

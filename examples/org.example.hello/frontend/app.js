// Minimal versioned SDK client: no cookie, CSRF token, parent DOM or direct network access.
const waiting = new Map();
function request(action, args = {}) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    parent.postMessage({ channel: "neon-sdk-v1", id, action, args }, "*");
    setTimeout(() => {
      if (waiting.has(id)) {
        waiting.delete(id);
        reject(Error("Desktop did not respond"));
      }
    }, 10000);
  });
}
addEventListener("message", (e) => {
  if (e.source !== parent || e.data?.channel !== "neon-sdk-v1") return;
  const p = waiting.get(e.data.id);
  if (!p) return;
  waiting.delete(e.data.id);
  e.data.error ? p.reject(Error(e.data.error)) : p.resolve(e.data.result);
});
request("theme").then((theme) => {
  for (const [k, v] of Object.entries(theme))
    document.documentElement.style.setProperty("--" + k, v);
});
document.querySelector("#notify").onclick = () =>
  request("notify", { message: "Hello from an isolated application." })
    .then(
      () =>
        (document.querySelector("#result").textContent = "Notification sent."),
    )
    .catch((e) => (document.querySelector("#result").textContent = e.message));

// Bundle frontend dependencies before publishing. No installer/build hooks run on the user's server.
const pending = new Map();
function neon(action, args = {}) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error("Desktop request timed out"));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    parent.postMessage({ channel: "neon-sdk-v1", id, action, args }, "*");
  });
}
addEventListener("message", (event) => {
  if (event.source !== parent || event.data?.channel !== "neon-sdk-v1") return;
  const p = pending.get(event.data.id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(event.data.id);
  if (event.data.error) p.reject(Error(event.data.error));
  else p.resolve(event.data.result);
});
neon("theme")
  .then((theme) =>
    document.documentElement.style.setProperty("--accent", theme.accent),
  )
  .catch(() => {});
document.querySelector("#notify").onclick = async () => {
  try {
    await neon("notify", { message: "Hello from your application" });
    document.querySelector("#status").textContent = "Notification sent";
  } catch (error) {
    document.querySelector("#status").textContent = error.message;
  }
};

const form = document.querySelector("#login");
let entering;
async function enter() {
  if (entering) return entering;
  entering = (async () => {
    const r = await fetch("/api/v1/me", {
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const identity = await r.json();
      const { start } = await import("./desktop.js");
      await start(identity);
      return true;
    }
    return false;
  })();
  try {
    return await entering;
  } finally {
    entering = null;
  }
}
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector("button");
  button.disabled = true;
  document.querySelector("#login-error").textContent = "";
  try {
    const r = await fetch("/api/v1/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: form.username.value,
        password: form.password.value,
      }),
      signal: AbortSignal.timeout(15000),
    });
    form.password.value = "";
    if (!r.ok) throw Error();
    if (!(await enter())) throw Error();
  } catch {
    const error = document.querySelector("#login-error");
    if (error)
      error.textContent = "Sign in or connection failed. Please try again.";
  } finally {
    button.disabled = false;
  }
});
enter().catch(() => {});

const form = document.querySelector("#login");
async function enter() {
  const r = await fetch("/api/v1/me");
  if (r.ok) {
    const identity = await r.json();
    const { start } = await import("./desktop.js");
    await start(identity);
    return true;
  }
  return false;
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
    });
    form.password.value = "";
    if (!r.ok) throw Error();
    await enter();
  } catch {
    const error = document.querySelector("#login-error");
    if (error) error.textContent = "Sign in failed.";
    else {
      const p = document.createElement("p");
      p.textContent = "The desktop could not start. Reload to retry.";
      document.querySelector("#root").append(p);
    }
  } finally {
    button.disabled = false;
  }
});
enter().catch(() => {});

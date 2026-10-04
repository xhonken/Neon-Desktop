// An expired credential rejects the request before dispatch. A transport error
// does not prove that, so never replay a timed-out or disconnected mutation.
export async function sessionRequest(link, identity, path, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!(await link.ready())) throw Error("This desktop has closed.");
    let response;
    try {
      response = await fetch("/api/v1/" + path, {
        method: body ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": identity.csrf,
          "X-Neon-Background": body?.background ? "1" : "0",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      link.disconnected();
      throw error;
    }
    if (response.status !== 401) return response;
    link.requireLogin();
  }
  throw Error("Sign in to reconnect. Server jobs are still running.");
}

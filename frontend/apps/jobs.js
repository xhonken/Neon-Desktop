import { closeTerminalViews } from "../connection.js";
import { el, button, field, ask, confirmAction, bytes } from "../ui.js";
export async function mount(w, c) {
  const toolbar = el("div", { class: "toolbar" }),
    resources = el("div", { class: "resource-summary" }),
    list = el("div", { class: "workbench-list" }),
    detail = el("div", { class: "workbench-detail" });
  w.content.append(
    toolbar,
    resources,
    el("div", { class: "workbench-layout" }, list, detail),
  );
  let disposed = false,
    busy = false;
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      c.notify(e.message);
    }
  };
  function create() {
    detail.replaceChildren(el("h2", { text: "Run a background job" }));
    const fields = {};
    for (const [key, label, value] of [
      ["name", "Job name", ""],
      ["command", "Command", "python3 script.py"],
      ["cwd", "Working folder (relative to HOME)", "."],
      ["memoryMiB", "Memory limit (MiB)", "512"],
    ]) {
      fields[key] = field(
        label,
        value,
        key === "memoryMiB" ? "number" : "text",
      );
      detail.append(fields[key].row);
    }
    detail.append(
      el("p", {
        class: "muted",
        text: "Runs as your Linux account with a separate memory/CPU limit. Enter a program and its arguments. For pipes or shell expansion, save a script and run it with bash. Jobs continue after sign-out. Logs retain the last 4 MiB.",
      }),
      button(
        "Start job",
        run(async () => {
          const args = Object.fromEntries(
            Object.entries(fields).map(([k, f]) => [k, f.input.value]),
          );
          args.memoryMiB = Number(args.memoryMiB);
          await c.call("jobs.create", args);
          c.notify("Background job started");
          await refresh();
        }),
      ),
    );
  }
  async function refresh() {
    if (disposed || busy) return;
    busy = true;
    try {
      const [r, j, sessions] = await Promise.all([
        c.call("resources.info", { background: true }),
        c.call("jobs.list", { background: true }),
        c.call("terminal.list", { background: true }),
      ]);
      resources.replaceChildren(
        el("span", {
          text: `Available RAM ${bytes(r.memoryAvailable)} · Disk ${bytes(r.diskAvailable)}`,
        }),
        ...r.warnings.map((text) =>
          el("strong", { class: "text-warning", text }),
        ),
      );
      list.replaceChildren(el("h3", { class: "h6", text: "BACKGROUND JOBS" }));
      for (const job of j.jobs) {
        const mem = job.resources?.MemoryCurrent;
        const cpu = Number(job.resources?.CPUUsageNSec) / 1e9;
        list.append(
          button(
            `${job.name} · ${job.status}`,
            run(async () => {
              const log = await c.call("jobs.log", { id: job.id });
              detail.replaceChildren(
                el("h2", { text: job.name }),
                el("p", {
                  text: `${job.status} · ${new Date((job.started || job.created) * 1000).toLocaleString()} · exit ${job.exitCode ?? "—"} · RAM ${/^\d+$/.test(mem) ? bytes(Number(mem)) : "—"} · CPU ${Number.isFinite(cpu) ? cpu.toFixed(1) + "s" : "—"}`,
                }),
                el(
                  "div",
                  { class: "toolbar" },
                  button(
                    "Refresh log",
                    run(async () => {
                      const b = await c.call("jobs.log", { id: job.id });
                      detail.querySelector("pre").textContent = b.log;
                    }),
                  ),
                  button(
                    "Stop job",
                    run(async () => {
                      if (
                        await confirmAction(
                          "Stop this job and its child processes?",
                        )
                      ) {
                        await c.call("jobs.stop", { id: job.id });
                        await refresh();
                      }
                    }),
                  ),
                  button(
                    "Delete completed job",
                    run(async () => {
                      if (
                        await confirmAction(
                          "Remove this completed job and its stored log?",
                        )
                      ) {
                        await c.call("jobs.delete", { id: job.id });
                        detail.replaceChildren();
                        await refresh();
                      }
                    }),
                  ),
                ),
                el("pre", { class: "workbench-log", text: log.log }),
              );
            }),
            "settings-item",
          ),
        );
      }
      if (w.state.selected) {
        const index = j.jobs.findIndex((job) => job.id === w.state.selected);
        if (index >= 0) {
          list.querySelectorAll("button")[index]?.click();
          delete w.state.selected;
        }
      }
      if (!j.jobs.length)
        list.append(
          el("p", { class: "muted", text: "No background jobs yet" }),
        );
      list.append(el("h3", { class: "h6 mt-4", text: "TERMINAL SESSIONS" }));
      for (const t of sessions.terminals.filter((t) => t.alive)) {
        list.append(
          button(
            `${t.name || "Terminal"} · ${t.alive ? "running" : "ended"}`,
            () => {
              detail.replaceChildren(
                el("h2", { text: t.name || "Terminal" }),
                el("p", {
                  text: `${t.host || "Local"} · ${t.id.slice(-8)} · ${t.created ? new Date(t.created * 1000).toLocaleString() : "Earlier runtime"} · ${t.attached ?? "?"} views · RAM ${t.memoryBytes ? bytes(t.memoryBytes) : "—"}`,
                }),
                el("p", {
                  class: "muted",
                  text: "Running refers to the terminal or SSH process. Commands inside its shell may have finished.",
                }),
                el(
                  "div",
                  { class: "toolbar" },
                  button("Open view", () =>
                    c.open("org.neon.terminal", { state: { terminal: t.id } }),
                  ),
                  button(
                    "Rename",
                    run(async () => {
                      const name = await ask(
                        "Session name",
                        t.name || "Terminal",
                      );
                      if (name) {
                        await c.call("session.rename", { id: t.id, name });
                        await refresh();
                      }
                    }),
                  ),
                  button(
                    "Stop process",
                    run(async () => {
                      if (
                        await confirmAction(
                          "Terminate this terminal and its jobs?",
                        )
                      ) {
                        await c.call("terminal.stop", { id: t.id });
                        await closeTerminalViews(c, t.id);
                        detail.replaceChildren();
                        await refresh();
                      }
                    }),
                  ),
                ),
              );
            },
            "settings-item",
          ),
        );
      }
    } finally {
      busy = false;
    }
  }
  toolbar.append(
    button("New job", create),
    button("Refresh", run(refresh)),
    button("SSH connections", () => c.open("org.neon.connections")),
  );
  await refresh();
  const timer = setInterval(() => refresh().catch(() => {}), 10000);
  w.cleanup = () => {
    disposed = true;
    clearInterval(timer);
  };
}

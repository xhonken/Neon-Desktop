import { el, button, field, confirmAction } from "../ui.js";
export async function mount(w, c) {
  const bar = el("div", { class: "toolbar" }),
    list = el("div", { class: "workbench-list" }),
    content = el("div", { class: "workbench-detail" });
  w.content.append(
    bar,
    el("div", { class: "workbench-layout" }, list, content),
  );
  let hosts = [],
    keyData = { keys: [], unlocked: "" },
    selected = null;
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      c.notify(e.message);
    }
  };
  async function refresh() {
    hosts = (await c.call("ssh.list")).hosts;
    keyData = await c.call("ssh.keys");
    render();
  }
  function render() {
    list.replaceChildren();
    for (const group of [...new Set(hosts.map((h) => h.group || "Servers"))]) {
      list.append(el("h3", { class: "h6 muted mt-3", text: group }));
      for (const h of hosts.filter((h) => (h.group || "Servers") === group))
        list.append(
          button(
            h.name,
            () => edit(h),
            "settings-item" + (selected?.id === h.id ? " active" : ""),
          ),
        );
    }
    if (!hosts.length)
      list.append(
        el("p", { class: "muted", text: "Save a connection to get started." }),
      );
  }
  function edit(
    h = {
      name: "",
      host: "",
      port: 22,
      username: c.identity.username,
      group: "Servers",
      auth: "key",
      key: "",
      persistent: false,
      session: "neon",
    },
  ) {
    selected = h;
    render();
    content.replaceChildren(
      el("h2", { text: h.id ? h.name : "New SSH connection" }),
    );
    const fields = {};
    for (const [key, label] of [
      ["name", "Connection name"],
      ["host", "Host / IP address"],
      ["port", "Port"],
      ["username", "Username"],
      ["group", "Group"],
    ]) {
      fields[key] = field(label, h[key], key === "port" ? "number" : "text");
      content.append(fields[key].row);
    }
    const auth = el(
      "select",
      { class: "form-select", "aria-label": "Authentication" },
      ...["key", "password", "auto"].map((v) =>
        el("option", {
          value: v,
          text: {
            key: "SSH key",
            password: "Password (ask when connecting)",
            auto: "Default SSH keys / interactive login",
          }[v],
        }),
      ),
    );
    auth.value = h.auth;
    const key = el(
      "select",
      { class: "form-select", "aria-label": "SSH key" },
      el("option", { value: "", text: "Select a key" }),
      ...keyData.keys.map((k) => el("option", { value: k, text: k })),
    );
    key.value = h.key;
    const persistent = el("input", {
      type: "checkbox",
      "aria-label": "Persistent remote session",
    });
    persistent.checked = h.persistent;
    const session = field("Remote tmux session", h.session || "neon");
    content.append(
      el(
        "label",
        { class: "field" },
        el("span", { text: "Authentication" }),
        auth,
      ),
      el("label", { class: "field" }, el("span", { text: "SSH key" }), key),
      el(
        "label",
        { class: "field" },
        el("span", { text: "Keep remote session with tmux" }),
        persistent,
      ),
      session.row,
      el("p", {
        class: "muted",
        text: "tmux must already be installed on the remote host. Existing remote sessions are reattached. Changed host keys are refused; a new host requires confirmation in the terminal.",
      }),
    );
    async function save() {
      const value = {
        ...h,
        id: h.id || crypto.randomUUID().replaceAll("-", ""),
        ...Object.fromEntries(
          Object.entries(fields).map(([k, f]) => [k, f.input.value]),
        ),
        port: Number(fields.port.input.value),
        auth: auth.value,
        key: key.value,
        persistent: persistent.checked,
        session: session.input.value,
      };
      const updated = h.id
        ? hosts.map((p) => (p.id === h.id ? value : p))
        : [...hosts, value];
      await c.call("ssh.save", { hosts: updated });
      await refresh();
      selected = hosts.find((p) => p.id === value.id);
      edit(selected);
      return selected;
    }
    content.append(
      el(
        "div",
        { class: "toolbar" },
        button("Save", run(save)),
        button(
          "Save & connect",
          run(async () => {
            const p = await save();
            await c.open("org.neon.terminal", {
              state: { kind: "ssh", profile: p.id },
            });
          }),
        ),
        button(
          "Delete profile",
          run(async () => {
            if (
              h.id &&
              (await confirmAction(
                "Delete this saved profile? Existing SSH sessions will stay running.",
              ))
            ) {
              await c.call("ssh.save", {
                hosts: hosts.filter((p) => p.id !== h.id),
              });
              selected = null;
              await refresh();
              content.replaceChildren();
            }
          }),
        ),
      ),
    );
  }
  function keys() {
    content.replaceChildren(
      el("h2", { text: "SSH keys" }),
      el("p", {
        class: "muted",
        text: "Encrypted private keys stay in your ~/.ssh directory. Unlocking loads a key into your private SSH agent for a limited time. Passphrases are never saved in profiles.",
      }),
    );
    const select = el(
      "select",
      { class: "form-select", "aria-label": "Key to unlock" },
      ...keyData.keys.map((k) => el("option", { value: k, text: k })),
    );
    const pass = field("Key passphrase", "", "password");
    pass.input.autocomplete = "off";
    const lifetime = el(
      "select",
      { class: "form-select", "aria-label": "Unlock lifetime" },
      ...[
        ["3600", "1 hour"],
        ["14400", "4 hours"],
        ["28800", "8 hours"],
      ].map(([v, n]) => el("option", { value: v, text: n })),
    );
    content.append(
      select,
      pass.row,
      lifetime,
      el(
        "div",
        { class: "toolbar" },
        button(
          "Unlock key",
          run(async () => {
            const phrase = pass.input.value;
            pass.input.value = "";
            await c.call("ssh.unlock", {
              key: select.value,
              passphrase: phrase,
              seconds: Number(lifetime.value),
            });
            c.notify(
              "Key unlocked. Saved connections can now authenticate automatically.",
            );
            await refresh();
            keys();
          }),
        ),
        button(
          "Lock all keys",
          run(async () => {
            await c.call("ssh.lock");
            await refresh();
            keys();
          }),
        ),
        button(
          "Show public key",
          run(async () => {
            const p = await c.call("ssh.public", { key: select.value });
            content.append(
              el("pre", { class: "workbench-log", text: p.publicKey }),
            );
          }),
        ),
      ),
      el("pre", {
        class: "workbench-log",
        text: keyData.unlocked || "No keys unlocked",
      }),
    );
    const name = field("Imported key name", "neon_server");
    const upload = el("input", {
      type: "file",
      "aria-label": "Encrypted OpenSSH private key",
    });
    content.append(
      el("h3", { class: "h6 mt-4", text: "Import an encrypted OpenSSH key" }),
      name.row,
      upload,
      button(
        "Import key",
        run(async () => {
          const file = upload.files[0];
          if (!file || file.size > 65536)
            throw Error("Select a key file up to 64 KiB");
          const data = await file.text();
          await c.call("ssh.import", { name: name.input.value, data });
          upload.value = "";
          await refresh();
          keys();
        }),
      ),
    );
  }
  bar.append(
    button("New connection", () => edit()),
    button(
      "Keys & unlock",
      run(async () => {
        await refresh();
        keys();
      }),
    ),
    button("Refresh", run(refresh)),
  );
  await refresh();
  if (hosts.length) edit(hosts[0]);
  else edit();
}

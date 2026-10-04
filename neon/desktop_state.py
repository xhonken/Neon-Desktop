"""Shared window recovery with separate device preferences, all beneath HOME."""

import json
import re
import uuid

ID = re.compile(r"[a-f0-9-]{36}")
CONFIG = ".config/neon-desktop"
MAX_BYTES = 262144
MAX_CLOSED = 2000


def identities(values, limit=50):
    if (
        not isinstance(values, list)
        or len(values) > limit
        or any(not isinstance(i, str) or not ID.fullmatch(i) for i in values)
    ):
        raise ValueError("Invalid window identities")
    return values


class DesktopState:
    def __init__(self, fs):
        self.fs = fs
        self.workspace_path = CONFIG + "/workspace.json"

    def load(self, path, fallback):
        try:
            return json.loads(self.fs.read(path))
        except FileNotFoundError:
            return fallback

    def store(self, path, value):
        raw = json.dumps(value).encode()
        if len(raw) > MAX_BYTES:
            raise ValueError("Desktop configuration too large")
        self.fs.write(path, raw)

    def path(self, device):
        if device is None:
            return CONFIG + "/desktop.json"
        if not isinstance(device, str) or not ID.fullmatch(device):
            raise ValueError("Invalid device ID")
        return CONFIG + "/desktop-" + device + ".json"

    def windows(self, values, previous=()):
        if not isinstance(values, list) or len(values) > 50:
            raise ValueError("Expected at most 50 windows")
        result, seen = [], set()
        for value in values:
            if not isinstance(value, dict) or not isinstance(value.get("app"), str):
                raise ValueError("Invalid saved window")
            value = dict(value)
            ident = value.get("id")
            if ident is None:
                terminal = value.get("state", {}).get("terminal")
                match = next(
                    (w for w in previous if terminal and w.get("state", {}).get("terminal") == terminal and w["id"] not in seen),
                    None,
                )
                ident = match["id"] if match else str(uuid.uuid4())
            if not isinstance(ident, str) or not ID.fullmatch(ident) or ident in seen:
                raise ValueError("Invalid window identity")
            value["id"] = ident
            seen.add(ident)
            result.append(value)
        return result

    def workspace_state(self):
        saved = self.load(self.workspace_path, None)
        if saved is not None:
            return {
                "windows": self.windows(saved["windows"]),
                "closed": identities(saved.get("closed", []), MAX_CLOSED),
            }
        # Seed once from the latest old layout, retaining the old files for recovery.
        candidates = [
            entry for entry in self.fs.list(CONFIG)
            if re.fullmatch(r"desktop(?:-[a-f0-9-]{36})?\.json", entry["name"])
            and not entry["directory"] and not entry["symlink"]
        ]
        latest = max(candidates, key=lambda entry: entry["modified"], default=None)
        old = self.load(CONFIG + "/" + latest["name"], {}) if latest else {}
        windows = self.windows(old.get("windows", []))
        saved = {"windows": windows, "closed": []}
        self.store(self.workspace_path, saved)
        return saved

    def workspace(self):
        return self.workspace_state()["windows"]

    def get(self, device=None):
        path = self.path(device)
        prefs = self.load(path, self.load(CONFIG + "/desktop.json", {}))
        return {**prefs, "windows": self.workspace()}

    def save(self, device, value, changes=None):
        path = self.path(device)
        if not isinstance(value, dict) or len(json.dumps(value).encode()) > MAX_BYTES:
            raise ValueError("Invalid desktop configuration")
        workspace = self.workspace_state()
        windows = workspace["windows"]
        closed = dict.fromkeys(workspace["closed"])
        removed = []
        if changes is not None:
            if not isinstance(changes, dict):
                raise ValueError("Invalid window changes")
            removed = identities(changes.get("remove", []))
            upserts = self.windows(changes.get("upsert", []))
            opened = set(identities(changes["open"])) if "open" in changes else None
            if opened is not None and not opened <= {w["id"] for w in upserts}:
                raise ValueError("Opened window missing from updates")
            merged = {w["id"]: w for w in windows if w["id"] not in removed}
            for window in upserts:
                ident = window["id"]
                if ident in closed or ident in removed:
                    continue
                # Current clients distinguish opens from updates. An update of an
                # absent window cannot recreate it after old close records are evicted.
                if opened is None or ident in merged or ident in opened:
                    merged[ident] = window
            windows = self.windows(list(merged.values()))
        elif "windows" in value:
            # Older clients and administrative tools can still save a whole layout.
            incoming = self.windows(value["windows"], windows)
            removed = [w["id"] for w in windows if w["id"] not in {v["id"] for v in incoming}]
            windows = incoming
        for ident in removed:
            closed.pop(ident, None)
            closed[ident] = None
        # Bounded close records also protect older clients without explicit opens.
        windows = [w for w in windows if w["id"] not in closed]
        self.store(self.workspace_path, {
            "windows": windows, "closed": list(closed)[-MAX_CLOSED:],
        })
        self.store(path, {key: item for key, item in value.items() if key != "windows"})
        return {"ok": True}

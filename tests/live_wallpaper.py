"""Root-only installed HTTPS/PAM wallpaper acceptance with disposable accounts."""

import json, os, pathlib, pwd, secrets, shutil, subprocess, sys, tempfile

root = pathlib.Path(__file__).resolve().parents[1]
controller = pwd.getpwnam(sys.argv[2])
users = []
with tempfile.TemporaryDirectory(prefix="neon-wallpaper-check-") as temp:
    tmp = pathlib.Path(temp)
    os.chown(tmp, controller.pw_uid, controller.pw_gid)
    invalid = tmp / "invalid.svg"
    invalid.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    )
    try:
        for n in range(2):
            name = "neon-wall-" + secrets.token_hex(3)
            password = secrets.token_urlsafe(32)
            subprocess.run(["useradd", "-m", "-s", "/bin/bash", name], check=True)
            a = pwd.getpwnam(name)
            users.append({"name": name, "password": password, "uid": a.pw_uid})
            os.chmod(a.pw_dir, 0o700)
            subprocess.run(
                ["chpasswd"], input=name + ":" + password + "\n", text=True, check=True
            )
        payload = {
            "origin": sys.argv[1],
            "users": users,
            "image": str(root / "frontend/wallpapers/neon-glass.png"),
            "invalid": str(invalid),
            "output": temp,
        }
        subprocess.run(
            [
                "runuser",
                "-u",
                controller.pw_name,
                "--",
                "/opt/neon-node/bin/node",
                str(root / "scripts/wallpaper-check.mjs"),
            ],
            input=json.dumps(payload) + "\n",
            text=True,
            check=True,
            timeout=180,
            cwd=root,
        )
        out = pathlib.Path("/root/neon-install-evidence")
        out.mkdir(exist_ok=True, mode=0o700)
        for file in tmp.glob("*.png"):
            shutil.copyfile(file, out / file.name)
    finally:
        for u in users:
            uid = u["uid"]
            units = subprocess.check_output(
                [
                    "systemctl",
                    "list-units",
                    "--all",
                    "--plain",
                    "--no-legend",
                    "neon-worker*",
                    "neon-browser*",
                ],
                text=True,
            )
            for line in units.splitlines():
                name = line.split()[0]
                if name.endswith("@" + str(uid) + ".service"):
                    subprocess.run(["systemctl", "stop", name], check=False)
            subprocess.run(["pkill", "-u", str(uid)], check=False)
            subprocess.run(["userdel", "-r", u["name"]], check=False)

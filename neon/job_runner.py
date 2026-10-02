"""One unprivileged, systemd-cgroup-isolated job; immutable release entry point."""

import json, os, pwd, re, signal, subprocess, sys, time
from .fs import HomeFS


def main():
    os.umask(0o077)
    if os.getuid() < 1000:
        raise SystemExit("Refusing privileged execution")
    job = sys.argv[1]
    if not re.fullmatch(r"[a-f0-9]{32}", job):
        raise SystemExit("Invalid job")
    a = pwd.getpwuid(os.getuid())
    fs = HomeFS(a.pw_dir)
    base = ".local/share/neon-desktop/jobs/" + job
    spec = json.loads(fs.read(base + ".json"))
    argv = spec["argv"]
    if (
        not isinstance(argv, list)
        or not argv
        or len(argv) > 128
        or any(not isinstance(v, str) or "\0" in v for v in argv)
    ):
        raise SystemExit("Invalid command")
    cwd = fs.open(spec.get("cwd", "."), os.O_RDONLY | os.O_DIRECTORY)
    env = {
        **os.environ,
        "HOME": a.pw_dir,
        "USER": a.pw_name,
        "LOGNAME": a.pw_name,
        "SHELL": a.pw_shell,
    }
    started = time.time()
    tail = b""
    total = 0
    state = {"status": "running", "started": started, "pid": os.getpid()}

    def save():
        fs.write(base + ".result", json.dumps(state).encode())

    save()
    try:
        p = subprocess.Popen(
            argv,
            cwd=f"/proc/self/fd/{cwd}",
            pass_fds=(cwd,),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        state["child"] = p.pid
        save()
        signal.signal(signal.SIGTERM, lambda *_: p.terminate())
        while True:
            data = p.stdout.read1(65536)
            if not data:
                break
            total += len(data)
            tail = (tail + data)[-4 * 1024 * 1024 :]
            fs.write(base + ".log", tail)
        code = p.wait()
        state.update(
            status="completed" if code == 0 else "failed",
            exitCode=code,
            finished=time.time(),
            bytes=total,
            truncated=total > len(tail),
        )
        save()
    except Exception as e:
        state.update(status="failed", error=str(e)[:160], finished=time.time())
        save()
        raise
    finally:
        os.close(cwd)
        fs.close()


if __name__ == "__main__":
    main()

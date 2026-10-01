"""Descriptor-relative HOME filesystem. No symlinks, special files or mount escapes."""

import ctypes
import hashlib
import io
import os
import secrets
import stat
import zipfile
from contextlib import contextmanager

MAX_FILE = 16 * 1024 * 1024
MAX_ARCHIVE = 64 * 1024 * 1024


class How(ctypes.Structure):
    _fields_ = [
        ("flags", ctypes.c_uint64),
        ("mode", ctypes.c_uint64),
        ("resolve", ctypes.c_uint64),
    ]


libc = ctypes.CDLL(None, use_errno=True)


def beneath(fd, path, flags, mode=0):
    # openat2 is 437 on supported Linux arm64 and amd64. Fail closed on old kernels.
    how = How(flags | os.O_CLOEXEC, mode, 0x08 | 0x04 | 0x02 | 0x01)
    result = libc.syscall(437, fd, path.encode(), ctypes.byref(how), ctypes.sizeof(how))
    if result < 0:
        e = ctypes.get_errno()
        raise OSError(e, os.strerror(e))
    return result


def clean(path):
    if (
        not isinstance(path, str)
        or len(path) > 4096
        or "\x00" in path
        or path.startswith("/")
    ):
        raise ValueError("Invalid relative path")
    parts = path.split("/")
    if any(p in ("..", "") for p in parts) and path not in ("", "."):
        raise ValueError("Invalid path component")
    if any(p in (".ssh", ".gnupg") for p in parts):
        # Dedicated key management will own these; terminal still follows Linux rights.
        raise PermissionError("Use a terminal for key material")
    return "." if path in ("", ".") else path


class HomeFS:
    def __init__(self, home):
        self.root = os.open(
            home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        )

    def close(self):
        os.close(self.root)

    def open(self, path, flags=os.O_RDONLY, mode=0):
        return beneath(self.root, clean(path), flags, mode)

    @contextmanager
    def parent(self, path):
        path = clean(path)
        if path == ".":
            raise PermissionError("Cannot modify HOME itself")
        base, _, name = path.rpartition("/")
        fd = self.open(base or ".", os.O_RDONLY | os.O_DIRECTORY)
        try:
            yield fd, name
        finally:
            os.close(fd)

    def list(self, path="."):
        fd = self.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            items = []
            for name in sorted(os.listdir(fd))[:10000]:
                try:
                    st = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    items.append(
                        dict(
                            name=name,
                            directory=stat.S_ISDIR(st.st_mode),
                            symlink=stat.S_ISLNK(st.st_mode),
                            size=st.st_size,
                            modified=st.st_mtime,
                            mode=stat.filemode(st.st_mode),
                            uid=st.st_uid,
                            gid=st.st_gid,
                        )
                    )
                except FileNotFoundError:
                    continue
            return items
        finally:
            os.close(fd)

    def read(self, path):
        fd = self.open(path, os.O_RDONLY | os.O_NONBLOCK)
        try:
            st = os.fstat(fd)
            if (
                not stat.S_ISREG(st.st_mode)
                or st.st_nlink != 1
                or st.st_size > MAX_FILE
            ):
                raise ValueError(
                    "Only single-link regular files up to 16 MiB are supported"
                )
            with os.fdopen(fd, "rb", closefd=False) as f:
                data = f.read(MAX_FILE + 1)
            if len(data) > MAX_FILE:
                raise ValueError("File too large")
            return data
        finally:
            os.close(fd)

    def write(self, path, data, exclusive=False, expected=None):
        if len(data) > MAX_FILE:
            raise ValueError("File too large")
        if (
            expected is not None
            and hashlib.sha256(self.read(path)).hexdigest() != expected
        ):
            raise ValueError("File changed on disk; reopen or save under a new name")
        with self.parent(path) as (fd, name):
            try:
                old = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if not stat.S_ISREG(old.st_mode) or old.st_nlink != 1:
                    raise PermissionError("Unsafe file target")
                check = beneath(fd, name, os.O_WRONLY | os.O_NONBLOCK)
                os.close(check)
            except FileNotFoundError:
                old = None
            temp = ".neon-" + secrets.token_hex(12)
            out = os.open(
                temp,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                0o600,
                dir_fd=fd,
            )
            try:
                with os.fdopen(out, "wb") as f:
                    f.write(data)
                    f.flush()
                    if old:
                        os.fchmod(f.fileno(), stat.S_IMODE(old.st_mode) & 0o777)
                    os.fsync(f.fileno())
                if exclusive:
                    os.link(
                        temp, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False
                    )
                    os.unlink(temp, dir_fd=fd)
                else:
                    os.rename(temp, name, src_dir_fd=fd, dst_dir_fd=fd)
                os.fsync(fd)
            finally:
                try:
                    os.unlink(temp, dir_fd=fd)
                except FileNotFoundError:
                    pass

    def mkdir(self, path):
        with self.parent(path) as (fd, name):
            os.mkdir(name, 0o700, dir_fd=fd)

    def rename(self, source, target):
        # renameat2 RENAME_NOREPLACE; do not clobber files silently.
        with self.parent(source) as (a, src), self.parent(target) as (b, dst):
            st = os.stat(src, dir_fd=a, follow_symlinks=False)
            if not (stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode)):
                raise PermissionError("Unsafe source")
            if libc.renameat2(a, src.encode(), b, dst.encode(), 1) != 0:
                e = ctypes.get_errno()
                raise OSError(e, os.strerror(e))

    def remove(self, path):
        # Empty directories only. No unbounded recursive deletion.
        with self.parent(path) as (fd, name):
            st = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISDIR(st.st_mode):
                os.rmdir(name, dir_fd=fd)
            else:
                os.unlink(name, dir_fd=fd)

    def copy(self, source, target):
        self.write(target, self.read(source), exclusive=True)

    def zip(self, paths, target):
        out = io.BytesIO()
        total = 0
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            for path in paths:
                data = self.read(path)
                total += len(data)
                if total > MAX_ARCHIVE:
                    raise ValueError("Archive too large")
                z.writestr(clean(path), data)
        self.write(target, out.getvalue(), exclusive=True)

    def extract(self, source, target):
        # Prevalidate entire archive. Create a new destination to avoid overwrite.
        raw = self.read(source)
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            infos = z.infolist()
            total = 0
            if len(infos) > 1000:
                raise ValueError("Too many archive entries")
            names = set()
            for info in infos:
                name = clean(info.filename.rstrip("/"))
                if name in names or name == ".":
                    raise ValueError("Duplicate archive entry")
                names.add(name)
                mode = info.external_attr >> 16
                if stat.S_ISLNK(mode) or (
                    stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)
                ):
                    raise ValueError("Unsafe archive type")
                total += info.file_size
                if (
                    info.file_size > MAX_FILE
                    or total > MAX_ARCHIVE
                    or info.flag_bits & 1
                ):
                    raise ValueError("Unsupported archive")
            self.mkdir(target)
            for info in infos:
                parts = info.filename.rstrip("/").split("/")
                for n in range(1, len(parts)):
                    try:
                        self.mkdir(target + "/" + "/".join(parts[:n]))
                    except FileExistsError:
                        pass
                name = target + "/" + "/".join(parts)
                if info.is_dir():
                    try:
                        self.mkdir(name)
                    except FileExistsError:
                        pass
                else:
                    self.write(name, z.read(info), exclusive=True)

"""Bounded, descriptor-relative directory operations and private recoverable trash."""
import json
import os
import re
import secrets
import stat
import time
from .fs import beneath, clean, libc

TRASH = '.local/share/neon-desktop/trash'
MAX_ENTRIES = 20000
MAX_BYTES = 1024**3


def noreplace(a, src, b, dst):
    if libc.renameat2(a, src.encode(), b, dst.encode(), 1):
        code = __import__('ctypes').get_errno()
        raise OSError(code, os.strerror(code))


def remove_tree(fd, name, budget=None, depth=0):
    budget = [0] if budget is None else budget
    budget[0] += 1
    if budget[0] > MAX_ENTRIES or depth > 64:
        raise ValueError('Folder exceeds operation limit')
    st = os.stat(name, dir_fd=fd, follow_symlinks=False)
    if stat.S_ISDIR(st.st_mode):
        child = beneath(fd, name, os.O_RDONLY | os.O_DIRECTORY)
        try:
            for entry in os.listdir(child):
                remove_tree(child, entry, budget, depth + 1)
        finally:
            os.close(child)
        os.rmdir(name, dir_fd=fd)
    else:
        # Unlink a symlink itself; never follow it, including during cleanup.
        os.unlink(name, dir_fd=fd)


class FileOperations:
    def __init__(self, fs):
        self.fs = fs

    def trash_root(self):
        current = ''
        for part in TRASH.split('/'):
            current = current + '/' + part if current else part
            try:
                self.fs.mkdir(current)
            except FileExistsError:
                pass
        fd = self.fs.open(TRASH, os.O_RDONLY | os.O_DIRECTORY)
        st = os.fstat(fd)
        if st.st_uid != os.getuid() or st.st_mode & 0o077:
            os.close(fd)
            raise PermissionError('Trash must be private and owned by you')
        return fd

    @staticmethod
    def regular_path(path):
        path = clean(path)
        if path == '.' or path == TRASH or path.startswith(TRASH + '/') or TRASH.startswith(path + '/'):
            raise ValueError('Cannot operate on HOME or the trash storage directory')
        return path

    def trash(self, path):
        path = self.regular_path(path)
        root = self.trash_root()
        ident = secrets.token_hex(16)
        try:
            os.mkdir(ident, 0o700, dir_fd=root)
            slot = beneath(root, ident, os.O_RDONLY | os.O_DIRECTORY)
            try:
                # Commit metadata before moving data. Interrupted empty records are ignored.
                fd = beneath(slot, 'record.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, 'w') as out:
                    json.dump({'path': path, 'deleted': time.time()}, out)
                    out.flush(); os.fsync(out.fileno())
                with self.fs.parent(path) as (parent, name):
                    noreplace(parent, name, slot, 'item')
                os.fsync(slot)
            except BaseException:
                # Never remove a successfully moved item if later fsync failed.
                if not os.path.lexists(f'/proc/self/fd/{slot}/item'):
                    remove_tree(root, ident)
                raise
            finally:
                os.close(slot)
            return ident
        finally:
            os.close(root)

    def record(self, root, ident):
        if not isinstance(ident, str) or not re.fullmatch(r'[a-f0-9]{32}', ident):
            raise ValueError('Invalid trash entry')
        slot = beneath(root, ident, os.O_RDONLY | os.O_DIRECTORY)
        try:
            fd = beneath(slot, 'record.json', os.O_RDONLY | os.O_NONBLOCK)
            try:
                st = os.fstat(fd)
                if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_size > 8192:
                    raise ValueError('Invalid trash record')
                with os.fdopen(fd, closefd=False) as src:
                    record = json.load(src)
            finally:
                os.close(fd)
            record['path'] = self.regular_path(record['path'])
            st = os.stat('item', dir_fd=slot, follow_symlinks=False)
            return slot, {**record, 'id': ident, 'directory': stat.S_ISDIR(st.st_mode), 'size': st.st_size}
        except BaseException:
            os.close(slot)
            raise

    def list_trash(self):
        root = self.trash_root()
        try:
            result = []
            for ident in os.listdir(root)[:MAX_ENTRIES]:
                try:
                    slot, record = self.record(root, ident)
                    os.close(slot)
                    result.append(record)
                except (OSError, ValueError, KeyError, TypeError):
                    continue
            return sorted(result, key=lambda r: r['deleted'], reverse=True)
        finally:
            os.close(root)

    def restore(self, ident, target=None):
        root = self.trash_root()
        try:
            slot, record = self.record(root, ident)
            try:
                path = self.regular_path(target or record['path'])
                with self.fs.parent(path) as (parent, name):
                    noreplace(slot, 'item', parent, name)
                os.unlink('record.json', dir_fd=slot)
            finally:
                os.close(slot)
            os.rmdir(ident, dir_fd=root)
            return path
        finally:
            os.close(root)

    def purge(self, ident):
        root = self.trash_root()
        try:
            # Validate record and ID before allowing permanent deletion.
            slot, _ = self.record(root, ident)
            try:
                # Keep the recovery record if a bounded/failed purge leaves data.
                remove_tree(slot, 'item')
                os.unlink('record.json', dir_fd=slot)
            finally:
                os.close(slot)
            os.rmdir(ident, dir_fd=root)
        finally:
            os.close(root)

    def copy(self, source, target, progress=None):
        source, target = self.regular_path(source), self.regular_path(target)
        if target == source or target.startswith(source + '/'):
            raise ValueError('Destination must be outside the source folder')
        count, total = 0, 0
        def duplicate(a, name, b, dest, depth=0):
            nonlocal count, total
            count += 1
            if count > MAX_ENTRIES or depth > 64:
                raise ValueError('Folder exceeds operation limit')
            clean(name)
            fd = beneath(a, name, os.O_RDONLY | os.O_NONBLOCK)
            try:
                st = os.fstat(fd)
                if stat.S_ISDIR(st.st_mode):
                    os.mkdir(dest, 0o700, dir_fd=b)
                    child = beneath(b, dest, os.O_RDONLY | os.O_DIRECTORY)
                    try:
                        for entry in os.listdir(fd):
                            duplicate(fd, entry, child, entry, depth + 1)
                    finally:
                        os.close(child)
                elif stat.S_ISREG(st.st_mode) and st.st_nlink == 1:
                    out = beneath(b, dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    try:
                        while data := os.read(fd, 1024 * 1024):
                            total += len(data)
                            if total > MAX_BYTES:
                                raise ValueError('Copy exceeds 1 GiB; use the terminal for larger transfers')
                            view = memoryview(data)
                            while view:
                                view = view[os.write(out, view):]
                            if progress: progress(count, total)
                        os.fchmod(out, stat.S_IMODE(st.st_mode) & 0o777)
                        os.fsync(out)
                    finally:
                        os.close(out)
                else:
                    raise ValueError('Symlinks, hardlinks and special files cannot be copied')
            finally:
                os.close(fd)
            if progress: progress(count, total)
        with self.fs.parent(source) as (a, src), self.fs.parent(target) as (b, dst):
            temp = '.neon-copy-' + secrets.token_hex(12)
            try:
                duplicate(a, src, b, temp)
                noreplace(b, temp, b, dst)
            finally:
                try:
                    remove_tree(b, temp)
                except FileNotFoundError:
                    pass
        return {'entries': count, 'bytes': total}

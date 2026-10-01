import io
import hashlib
import os
from pathlib import Path
import tempfile
import unittest
import zipfile
from neon.fs import HomeFS, clean


class FilesystemTests(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.root = Path(self.t.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.fs = HomeFS(str(self.home))
        (self.root / "secret").write_text("outside")

    def tearDown(self):
        self.fs.close()
        self.t.cleanup()

    def test_real_files_and_atomic_write(self):
        self.fs.mkdir("Documents")
        self.fs.write("Documents/a.txt", b"one", True)
        self.assertEqual((self.home / "Documents/a.txt").read_bytes(), b"one")
        self.fs.write("Documents/a.txt", b"two")
        self.assertEqual(self.fs.read("Documents/a.txt"), b"two")

    def test_preserve_execute_mode_and_conflict(self):
        self.fs.write("run.sh", b"one")
        os.chmod(self.home / "run.sh", 0o750)
        revision = hashlib.sha256(b"one").hexdigest()
        self.fs.write("run.sh", b"two", expected=revision)
        self.assertEqual((self.home / "run.sh").stat().st_mode & 0o777, 0o750)
        with self.assertRaises(ValueError):
            self.fs.write("run.sh", b"three", expected=revision)
        self.assertEqual(self.fs.read("run.sh"), b"two")

    def test_traversal(self):
        for p in ["../secret", "/etc/passwd", "a/../../secret", "a//b", "a\0b"]:
            with self.assertRaises((ValueError, OSError)):
                self.fs.read(p)

    def test_symlink_file_and_parent(self):
        (self.home / "link").symlink_to(self.root / "secret")
        (self.home / "escape").symlink_to(self.root, target_is_directory=True)
        for p in ["link", "escape/secret"]:
            with self.assertRaises(OSError):
                self.fs.read(p)
        with self.assertRaises(OSError):
            self.fs.write("escape/secret", b"bad")
        self.assertEqual((self.root / "secret").read_text(), "outside")

    def test_hardlink_rejected(self):
        os.link(self.root / "secret", self.home / "hard")
        with self.assertRaises(ValueError):
            self.fs.read("hard")
        with self.assertRaises(PermissionError):
            self.fs.write("hard", b"bad")

    def test_special_file_rejected_without_blocking(self):
        os.mkfifo(self.home / "pipe")
        with self.assertRaises(ValueError):
            self.fs.read("pipe")

    def test_no_clobber(self):
        self.fs.write("a", b"a")
        self.fs.write("b", b"b")
        with self.assertRaises(OSError):
            self.fs.rename("a", "b")
        with self.assertRaises(FileExistsError):
            self.fs.copy("a", "b")
        self.assertEqual(self.fs.read("b"), b"b")

    def test_zip_slip_prevalidation(self):
        b = io.BytesIO()
        with zipfile.ZipFile(b, "w") as z:
            z.writestr("good.txt", "good")
            z.writestr("../secret", "bad")
        self.fs.write("evil.zip", b.getvalue())
        with self.assertRaises(ValueError):
            self.fs.extract("evil.zip", "out")
        self.assertFalse((self.home / "out").exists())

    def test_zip_symlink(self):
        b = io.BytesIO()
        with zipfile.ZipFile(b, "w") as z:
            i = zipfile.ZipInfo("link")
            i.external_attr = 0o120777 << 16
            z.writestr(i, "/etc/passwd")
        self.fs.write("evil.zip", b.getvalue())
        with self.assertRaises(ValueError):
            self.fs.extract("evil.zip", "out")

    def test_zip_roundtrip(self):
        self.fs.write("hello.txt", b"hello")
        self.fs.zip(["hello.txt"], "files.zip")
        self.fs.extract("files.zip", "out")
        self.assertEqual(self.fs.read("out/hello.txt"), b"hello")

    def test_private_key_paths(self):
        for p in [".ssh/id_ed25519", ".gnupg/private-key"]:
            with self.assertRaises(PermissionError):
                clean(p)


if __name__ == "__main__":
    unittest.main()

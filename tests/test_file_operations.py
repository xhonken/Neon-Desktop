import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from neon.fs import HomeFS
from neon.file_operations import FileOperations, TRASH

class Operations(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.home=Path(self.tmp.name)
        self.fs=HomeFS(self.home);self.ops=FileOperations(self.fs)
        self.addCleanup(self.tmp.cleanup);self.addCleanup(self.fs.close)
    def test_folder_roundtrip_restore_conflict_preserves_both(self):
        self.fs.mkdir('project');self.fs.write('project/file',b'original')
        ident=self.ops.trash('project')
        self.assertFalse((self.home/'project').exists())
        self.assertEqual(self.ops.list_trash()[0]['path'],'project')
        self.fs.mkdir('project');self.fs.write('project/file',b'new')
        with self.assertRaises(FileExistsError):self.ops.restore(ident)
        self.assertEqual(self.fs.read('project/file'),b'new')
        self.ops.restore(ident,'recovered')
        self.assertEqual(self.fs.read('recovered/file'),b'original')
        self.assertEqual(self.ops.list_trash(),[])
    def test_recursive_copy_is_private_no_overwrite_and_preserves_executable(self):
        self.fs.mkdir('project');self.fs.mkdir('project/sub');self.fs.write('project/sub/run',b'content')
        (self.home/'project/sub/run').chmod(0o750)
        progress=[];self.ops.copy('project','copy',lambda count,size:progress.append((count,size)))
        self.assertEqual(self.fs.read('copy/sub/run'),b'content')
        self.assertEqual((self.home/'copy/sub/run').stat().st_mode & 0o777,0o750)
        with self.assertRaises(FileExistsError):self.ops.copy('project','copy')
        self.assertFalse(list(self.home.glob('.neon-copy-*')))
        self.assertGreater(progress[-1][1],0)
    def test_copy_rejects_symlink_hardlink_fifo_and_cleans_partial_tree(self):
        for kind in ('symlink','hardlink','fifo'):
            with self.subTest(kind=kind):
                source='project-'+kind;self.fs.mkdir(source);self.fs.write(source+'/a',b'safe')
                unsafe=self.home/source/'z'
                if kind=='symlink':unsafe.symlink_to('/etc/passwd')
                elif kind=='hardlink':os.link(self.home/source/'a',unsafe)
                else:os.mkfifo(unsafe)
                with self.assertRaises((OSError,ValueError)):self.ops.copy(source,'copy-'+kind)
                self.assertFalse((self.home/('copy-'+kind)).exists())
                self.assertFalse(list(self.home.glob('.neon-copy-*')))
    def test_purge_never_follows_symlinks(self):
        outside=self.home/'keep';outside.write_text('keep')
        self.fs.mkdir('folder');(self.home/'folder/link').symlink_to(outside)
        ident=self.ops.trash('folder');self.ops.purge(ident)
        self.assertEqual(outside.read_text(),'keep');self.assertEqual(self.ops.list_trash(),[])
    def test_traversal_reserved_roots_and_self_copy_rejected(self):
        self.fs.mkdir('folder')
        for path in ('.','../etc','/etc',TRASH,'.local'):
            with self.assertRaises(ValueError):self.ops.trash(path)
        with self.assertRaises(ValueError):self.ops.copy('folder','folder/nested')
        with self.assertRaises(ValueError):self.ops.restore('../outside')
    def test_trash_directory_symlink_rejected(self):
        self.fs.mkdir('.local');self.fs.mkdir('.local/share');self.fs.mkdir('.local/share/neon-desktop')
        (self.home/TRASH).symlink_to('/tmp')
        with self.assertRaises(OSError):self.ops.list_trash()

    def test_interrupted_purge_keeps_remaining_data_discoverable(self):
        self.fs.mkdir('folder')
        for name in ('a','b','c'):self.fs.write('folder/'+name,b'content')
        ident=self.ops.trash('folder')
        with patch('neon.file_operations.MAX_ENTRIES',2):
            with self.assertRaises(ValueError):self.ops.purge(ident)
        self.assertEqual(self.ops.list_trash()[0]['id'],ident)
        self.ops.restore(ident)
        self.assertTrue(list((self.home/'folder').iterdir()))

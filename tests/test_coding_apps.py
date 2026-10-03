import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from neon import coding_apps
from neon.broker import manifests


class CodingAppsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.config = Path(self.tmp.name) / 'coding.json'
        self.patch = patch.object(coding_apps, 'CONFIG', self.config)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()

    def test_optional_apps_hidden_on_unconfigured_hosts(self):
        self.assertEqual(coding_apps.available_apps(), set())
        self.assertNotIn('org.neon.codex', manifests())
        with self.assertRaises(ValueError):
            coding_apps.command('codex')

    @patch('neon.coding_apps.os.access', return_value=True)
    def test_fixed_command_vectors_and_per_tool_actions(self, _):
        self.config.write_text(json.dumps({'codex': {'enabled': True}, 'qwen': {'enabled': True}}))
        self.assertIn('org.neon.codex', manifests())
        self.assertIn('org.neon.qwen-coder', manifests())
        self.assertEqual(coding_apps.command('codex', 'login'), ['/usr/local/bin/neon-codex', 'login'])
        self.assertEqual(coding_apps.command('qwen', 'resume'), ['/usr/local/bin/neon-qwen-coder', 'resume'])
        for kind, mode in [('qwen', 'login'), ('codex', ';touch /tmp/wrong'), ('../../bin/sh', 'start'), ('codex', ['start'])]:
            with self.assertRaises((ValueError, TypeError)):
                coding_apps.command(kind, mode)

    def test_disabled_and_incomplete_installations_fail_closed(self):
        self.config.write_text(json.dumps({'codex': {'enabled': False}, 'qwen': {'enabled': True}}))
        self.assertNotIn('org.neon.codex', manifests())
        with patch('neon.coding_apps.os.access', return_value=False):
            with self.assertRaises(ValueError): coding_apps.command('qwen')
        self.config.write_text('[]')
        with self.assertRaises(ValueError): coding_apps.settings()

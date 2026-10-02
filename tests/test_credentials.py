import unittest
from neon.credentials import shadow_version

class CredentialState(unittest.TestCase):
    def test_valid_fingerprint_changes_with_password_and_policy(self):
        original='test:$y$example:100:0:99:7::: '
        self.assertEqual(shadow_version(original,101),shadow_version(original,101))
        self.assertNotEqual(shadow_version(original,101),shadow_version(original.replace('example','changed'),101))
        self.assertNotIn('example',shadow_version(original,101))
    def test_locked_empty_expired_and_forced_change_rejected(self):
        for record in ('test:!locked:100:0:99:7:::', 'test:*:100:0:99:7:::', 'test::100:0:99:7:::', 'test:$y$example:0:0:99:7:::', 'test:$y$example:100:0:1:7:::', 'test:$y$example:100:0:99:7::101:'):
            with self.subTest(record=record),self.assertRaises(ValueError):
                shadow_version(record,102)

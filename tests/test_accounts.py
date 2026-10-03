import unittest
from neon.accounts import valid_name,new_password,account
class AccountValidation(unittest.TestCase):
    def test_account_names_cannot_select_flags_paths_or_records(self):
        for name in ('root:0','../root','--root','Bad Name','a\nb',None,'a'*33):
            with self.assertRaises(ValueError):valid_name(name)
        self.assertEqual(valid_name('alice-qa_1'),'alice-qa_1')
    def test_password_transport_and_minimum_length(self):
        for value in ('short','x'*1025,'x'*12+'\n',None,'x'*12+'\x00'):
            with self.assertRaises(ValueError):new_password(value)
        self.assertEqual(new_password('a sufficiently long passphrase'),'a sufficiently long passphrase')
    def test_root_cannot_be_an_account_target(self):
        with self.assertRaises(ValueError):account('root')

#!/usr/bin/env python3
"""Exercise Harbor response semantics offline.  No registry calls or secrets."""
import io
import json
import pathlib
import sys
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'checks'))
from guard_image_tags import main


def response(data):
    return io.BytesIO(json.dumps(data).encode())


def missing():
    return HTTPError('https://registry.invalid', 404, 'missing', {}, None)


class Guard(unittest.TestCase):
    def run_guard(self, results, fails=True):
        # Empty-password test below never makes a network call.
        with patch.dict('os.environ', {'HARBOR_USERNAME': 'test-only', 'HARBOR_PASSWORD': 'test-only', 'VERSION': 'v1.0.0', 'REVISION': 'a' * 40}), patch('urllib.request.urlopen', side_effect=results) as request:
            if fails:
                with self.assertRaises(SystemExit):
                    main()
            else:
                main()
            return request.call_count

    def test_new_tags(self):
        self.assertEqual(self.run_guard([response({'metadata': {'public': 'true'}}), missing(), missing(), missing()], False), 4)

    def test_each_existing_tag(self):
        for index in range(3):
            with self.subTest(index=index):
                self.run_guard([response({'metadata': {'public': 'true'}})] + [missing() for _ in range(index)] + [response({'digest': 'test-only'})])

    def test_project_missing(self):
        self.run_guard([missing()])

    def test_project_private(self):
        self.run_guard([response({'metadata': {'public': 'false'}})])

    def test_auth_errors_not_absent(self):
        for status in (401, 403, 500):
            with self.subTest(status=status):
                self.run_guard([response({'metadata': {'public': 'true'}}), HTTPError('https://registry.invalid', status, 'refused', {}, None)])

    def test_network_failure(self):
        self.run_guard([URLError('offline')])

    def test_invalid_response(self):
        self.run_guard([io.BytesIO(b'invalid-json')])

    def test_empty_credentials(self):
        with patch.dict('os.environ', {'HARBOR_USERNAME': '', 'HARBOR_PASSWORD': ''}), patch('urllib.request.urlopen') as request:
            with self.assertRaises(SystemExit):
                main()
            request.assert_not_called()


if __name__ == '__main__':
    unittest.main(verbosity=2)

#!/usr/bin/env python3
"""GREEN baseline plus independent RED mutations of the real workflow."""
import copy
import pathlib
import subprocess
import sys
import tempfile
import unittest
import yaml

ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / '.github/scripts/checks'))
from validate_publish_image import validate
BASE = yaml.safe_load((ROOT / '.github/workflows/publish-image.yaml').read_text())


class Contract(unittest.TestCase):
    def check(self, mutate=None):
        doc = copy.deepcopy(BASE)
        if mutate:
            mutate(doc)
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / 'workflow.yaml'
            path.write_text(yaml.safe_dump(doc))
            errors = validate(path)
            if mutate:
                self.assertTrue(errors, 'RED mutation was accepted')
                result = subprocess.run([sys.executable, str(ROOT / '.github/scripts/checks/validate_publish_image.py'), str(path)], capture_output=True)
                self.assertEqual(result.returncode, 1, 'RED CLI must fail')
            else:
                self.assertEqual(errors, [])

    def test_green(self):
        self.check()

    def test_red_missing_tag_trigger(self):
        self.check(lambda d: d['on'].pop('push'))

    def test_red_missing_test(self):
        self.check(lambda d: d['jobs']['publish'].update(steps=[s for s in d['jobs']['publish']['steps'] if s.get('run') != 'npm test']))

    def test_red_mutable_only(self):
        def mutate(d):
            next(s for s in d['jobs']['publish']['steps'] if s.get('id') == 'image')['with']['tags'] = 'registry.sarvent.cloud/auth-api/auth-api:latest'
        self.check(mutate)

    def test_red_hardcoded_credentials(self):
        self.check(lambda d: d['jobs']['publish'].update(env={'HARBOR_PASSWORD': 'red-case-not-a-real-credential'}))

    def test_red_pull_request(self):
        self.check(lambda d: d['on'].update(pull_request={}))

    def test_red_branch_push(self):
        self.check(lambda d: d['on']['push'].update(branches=['master']))

    def test_red_test_skipped(self):
        def mutate(d):
            next(s for s in d['jobs']['publish']['steps'] if s.get('run') == 'npm test')['if'] = 'false'
        self.check(mutate)

    def test_red_test_after_build(self):
        def mutate(d):
            steps = d['jobs']['publish']['steps']
            test = next(s for s in steps if s.get('run') == 'npm test')
            steps.remove(test)
            steps.append(test)
        self.check(mutate)

    def test_red_missing_immutability_guard(self):
        self.check(lambda d: d['jobs']['publish'].update(steps=[s for s in d['jobs']['publish']['steps'] if s.get('name') != 'Refuse existing tags']))


if __name__ == '__main__':
    unittest.main(verbosity=2)

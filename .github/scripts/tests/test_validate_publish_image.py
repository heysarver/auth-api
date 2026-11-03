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
GUARD = ROOT / '.github/scripts/checks/guard_image_tags.py'
GUARD_SOURCE = GUARD.read_text()


class Contract(unittest.TestCase):
    def check(self, mutate=None, guard_source=None):
        doc = copy.deepcopy(BASE)
        if mutate:
            mutate(doc)
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / 'workflow.yaml'
            path.write_text(yaml.safe_dump(doc))
            guard_path = GUARD
            if guard_source is not None:
                guard_path = pathlib.Path(folder) / 'guard_image_tags.py'
                guard_path.write_text(guard_source)
            errors = validate(path, guard_path)
            if mutate or guard_source is not None:
                self.assertTrue(errors, 'RED mutation was accepted')
                result = subprocess.run([sys.executable, str(ROOT / '.github/scripts/checks/validate_publish_image.py'), str(path), str(guard_path)], capture_output=True)
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
            next(s for s in d['jobs']['publish']['steps'] if s.get('id') == 'image')['with']['tags'] = 'registry.sarvent.cloud/feedvalue-staging/auth-api:latest'
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

    def test_red_shared_auth_api_project(self):
        def mutate(d):
            d['jobs']['publish']['env']['IMAGE_STAGING'] = 'registry.sarvent.cloud/auth-api/auth-api'
        self.check(mutate)

    def test_red_missing_prod_project(self):
        def mutate(d):
            d['jobs']['publish']['env'].pop('IMAGE_PROD')
        self.check(mutate)

    def test_red_wrong_prod_project(self):
        def mutate(d):
            d['jobs']['publish']['env']['IMAGE_PROD'] = 'registry.sarvent.cloud/feedvalue-staging/auth-api'
        self.check(mutate)

    def test_red_single_target_repository(self):
        source = GUARD_SOURCE.replace("    ('feedvalue-prod', 'auth-api'),\n", '')
        self.assertNotEqual(source, GUARD_SOURCE)
        self.check(guard_source=source)

    def test_red_guard_without_staging_project(self):
        source = GUARD_SOURCE.replace("    ('feedvalue-staging', 'auth-api'),\n", '')
        self.assertNotEqual(source, GUARD_SOURCE)
        self.check(guard_source=source)


if __name__ == '__main__':
    unittest.main(verbosity=2)

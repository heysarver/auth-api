#!/usr/bin/env python3
"""Fail-closed structural contract for the standalone publish workflow."""
import pathlib
import re
import sys
import yaml

PUBLISH_IF = "github.ref_type == 'tag' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')"
STAGING_PROJECT = 'feedvalue-staging'
PROD_PROJECT = 'feedvalue-prod'
REPOSITORY = 'auth-api'
FORBIDDEN_PROJECT = 'registry.sarvent.cloud/auth-api/'


def validate(path, guard_path=None):
    with open(path, encoding='utf-8') as handle:
        doc = yaml.safe_load(handle)
    errors = []
    triggers = doc.get('on', doc.get(True, {}))
    if not isinstance(triggers, dict) or set(triggers) != {'push', 'workflow_dispatch'}:
        errors.append('Only tag push and workflow_dispatch triggers allowed; no pull_request steps')
        triggers = triggers if isinstance(triggers, dict) else {}
    if triggers.get('push') != {'tags': ['v*.*.*']}:
        errors.append('Exact tag trigger required; branch pushes forbidden')
    jobs = doc.get('jobs', {})
    if set(jobs) != {'validate', 'publish'}:
        errors.append('Unexpected or missing jobs')
    publish = jobs.get('publish', {})
    if publish.get('if') != PUBLISH_IF or publish.get('needs') != 'validate':
        errors.append('Publish must depend on validation and exact tag-only event guard')
    steps = publish.get('steps', [])
    builds = [i for i, s in enumerate(steps) if str(s.get('uses', '')).startswith('docker/build-push-action@')]
    if len(builds) != 1:
        errors.append('Exactly one image build required')
    else:
        before = steps[:builds[0]]
        for command in ('npm ci', 'npm run lint', 'npm test', 'python .github/scripts/checks/guard_image_tags.py'):
            if not any(s.get('run') == command and not s.get('if') and not s.get('continue-on-error') for s in before):
                errors.append('Missing unconditional pre-build gate: ' + command)
        build = steps[builds[0]].get('with', {})
        if build.get('push') is not True or build.get('tags') != '${{ steps.release.outputs.tags }}' or build.get('provenance') != 'mode=max':
            errors.append('Immutable release tags and provenance required')
    resolver = next((s.get('run', '') for s in steps if s.get('id') == 'release'), '')
    if "tags = [tag, sha, f'{tag}-{sha}']" not in resolver:
        errors.append('Exact version, full SHA, and version-SHA tags required; mutable-only tags forbidden')
    if 'images = [os.environ[\'IMAGE_STAGING\'], os.environ[\'IMAGE_PROD\']]' not in resolver:
        errors.append('Resolver must publish tags to both FeedValue projects')
    environment = publish.get('env', {}) or {}
    expected_images = {
        'IMAGE_STAGING': f'registry.sarvent.cloud/{STAGING_PROJECT}/{REPOSITORY}',
        'IMAGE_PROD': f'registry.sarvent.cloud/{PROD_PROJECT}/{REPOSITORY}',
    }
    for key, image in expected_images.items():
        if environment.get(key) != image:
            errors.append(f'Expected {key}={image}')
    if FORBIDDEN_PROJECT in str(environment) or FORBIDDEN_PROJECT in resolver:
        errors.append('No shared auth-api Harbor project may be referenced')
    validation = str(jobs.get('validate', {}).get('steps', []))
    for script in ('validate_publish_image.py', 'test_validate_publish_image.py', 'test_guard_image_tags.py'):
        if script not in validation:
            errors.append('Validation job must execute ' + script)
    if guard_path is None:
        guard_path = pathlib.Path(path).resolve().parent.parent / 'scripts' / 'checks' / 'guard_image_tags.py'
    try:
        guard_source = pathlib.Path(guard_path).read_text(encoding='utf-8')
    except OSError:
        errors.append('Harbor guard script not readable')
        guard_source = ''
    for project in (STAGING_PROJECT, PROD_PROJECT):
        if project not in guard_source:
            errors.append(f'Harbor guard must check project {project}')
    if guard_source.count("'auth-api'") < 2 or guard_source.count('TARGET_REPOSITORIES') < 2:
        errors.append('Harbor guard must cover both target repositories')

    def credentials(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if re.search(r'(password|username|token|secret|credential)$', str(key), re.I) and isinstance(item, str):
                    if item and not re.fullmatch(r'\$\{\{ secrets\.[A-Z_]+ \}\}', item):
                        errors.append('Hardcoded credential field: ' + str(key))
                credentials(item)
        elif isinstance(value, list):
            for item in value:
                credentials(item)
        elif isinstance(value, str):
            if re.search(r'(?:PASSWORD|TOKEN|SECRET|USERNAME)=[^$\s"\']+', value) or re.search(r'docker login.*(?:-p |--password[ =])', value):
                errors.append('Hardcoded or unsafe inline credential')
    credentials(doc)
    return errors


def main():
    errors = validate(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
    for error in errors:
        print('FAIL:', error)
    if not errors:
        print('Publish workflow contract OK')
    return bool(errors)


if __name__ == '__main__':
    sys.exit(main())

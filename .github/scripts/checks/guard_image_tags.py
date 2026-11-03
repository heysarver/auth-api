#!/usr/bin/env python3
"""Read-only Harbor preflight for both FeedValue target repositories.

Only an authenticated artifact 404 means new.  Never log credentials, response
bodies, or Authorization headers.  Global workflow concurrency serializes
this publisher.  Neither FeedValue project currently has an immutable-tag
rule, so this guard is the enforcement for writers inside this workflow.
"""
import base64
import json
import os
import urllib.error
import urllib.parse
import urllib.request

# Both FeedValue environment projects own their own auth-api repository.
# There is no shared public auth-api project and none is created here.
TARGET_REPOSITORIES = (
    ('feedvalue-staging', 'auth-api'),
    ('feedvalue-prod', 'auth-api'),
)


def main():
    username, password = os.environ['HARBOR_USERNAME'], os.environ['HARBOR_PASSWORD']
    if not username or not password:
        raise SystemExit('Missing HARBOR_USERNAME or HARBOR_PASSWORD')
    authorization = 'Basic ' + base64.b64encode(f'{username}:{password}'.encode()).decode()

    def get(path, allow_missing=False):
        request = urllib.request.Request('https://registry.sarvent.cloud/api/v2.0/' + path,
                                         headers={'Authorization': authorization})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code == 404 and allow_missing:
                return None
            raise SystemExit(f'Harbor preflight refused: HTTP {error.code}; check project and robot permissions') from None
        except (urllib.error.URLError, ValueError):
            raise SystemExit('Harbor preflight unavailable or invalid response; refusing publish') from None

    # Every target project and repository must be readable before any tag check.
    for project, repository in TARGET_REPOSITORIES:
        document = get(f'projects/{project}')
        if not isinstance(document, dict):
            raise SystemExit(f'Harbor project {project} is missing or unreadable')
        target = get(f'projects/{project}/repositories/{repository}')
        if not isinstance(target, dict):
            raise SystemExit(f'Harbor repository {project}/{repository} is missing or unreadable')

    version, sha = os.environ['VERSION'], os.environ['REVISION']
    for project, repository in TARGET_REPOSITORIES:
        for tag in (version, sha, f'{version}-{sha}'):
            path = f'projects/{project}/repositories/{repository}/artifacts/' + urllib.parse.quote(tag, safe='')
            artifact = get(path, True)
            if artifact is not None:
                raise SystemExit(f'Refusing overwrite: {project}/{repository} already has tag {tag}')
    print('All three tags are new in both FeedValue repositories; authenticated Harbor preflight passed')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Read-only Harbor preflight.  Only an authenticated artifact 404 means new.

Never log credentials, response bodies, or Authorization headers.  Global
workflow concurrency serializes this publisher; Harbor immutable-tag rules
must also protect against writers outside this workflow.
"""
import base64
import json
import os
import urllib.error
import urllib.parse
import urllib.request


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

    project = get('projects/auth-api')
    if not isinstance(project, dict) or project.get('metadata', {}).get('public') != 'true':
        raise SystemExit('Harbor project auth-api must exist and be public')
    version, sha = os.environ['VERSION'], os.environ['REVISION']
    for tag in (version, sha, f'{version}-{sha}'):
        artifact = get('projects/auth-api/repositories/auth-api/artifacts/' + urllib.parse.quote(tag, safe=''), True)
        if artifact is not None:
            raise SystemExit(f'Refusing overwrite: image tag {tag} already exists')
    print('All three tags are new; authenticated Harbor preflight passed')


if __name__ == '__main__':
    main()

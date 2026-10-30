# Image release and consumer security contract

This repository is public and independent of its consumers.  Do not move it
into FeedValue or make it private.

## Publisher setup

Use the public Harbor project `auth-api`, repository `auth-api`, at
`registry.sarvent.cloud/auth-api/auth-api`.  A shared service must not publish
its canonical image into a consumer's staging or production project.

A Harbor administrator must verify or create the public project and an
immutable-tag rule covering every tag of repository `auth-api`.  Create a
project-scoped robot with artifact pull/push and the read access needed for
project metadata and artifact lookup.  Do not give delete or admin access.
Set GitHub repository secrets `HARBOR_USERNAME` and `HARBOR_PASSWORD` to this
robot's credentials.  Missing credentials fail the job, never skip a push.
Never store credentials in this public repository.

The authenticated preflight fails if any of the three tags exists.  It treats
only HTTP 404 on artifact lookup as absent; auth, network, project and other
errors fail closed.  A single concurrency group serializes this workflow.
Server-side immutability is also required to prevent a race with external
writers.  That Harbor policy has not been verified by this draft PR.

## Cut a release

Only trusted maintainers with repository write access may create release tags
or dispatch publishing.  Configure a GitHub tag ruleset for `v*` restricting
creation to release maintainers and denying updates/deletion.  Repository
write access alone does not prove that this ruleset exists.

After this workflow is reviewed and merged, tag the reviewed commit with a new
`vMAJOR.MINOR.PATCH`, then push only that tag.  A tag push starts publishing.
Alternatively dispatch the workflow on that existing tag; the optional version
input must match the selected tag.  Branch dispatches cannot publish.  There
are no pull-request or branch-push triggers.  Never move a published tag.

CI uses `npm ci` and `package-lock.json`, matching both existing Dockerfile
stages and FeedValue's auth-api CI.  `pnpm-lock.yaml` is not used or changed.
Node comes from Volta or engines when present; the current package has neither,
so CI extracts Node 24 from the Dockerfile ARG instead of inventing a field.
Lint and tests must pass before the existing Dockerfile builds and pushes.

Published tags are the exact release tag (including `v`), the full 40-character
Git SHA, and `<release-tag>-<full-sha>`.  There is no `latest` alias.  Reusing a
commit for another version fails because its SHA tag already exists.  Reruns
also fail if any tag was already pushed, including after a partial failure;
maintainers must investigate instead of deleting or overwriting tags.
OCI title/version/revision/source/created labels and BuildKit max provenance
accompany the image.  Provenance is not a separate signing-key policy.

## Consumer contract

Promote the same image digest across environments.  Consumers must pin
`registry.sarvent.cloud/auth-api/auth-api@sha256:<published-digest>` from the
workflow summary, not resolve a floating tag at deployment time.  Record the
release version for audit.  Do not assume a digest before publishing.

FeedValue currently renders `registry/repository:tag`.  Its Helm template needs
a digest-aware path (`registry/repository@digest`, with tag fallback for other
images).  Then set `auth-api.image.repository: auth-api/auth-api`, registry to
`registry.sarvent.cloud`, and `auth-api.image.digest` to the published digest
in both staging and production values.  Remove or stop using the auth-api
image tag there.  Adding a digest value alone does not change the current
rendered image.  Do not change auth-api-migrations, which this pipeline does
not build.  Retire FeedValue's auth-api image build/tag rewrite only in a
separate reviewed consumer change.  Submodule bumps may still serve source or
migration needs; standalone publishing does not remove those needs by itself.

Report suspected vulnerabilities privately to the repository owner through
GitHub's private vulnerability reporting if enabled; otherwise contact the
owner privately.  Do not post secrets in public issues.

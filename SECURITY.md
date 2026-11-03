# Image release and consumer security contract

This repository is public and independent of its consumers.  Do not move it
into FeedValue or make it private.

## Publisher setup

The auth-api image belongs to the FeedValue Harbor projects, like every other
FeedValue service.  There is no shared public `auth-api` project and none is
created.  The two target repositories are:

- `registry.sarvent.cloud/feedvalue-staging/auth-api`
- `registry.sarvent.cloud/feedvalue-prod/auth-api`

Both Harbor projects already exist and both already own an `auth-api`
repository.  They are private projects.  Publish into them with the existing
`HARBOR_USERNAME` and `HARBOR_PASSWORD` repository secrets.  The robot needs
artifact push and read access to project metadata and artifacts in both
projects.  No delete or admin access.  No new project and no new robot
request are required.  Missing credentials fail the job, never skip a push.
Never store credentials in this public repository.

Harbor project-wide immutable-tag rules are not configured in either FeedValue
project, and this workflow does not change Harbor settings.  Enforcement rests
on the workflow's own authenticated preflight, which checks both target
repositories for all three tags and fails closed if either project already has
any of them.  Harbor-side immutability remains recommended but is not claimed
as present.

## How the two projects are used

Both projects receive the same immutable tags from one release tag.  The
production project is not gated behind an extra manual confirmation.  The
reason is simple: promotion from staging to production must be a values
change, not a rebuild.  One build produces one digest, and that digest is
present in both projects from the moment of publication.  If production were
gated, the same digest would not be available in the production project at
promotion time, which would force either a second build or a copy operation
that is not an immutable tag push.

The consequence is accepted and intentional: a release tag publishes to
production as well as staging.  Promotion is controlled on the consumer side
by which values file references which project.  The published tags are the
exact release tag (including `v`), the full 40-character Git SHA, and
`<release-tag>-<full-sha>`.  There is no `latest` alias.

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
Git SHA, and `<release-tag>-<full-sha>`, in both target repositories.  Reusing a
commit for another version fails because its SHA tag already exists.  Reruns
also fail if any tag was already pushed in either project, including after a
partial failure; maintainers must investigate instead of deleting or
overwriting tags.  OCI title/version/revision/source/created labels and BuildKit
max provenance accompany the image.  Provenance is not a separate signing-key
policy.

## Consumer contract

FeedValue values select the repository by environment:

- staging: `feedvalue-staging/auth-api`
- production: `feedvalue-prod/auth-api`

The tag is the release version or the commit SHA.  The parent Helm template
currently renders `registry/repository:tag` only, so the consumer change is
the repository value per environment plus the published tag.  A digest-aware
path (`registry/repository@digest`) is a separate follow-up and is not part of
this pipeline.  Do not assume a digest before publishing.

Promote the same image across environments.  When the consumer moves to digest
pinning, use `registry.sarvent.cloud/feedvalue-staging/auth-api@sha256:<digest>`
and `registry.sarvent.cloud/feedvalue-prod/auth-api@sha256:<digest>` from the
workflow summary, not a floating tag resolved at deployment time.  Record the
release version for audit.

Do not change auth-api-migrations, which this pipeline does not build.  Retire
FeedValue's auth-api image build and tag rewrite only in a separate reviewed
consumer change.  Submodule bumps may still serve source or migration needs;
standalone publishing does not remove those needs by itself.

Report suspected vulnerabilities privately to the repository owner through
GitHub's private vulnerability reporting if enabled; otherwise contact the
owner privately.  Do not post secrets in public issues.

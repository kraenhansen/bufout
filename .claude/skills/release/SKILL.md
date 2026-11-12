---
name: release
description: Cut a new release of bufout - get the pending changesets into the "Version Packages" pull request, get it merged, and follow the publish workflow through to the staged version on npm. Use this whenever the user wants to release, cut a release, ship a version, bump the version, or get changes out on npm, including phrasings like "let's do a patch release", "ship 0.4.0", "time to publish this", or "can you release what's on main". Also use it when a release seems stuck or never showed up on npm, since the last step is a manual approval that is easy to forget.
---

# Releasing bufout

[RELEASING.md](../../../RELEASING.md) documents this same flow for humans. If the two ever disagree, the
repo is the source of truth - read `.github/workflows/publish.yml` and fix whichever is stale.

## How a release reaches npm

`.github/workflows/publish.yml` runs on every push to `main` and does one of three things:

1. **Changesets are pending** in `.changeset/`: it opens or updates the "Version Packages" pull request, which holds the `package.json` bump, the new `CHANGELOG.md` section, and the consumed changesets removed.
2. **None are pending and the `package.json` version has no `v` tag** - the state merging that pull request leaves behind: it creates the GitHub release and tag for the merged commit, authenticates to npm over OIDC (no token anywhere) and runs `npm stage publish`, which uploads the tarball to npm's stage queue. **It is not installable yet.** A maintainer promotes it by approving with 2FA.
3. **Otherwise** it does nothing.

So cutting a release means getting the "Version Packages" pull request right and merged. Never bump the version, tag, create a GitHub release, or run `changeset publish` by hand - the workflow owns all of it, and a hand-made tag makes it skip the version.

The approval at the end is deliberately out of reach: npm refuses OIDC tokens for stage approval precisely so a human sees the release before the world does. Never try to work around it - your job ends by handing the maintainer the exact commands.

## Before touching anything

Confirm the release with the user before merging anything. Publishing is outward-facing and awkward to undo - npm allows unpublishing a version for only 72 hours, and that version number is burned forever afterwards.

Use the available GitHub tools for pull requests and workflow runs. Where there are none, `gh` does the same (it is not installed in Claude Code web and remote sessions, but `GH_TOKEN` is already in the environment, so it authenticates itself once installed).

## Cutting the release

Find the open "Version Packages" pull request (head branch `changeset-release/main`). If there is none, check `main`:

- No changesets in `.changeset/`: there is nothing to release until one is written. Look at what landed since the last tag (`git log --oneline v0.3.2..origin/main`, substituting the latest tag) and propose a changeset to the user, through a pull request like every other change (`npx changeset add --patch bufout -m "..."` skips the prompts).
- Changesets exist but no pull request: the workflow failed. Look at its latest run on `main` - see "When it goes wrong".

Then review the pull request with the user rather than merging blind:

- The bump level is the highest among the changesets. Compare it and the changelog section against what actually landed since the last tag. Breaking API changes are a major, new exported behaviour is a minor, everything else is a patch - bufout is a library, so its consumers read the version number as a promise. If something consumers will notice landed without a changeset, or a changeset undersells a change, land a fixing changeset on `main` first; the pull request updates itself.
- Checks do not start on this pull request by themselves, because a workflow opened it. The changes are mechanical and the publish job reruns lint, build, and tests before staging, but if the merge is blocked on a required check, ask the user to close and reopen the pull request, which starts them.

Merge it once the user agrees. This repo allows **squash merges only**.

## Confirming and handing off

The merge triggers the publish workflow on `main`. Watch that run, since a failure here is silent otherwise:

```sh
gh run list --workflow publish.yml --branch main --limit 1
gh run watch <run-id>
```

When it succeeds, tell the user the version is staged but not yet installable, and give them the commands to promote it. They need to run these themselves - approval prompts for 2FA:

```sh
npm stage list bufout
npm stage download <stage-id>  # optional: inspect the exact tarball that was staged
npm stage approve <stage-id>   # or: npm stage reject <stage-id>
```

The stage queue is also on the package page at npmjs.com if they'd rather click. Provenance is attached either way - staged and direct publishes are identical in that respect.

## When it goes wrong

**The version job fails with "GitHub Actions is not permitted to create or approve pull requests".** Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests" is off. This is repo configuration, so tell the user rather than trying to route around it.

**The publish job never starts, or GitHub reports the branch is not allowed to deploy.** The job runs in the `main` environment (required, because npm's trusted publisher is scoped to it), and it runs from `refs/heads/main`. If that environment's deployment rules do not allow the `main` branch, it is blocked. Fix it in Settings → Environments → main → Deployment branches and tags by adding a `main` **branch** rule. Again repo configuration - tell the user.

**The publish job failed after creating the GitHub release.** The tag now exists, so later pushes to `main` skip this version. Re-run the failed job of that same run once the cause is fixed - it skips the release step and stages. Do not delete the tag to force a retry from a new push unless the fix itself has to land on `main`; in that case delete the release and tag, and the push carrying the fix publishes.

**"X@Y.Z is already published - it is missing its vY.Z tag".** That version exists on npm but was never tagged, so the workflow keeps trying. Create the missing release for the commit that was published, with the user's go-ahead.

**The workflow succeeded but npm still doesn't have it.** Expected - it is sitting in the stage queue waiting for the 2FA approval above. Check with `npm stage list bufout`.

**Something needs to go out urgently.** There is no bypass - merging the version pull request is the only path, and it always stages. That is not an obstacle worth engineering around: approving from the stage queue takes seconds once the maintainer is at a terminal, so the fast path is to get them the `npm stage approve` command, not to look for another way onto the registry.

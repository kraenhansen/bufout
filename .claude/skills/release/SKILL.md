---
name: release
description: Cut a new release of bufout - bump the version, get the commit onto main, and create the GitHub release that tags it and triggers the publish workflow. Use this whenever the user wants to release, cut a release, ship a version, bump the version, or get changes out on npm, including phrasings like "let's do a patch release", "ship 0.4.0", "time to publish this", or "can you release what's on main". Also use it when a release seems stuck or never showed up on npm, since the last step is a manual approval that is easy to forget.
---

# Releasing bufout

[RELEASING.md](../../../RELEASING.md) documents this same flow for humans. If the two ever disagree, the
repo is the source of truth - read `.github/workflows/publish.yml` and fix whichever is stale.

## How a release reaches npm

Four things have to happen, and only the first three are yours:

1. `npm version` bumps `package.json`, commits, and tags.
2. That commit reaches `main` through a pull request, like every other change.
3. A **published** GitHub release, created against that commit, tags it and triggers `.github/workflows/publish.yml`.
4. The workflow authenticates to npm over OIDC (no token anywhere) and runs `npm stage publish`, which uploads the tarball to npm's stage queue. **It is not installable yet.** A maintainer promotes it by approving with 2FA.

Step 4's approval is deliberately out of reach: npm refuses OIDC tokens for stage approval precisely so a human sees the release before the world does. Never try to work around it - your job ends by handing the maintainer the exact commands.

## Before touching anything

Confirm the release with the user before opening or creating anything. Publishing a release is outward-facing and awkward to undo - npm allows unpublishing a version for only 72 hours, and that version number is burned forever afterwards.

Check that:

- You are on `main` with a clean tree and in sync with `origin/main`. `npm version` refuses to run on a dirty tree, which is a feature - do not stash around it.
- CI is green on the commit you are about to release (`gh run list --branch main --limit 3`). The publish workflow reruns lint, build, and tests anyway, so a broken commit just fails later and more expensively.

The steps below go through `gh`, which is not installed in Claude Code web and remote sessions. Install it up front - `GH_TOKEN` is already in the environment, so it authenticates itself - rather than hand-rolling the equivalent REST calls with `curl` further down. Search the available GitHub tools for one that creates a release first, though - `gh` is the fallback for when there isn't one, not the preference.

## Cutting the release

Look at what has landed since the last tag and propose the bump level to the user rather than guessing:

```sh
git log --oneline v0.3.2..main   # substitute the actual latest tag
```

Breaking API changes are a major, new exported behaviour is a minor, everything else is a patch. bufout is a library, so its consumers read the version number as a promise.

```sh
npm version patch                       # or minor / major
```

`npm version` writes the commit message as the bare version (`0.3.3`) and creates an annotated tag (`v0.3.3`). That matches this repo's existing history, so don't hand-roll the commit or add a prefix.

### Getting the version commit onto `main`

The release has to point at a commit that is on `main`, and the version bump gets there the same way every other change does - through a pull request:

1. Push the version commit to a branch and open a PR against `main`. Keep the version commit last on the branch, so the thing being released is the branch tip.
2. Ask the user to merge it, **with a merge commit rather than a squash**. A squash rewrites the version commit into a new one, which costs you the SHA you were about to release and the tie between the tag and `npm version`'s commit.
3. `git fetch origin main` and read back the SHA of the version commit on `origin/main`. That SHA is what the release targets.

The local annotated tag from `npm version` is a by-product, not the artifact - it never has to reach `origin`, and the next step is what actually creates the tag there.

### Publishing the release

Publishing the release is what triggers the workflow, and it is also what creates the tag. Both `gh release create` and `POST /repos/{owner}/{repo}/releases` create `tag_name` themselves when it does not exist on the remote, pointing it at the target commit - so there is never a tag to push by hand.

```sh
gh release create v0.3.3 --target <sha> --generate-notes --notes-start-tag v0.3.2
```

- Pass `--target` as the **exact SHA** of the version commit, never a branch name. A branch name resolves at creation time, so a push racing you would tag the wrong commit. Pinning the SHA is what guards against tagging something unintended; `--verify-tag` cannot help here, since it requires the tag to already exist and creating it is this step's job.
- `--generate-notes` with no start tag reaches back to the beginning of history. Narrow it with `--notes-start-tag` set to the previous release's tag.
- **Do not use `--draft`.** Drafts fire no event, so nothing publishes until the draft is published.
- **Do not mark it as a pre-release**, and don't bump to a pre-release version. This package publishes only to the `latest` dist-tag, so a `0.4.0-rc.0` would become the version every consumer installs. The workflow refuses both rather than letting that happen quietly.

If creating the release is denied, stop and hand the user that exact `gh release create` line - do not go looking for another way to reach the registry.

## Confirming and handing off

Watch the run, since a failure here is silent otherwise:

```sh
gh run list --workflow publish.yml --limit 1
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

**The job never starts, or GitHub reports the tag is not allowed to deploy.** The job runs in the `main` environment (required, because npm's trusted publisher is scoped to it), and a release runs from `refs/tags/v*`. If that environment's deployment rules only allow branches, tags are blocked - a branch rule never matches a release run. Fix it in Settings → Environments → main → Deployment branches and tags by adding a `v*` **tag** rule. This is repo configuration, so tell the user rather than trying to route around it.

**"Release tag vX.Y.Z does not match the package version".** The tag and `package.json` drifted apart - usually a hand-made tag. Delete the release and tag, then redo the bump with `npm version`.

**"X@Y.Z is already published".** That version exists on npm, possibly from an earlier staged release someone approved. Bump again; a published version number can never be reused.

**The workflow succeeded but npm still doesn't have it.** Expected - it is sitting in the stage queue waiting for the 2FA approval above. Check with `npm stage list bufout`.

**Something needs to go out urgently.** There is no bypass - publishing a release is the only path, and it always stages. That is not an obstacle worth engineering around: approving from the stage queue takes seconds once the maintainer is at a terminal, so the fast path is to get them the `npm stage approve` command, not to look for another way onto the registry.

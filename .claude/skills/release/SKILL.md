---
name: release
description: Cut a new release of bufout - bump the version, push the tag, and create the GitHub release that triggers the publish workflow. Use this whenever the user wants to release, cut a release, ship a version, bump the version, or get changes out on npm, including phrasings like "let's do a patch release", "ship 0.4.0", "time to publish this", or "can you release what's on main". Also use it when a release seems stuck or never showed up on npm, since the last step is a manual approval that is easy to forget.
---

# Releasing bufout

## How a release reaches npm

Four things have to happen, and only the first three are yours:

1. `npm version` bumps `package.json`, commits, and tags.
2. The commit and tag are pushed to `main`.
3. A **published** GitHub release on that tag triggers `.github/workflows/publish.yml`.
4. The workflow authenticates to npm over OIDC (no token anywhere) and runs `npm stage publish`, which uploads the tarball to npm's stage queue. **It is not installable yet.** A maintainer promotes it by approving with 2FA.

Step 4's approval is deliberately out of reach: npm refuses OIDC tokens for stage approval precisely so a human sees the release before the world does. Never try to work around it - your job ends by handing the maintainer the exact commands.

## Before touching anything

Confirm the release with the user before pushing or creating anything. Pushing a version tag and publishing a release are outward-facing and awkward to undo - npm allows unpublishing a version for only 72 hours, and that version number is burned forever afterwards.

Check that:

- You are on `main` with a clean tree and in sync with `origin/main`. `npm version` refuses to run on a dirty tree, which is a feature - do not stash around it.
- CI is green on the commit you are about to release (`gh run list --branch main --limit 3`). The publish workflow reruns lint, build, and tests anyway, so a broken commit just fails later and more expensively.

## Cutting the release

Look at what has landed since the last tag and propose the bump level to the user rather than guessing:

```sh
git log --oneline v0.3.2..main   # substitute the actual latest tag
```

Breaking API changes are a major, new exported behaviour is a minor, everything else is a patch. bufout is a library, so its consumers read the version number as a promise.

```sh
npm version patch                       # or minor / major
git push origin main --follow-tags
```

`npm version` writes the commit message as the bare version (`0.3.3`) and creates an annotated tag (`v0.3.3`). That matches this repo's existing history, so don't hand-roll the commit or add a prefix. `--follow-tags` pushes the annotated tag along with the commit; without it the tag stays local and the release creation fails.

Then publish the release, which is what actually triggers the workflow:

```sh
gh release create v0.3.3 --verify-tag --generate-notes
```

- `--verify-tag` makes a typo fail loudly instead of creating a release on a brand-new tag pointing somewhere unintended.
- There are no releases in this repo yet, so the first `--generate-notes` reaches back to the beginning of history. Narrow it with `--notes-start-tag v0.3.2`.
- **Do not use `--draft`.** Drafts fire no event, so nothing publishes until the draft is published.
- For a pre-release, bump with `npm version prerelease --preid=rc` and add `--prerelease` to the release. The workflow reads that flag and publishes under the `next` dist-tag so `latest` doesn't move.

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

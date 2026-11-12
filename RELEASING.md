# Releasing

Merge the "Version Packages" pull request, then approve the staged version on npm. Ask Claude Code to
cut a release and the [`release` skill](./.claude/skills/release/SKILL.md) will drive it, up to the
approval that needs a human. What the pipeline assumes:

- [Changesets](https://github.com/changesets/changesets) decide the version. Pull requests add a file
  to `.changeset/` (`npm run changeset`) describing what consumers will notice.
- The [Publish workflow](./.github/workflows/publish.yml) runs on every push to `main` and is the only
  way a version reaches npm. There is no manual workflow dispatch, and creating a GitHub release by hand
  publishes nothing.
- While changesets are pending, the workflow keeps a "Version Packages" pull request up to date. It
  holds what `npm run version-packages` produces: the `package.json` bump, the `CHANGELOG.md` entry
  and the consumed changesets removed.
- Merging that pull request is the release. It leaves `main` with no changesets and a `package.json`
  version that has no `v`-prefixed tag, which is what makes the workflow publish.
- The workflow creates the GitHub release and its tag, targeting the merged commit, with the new
  changelog section as its notes - no tag is pushed by hand. Changesets is not involved in tagging or
  publishing: `changeset publish` is never run.
- Every release goes to the `latest` dist-tag, so pre-release versions are rejected rather than
  becoming the version everybody installs.
- The workflow authenticates with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
  (OIDC). No npm token is stored in the repository, and
  [provenance](https://docs.npmjs.com/generating-provenance-statements/) comes with it.
- It [stages](https://docs.npmjs.com/cli/v11/commands/npm-stage/) rather than publishes: the version sits
  in npm's queue, uninstallable, until a maintainer runs `npm stage approve` (or clicks approve on
  npmjs.com) and passes a 2FA challenge. OIDC tokens cannot approve, which is what makes this a human
  gate. Approving from a checkout needs npm >= 11.15.0.
- The npm trusted publisher is scoped to the `publish.yml` workflow and the `main` environment, so the
  job runs in that environment and both names have to stay in sync with it. The workflow runs from
  `main`, so the environment needs a `main` **branch** rule under "Deployment branches and tags".
- Opening the pull request needs "Allow GitHub Actions to create and approve pull requests" enabled
  under Settings → Actions → General.
- Pull requests opened by a workflow do not trigger other workflows, so
  [Check](./.github/workflows/check.yml) does not run on the "Version Packages" pull request on its
  own. Closing and reopening it starts the checks.

# Releasing

Ask Claude Code to cut a release and the [`release` skill](./.claude/skills/release/SKILL.md) will drive
it, up to the approval that needs a human. What the pipeline assumes:

- Publishing a **published GitHub release** is the only way a version reaches npm. Drafts trigger
  nothing, and there is no manual workflow dispatch.
- The release tag is the `package.json` version prefixed with `v`. The
  [Publish workflow](./.github/workflows/publish.yml) fails the release if they disagree.
- Every release goes to the `latest` dist-tag, so pre-releases are rejected rather than becoming the
  version everybody installs.
- The workflow authenticates with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
  (OIDC). No npm token is stored in the repository, and
  [provenance](https://docs.npmjs.com/generating-provenance-statements/) comes with it.
- It [stages](https://docs.npmjs.com/cli/v11/commands/npm-stage/) rather than publishes: the version sits
  in npm's queue, uninstallable, until a maintainer runs `npm stage approve` (or clicks approve on
  npmjs.com) and passes a 2FA challenge. OIDC tokens cannot approve, which is what makes this a human
  gate. Approving from a checkout needs npm >= 11.15.0.
- The npm trusted publisher is scoped to the `publish.yml` workflow and the `main` environment, so the
  job runs in that environment and both names have to stay in sync with it. Releases run from a tag, so
  the environment needs a `v*` **tag** rule under "Deployment branches and tags" — a branch rule never
  matches a release run.

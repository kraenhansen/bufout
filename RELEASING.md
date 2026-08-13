# Releasing

Releases are published by the [Publish workflow](./.github/workflows/publish.yml), which authenticates
through [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC), so no npm token is
stored in the repository. Publishing this way also gets the package
[provenance attestations](https://docs.npmjs.com/generating-provenance-statements/) for free.

## Cutting a release

From an up-to-date `main` with a clean working tree:

```sh
npm version patch                 # or minor / major
git push origin main --follow-tags
gh release create v0.3.3 --verify-tag --generate-notes
```

`npm version` bumps `package.json`, commits, and creates the annotated `v0.3.3` tag; `--follow-tags`
pushes that tag along with the commit. Publishing the release is what triggers the workflow, so a
`--draft` release publishes nothing until the draft itself is published.

The tag has to be the package version prefixed with `v`, or the workflow fails the release. Every
release goes to the `latest` dist-tag, so the workflow rejects pre-releases rather than letting one
become the version everybody installs.

## Approving the staged release

The workflow [stages](https://docs.npmjs.com/cli/v11/commands/npm-stage/) the tarball: it is uploaded to
npm but not installable yet. Promote it by approving it with 2FA, either from the package page on
npmjs.com or from a local checkout:

```sh
npm stage list bufout
npm stage download <stage-id> # optional: inspect the exact tarball that was staged
npm stage approve <stage-id>  # or: npm stage reject <stage-id>
```

OIDC tokens deliberately cannot approve staged releases, which is what makes this a human gate. Doing it
locally needs npm >= 11.15.0 (trusted publishing alone needs >= 11.5.1) — recent Node 24 releases bundle
a new enough npm.

Publishing a release is the only way to publish: there is no manual workflow dispatch, so every version
that reaches npm has a release to go with it.

## Configuration

The trusted publisher on npm is configured for the `main` environment, so the workflow job runs in the
GitHub `main` environment and must keep both its name and the `publish.yml` filename in sync with that
configuration. Because releases run from a tag rather than a branch, that environment needs a `v*` **tag**
rule under "Deployment branches and tags" — a branch rule never matches a release run, and GitHub blocks
the job before it starts.

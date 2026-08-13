# bufout

Spawn child processes with prefixed buffered output.

## Features

- Output modes:
  - `"inherit"` (default) pipe through the child process's stdout and stderr to the host process.
  - `"buffered"` buffers of stdout and stderr in a common buffer to preserve ordering between the two and the buffer is flushable upon failure.
- Output prefix: Adds a prefix to every line the child writes to stdout or stderr.
- Returns a `Promise` allowing the child process to be awaited.
- Forwards exits and SIGINT (interrupts triggered by Ctrl + C in terminals) to the child process.
- No dependencies, except for Node.js APIs.

## Usage

```
npm install --save bufout
```

```typescript
import { spawn, SpawnFailure } from "bufout";

await spawn(
  // Provide the command
  "some-command",
  // Arguments for the command is passed through an array
  ["--fail"],
  // Additional options
  {
    // Adds a prefix to any line printed to stdout or stderr
    outputPrefix: "[child] ",
    
    // Buffers the stdout and stderr of the process
    // Alternatively, "inherit" can be passed to bypass buffering and write directly to stdout and stderr
    // while still applying any prefix.
    outputMode: "buffered",

	  // Optionally pass the stdout and stderr streams used when flushing the buffer
    // stdout: process.stdout,
    // stderr: process.stderr,

    // Forwards extra options to the underlying call to node:child_process's spawn
    // shell: true,
    // timeout: 1000,
  },
).catch((error) => {
  // A special error is thrown upon failures
  if (error instanceof SpawnFailure) {
    // Yields: Running 'some-command' failed (code = 1)
    console.error(error.message);
    // Flush the buffered output, preserving order across the streams,
    // to correctly interleave information with errors as they were emitted by the child process.
    // Takes an optional argument of the stream to flush (default is "both" stdout and stderr).
    error.flushOutput("stderr");
  } else {
    throw error;
  }
});

// To manually kill the child process, call `kill` on the object returned from `spawn`:
const sleeper = spawn("sleep", ["10"]);
// If you get impatient
sleeper.kill();
```

## Releasing

Releases are published by the [Publish workflow](./.github/workflows/publish.yml), which authenticates
through [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC), so no npm token is
stored in the repository. Publishing this way also gets the package
[provenance attestations](https://docs.npmjs.com/generating-provenance-statements/) for free.

1. Bump `version` in `package.json` on `main`.
2. Create a GitHub release for the new version, from the web UI or the CLI:

   ```sh
   gh release create v0.3.3 --generate-notes
   ```

   The tag has to be the package version prefixed with `v`, or the workflow fails the release.
   Marking it as a pre-release publishes it under the `next` dist-tag instead of `latest`.
3. Publishing the release runs the workflow, which
   [stages](https://docs.npmjs.com/cli/v11/commands/npm-stage/) the tarball: it is uploaded to npm but
   not installable yet. Promote it by approving it with 2FA — either from the package page on npmjs.com
   or from a local checkout:

   ```sh
   npm stage list bufout
   npm stage download <stage-id> # optional: inspect the exact tarball that was staged
   npm stage approve <stage-id>  # or: npm stage reject <stage-id>
   ```

   OIDC tokens deliberately cannot approve staged releases, which is what makes this a human gate.

The workflow can also be dispatched manually, which is the way to publish straight past the stage queue
(`mode: publish`) or to use a different dist-tag.

The trusted publisher on npm is configured for the `main` environment, so the workflow job runs in the
GitHub `main` environment and must keep both its name and the `publish.yml` filename in sync with that
configuration. Because releases run from a tag, the environment's deployment branch rules need to allow
the `v*` tag (or all branches and tags), otherwise GitHub blocks the job before it starts. Approving a staged release locally needs npm >= 11.15.0 (trusted publishing alone needs
>= 11.5.1) — recent Node 24 releases bundle a new enough npm.

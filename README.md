# bufout

Spawn child processes with prefixed buffered output.

## Features

- Output modes:
  - `"inherit"` (default) pipe through the child process's stdout and stderr to the host process.
  - `"buffered"` buffers of stdout and stderr in a common buffer to preserve ordering between the two and the buffer is flushable upon failure.
- Bounded buffering: Optionally keep only the most recent lines (or bytes) of buffered output, for long-lived processes.
- Output prefix: Adds a prefix to every line the child writes to stdout or stderr.
- Input: Pipe a stream into the child's stdin, write to it directly or attach and detach sources while it runs.
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

    // Optionally bound the buffer to the most recent lines and / or bytes of output (across stdout and stderr),
    // evicting the oldest lines (default is unbounded).
    // maxBufferedLines: 1000,
    // maxBufferedBytes: 1024 * 1024,

    // Optionally pass input for the child's stdin: "pipe" (default) leaves it open with nothing attached,
    // "close" ends it right away (for children reading until EOF) or pass a Readable to pipe into it.
    // stdin: process.stdin,

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

### Input

The child's stdin is controlled by the `stdin` option:

- `"pipe"` (default): stdin is left open, with nothing attached. Children reading stdin until EOF will wait until it's
  written to and ended (see below). This is the behaviour of earlier versions.
- `"close"`: stdin is ended right away, signalling EOF to the child. Use this for children which read stdin until EOF,
  but have nothing to read.
- A `Readable` (such as `process.stdin`): piped into the child's stdin. If the source ends, so does the child's stdin.

The promise returned from `spawn` also exposes the child's stdin, to write to it directly and to attach and detach
sources while it runs (to route input to one of multiple children, for example):

```typescript
const server = spawn("some-dev-server", []);
const watcher = spawn("some-watcher", []);

// Write directly to the child (and signal EOF with `end`)
server.stdin.write("rs\n");

// Route the terminal's input to the server, then to the watcher
server.attachStdin(process.stdin);
server.detachStdin();
watcher.attachStdin(process.stdin);
```

- Attaching a source detaches any source previously attached to that child.
- Detaching never ends the source or the child's stdin. Data written to a detached source is left in the source
  (a paused stream buffers it) and is read by the next child it's attached to.
- A source is detached automatically when the child exits, and a source like `process.stdin` is paused again once
  no children are attached, so it doesn't keep the process alive.
- A single source can be attached to many children at once without adding listeners to it per child, and writes
  respect backpressure from the slowest child.
- Errors writing to the child's stdin (such as `EPIPE` after the child exits) are ignored, as the child's failure is
  reported through its exit.

### Bounded buffering

By default, the `"buffered"` output-mode keeps all output until the child exits, which grows without bound for
long-lived processes (such as dev servers and watchers). Pass `maxBufferedLines` and / or `maxBufferedBytes` to keep
only the most recent output:

- Output is counted in lines (split on `"\n"`), not chunks: a chunk containing many lines counts as many lines and a
  line split across chunks counts as one. A line which hasn't been terminated yet counts as a line too.
- Lines are flushed in the order they started across stdout and stderr: the remainder of a partial line is
  joined with its beginning, even if the other stream wrote in between.
- When `maxBufferedBytes` is exceeded, the oldest lines are evicted. A single line exceeding the bound
  keeps only its most recent bytes.

### `LineRingBuffer`

The ring buffer used for bounded buffering is exported as well, for keeping the "last N lines" of any output:

```typescript
import { LineRingBuffer } from "bufout";

// The type parameter is the type of the (optional) source, used to tell multiple streams apart
const ring = new LineRingBuffer<"stdout" | "stderr">({
  maxLines: 10,
  maxBytes: 64 * 1024,
});

child.stdout.on("data", (chunk) => ring.write(chunk, "stdout"));
child.stderr.on("data", (chunk) => ring.write(chunk, "stderr"));

// The most recent lines (decoded and without line endings), in order across the sources
ring.lines(); // => ["compiling ...", "error: ...", ...]
// ... or only those from a single source
ring.lines("stderr");
// Iterate the raw bytes of each line, along with its source and whether it's complete (ends with a newline)
for (const { source, data, complete } of ring.entries()) {
  // ...
}
ring.lineCount; // Lines currently in the buffer
ring.byteLength; // Bytes currently in the buffer
ring.evictedLines; // Lines evicted since creation (or the last call to `clear`)
ring.clear();
```

Appending is O(1) amortised: chunks are split once as they're written and the buffer is never re-split or copied as a
whole. Lines are split on the newline byte without decoding, so multi-byte UTF-8 characters split across chunks stay
intact.

## Releasing

New versions are published to npm from a GitHub release, using trusted publishing (OIDC) with
provenance. See [RELEASING.md](./RELEASING.md).

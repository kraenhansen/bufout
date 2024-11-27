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

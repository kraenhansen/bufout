import assert from "node:assert/strict";
import cp, { ChildProcess } from "node:child_process";

import { connectInput, disconnectInput } from "./input.ts";
import { createMultiBufferedTransform } from "./MultiBufferedTransform.ts";
import { createPrefixingTransform } from "./PrefixingTransform.ts";
import { PassThrough, Readable, Writable } from "node:stream";

export type KillablePromise<T> = Promise<T> & {
  /**
   * Kills the child process.
   */
  kill: ChildProcess["kill"];
};

export type SpawnedChild<T> = KillablePromise<T> & {
  /**
   * The child's stdin, for writing to the child directly.
   * Call `end()` to signal EOF to the child.
   * Errors (such as writing after the child exited) are ignored.
   */
  stdin: Writable;
  /**
   * Pipe a source into the child's stdin, detaching any previously attached source.
   * If the source ends, so does the child's stdin.
   * The source is detached automatically when the child exits.
   */
  attachStdin(source: Readable): void;
  /**
   * Stop piping the attached source (if any) into the child's stdin.
   * Neither the source nor the child's stdin are ended.
   */
  detachStdin(): void;
};

export class SpawnFailure extends Error {
  readonly command: string;
  readonly args: string[];
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly #flush: (stream?: "stdout" | "stderr" | "both") => void;

  constructor(
    command: string,
    args: string[],
    code: number | null,
    signal: NodeJS.Signals | null,
    flush: (stream?: "stdout" | "stderr" | "both") => void,
  ) {
    super(
      `Running '${command}' failed` +
        (code !== null ? ` (code = ${code})` : "") +
        (signal !== null ? ` (signal = ${signal})` : ""),
    );
    this.command = command;
    this.args = args;
    this.code = code;
    this.signal = signal;
    this.#flush = flush;
  }

  /**
   * Flush the buffered output, preserving order across the streams,
   * correctly interleave information with errors emitted by the child process.
   * @param [stream="both"] Optionally, flush chunks from only one stream (dropping others)
   */
  flushOutput(stream: "stdout" | "stderr" | "both" = "both") {
    this.#flush(stream);
  }
}

export type OutputMode = "inherit" | "buffered";

export type SpawnOptions = {
  /**
   * Is the output buffers inherited, printing from the process right away
   * or are they buffered (initially detached from the UI) but flushable on failures.
   */
  outputMode?: OutputMode;
  /**
   * Add a prefix to all lines written to the output streams.
   */
  outputPrefix?: string;
  /**
   * In the "buffered" output-mode, keep only the most recent lines of output (across stdout and stderr),
   * evicting the oldest. Useful to bound the memory used by long-lived processes.
   * @default Infinity (unbounded)
   */
  maxBufferedLines?: number;
  /**
   * In the "buffered" output-mode, keep only the most recent bytes of output (across stdout and stderr),
   * evicting the oldest lines.
   * @default Infinity (unbounded)
   */
  maxBufferedBytes?: number;
  /**
   * Input for the child's stdin:
   * - `"pipe"` (default): stdin is left open with nothing attached.
   *   Write to it through `stdin` or attach a source through `attachStdin` on the returned promise.
   * - `"close"`: stdin is ended right away, signalling EOF to children reading it.
   * - A `Readable` (such as `process.stdin`), piped into the child's stdin.
   *   If it ends, so does the child's stdin. Equivalent to calling `attachStdin` right away.
   */
  stdin?: "pipe" | "close" | Readable;
  /**
   * Use this when flushing output to stdout.
   */
  stdout?: Writable | typeof process.stdout;
  /**
   * Use this when flushing output to stderr.
   */
  stderr?: Writable | typeof process.stderr;
} & cp.CommonSpawnOptions;

/**
 * Children which are currently running, tracked in a set per process event:
 * a single shared listener is attached exactly while its set is non-empty,
 * keeping the number of listeners on the process constant,
 * regardless of the number of concurrently spawned children.
 */
const childrenToKill = new Set<ChildProcess>();
const childrenToInterrupt = new Set<ChildProcess>();

/**
 * Kill all running children, called as the process exits.
 */
function killChildren() {
  for (const child of childrenToKill) {
    child.kill();
  }
  childrenToKill.clear();
}

/**
 * Interrupt all running children, called as the process gets interrupted.
 * Clears the set as the "once" listener just detached itself:
 * children spawned afterwards attach a fresh listener.
 */
function interruptChildren() {
  for (const child of childrenToInterrupt) {
    child.kill("SIGINT");
  }
  childrenToInterrupt.clear();
}

/**
 * Register the child to be killed if the main process exits and interrupted on SIGINT.
 */
function registerChild(child: ChildProcess) {
  if (childrenToKill.size === 0) {
    process.once("exit", killChildren);
  }
  childrenToKill.add(child);
  if (childrenToInterrupt.size === 0) {
    process.once("SIGINT", interruptChildren);
  }
  childrenToInterrupt.add(child);
}

function unregisterChild(child: ChildProcess) {
  childrenToKill.delete(child);
  if (childrenToKill.size === 0) {
    process.off("exit", killChildren);
  }
  childrenToInterrupt.delete(child);
  if (childrenToInterrupt.size === 0) {
    process.off("SIGINT", interruptChildren);
  }
}

/**
 * Pass-through streams piped into destinations, shared across all spawned children:
 * Piping every child directly into a shared destination (such as process.stdout) adds
 * listeners to the destination per active child, eventually exceeding its max listeners.
 * Instead each destination gets a single persistent pass-through (with the listener
 * limit disabled) shared by every child piping into the destination.
 */
const sharedDestinations = new WeakMap<Writable, PassThrough>();

function getSharedDestination(destination: Writable) {
  const existing = sharedDestinations.get(destination);
  if (existing) {
    return existing;
  }
  const shared = new PassThrough();
  // Every active child piped into the shared pass-through adds a few listeners to it
  shared.setMaxListeners(0);
  shared.pipe(destination, { end: false });
  sharedDestinations.set(destination, shared);
  return shared;
}

/**
 * Pipe a child output stream into a destination (via its shared pass-through),
 * optionally applying a prefix. The pipes detach themselves once the source ends.
 */
function pipeOutput(
  source: Readable,
  destination: Writable,
  prefix: string | undefined,
) {
  const shared = getSharedDestination(destination);
  if (typeof prefix === "string") {
    source.pipe(createPrefixingTransform(prefix)).pipe(shared, { end: false });
  } else {
    source.pipe(shared, { end: false });
  }
}

/**
 * Write everything pushed to the source into the destination, optionally applying
 * a prefix. Used when flushing buffered output: chunks are forwarded synchronously
 * and no listeners are ever added to the destination.
 */
function forwardOutput(
  source: Readable,
  destination: Writable,
  prefix: string | undefined,
) {
  if (typeof prefix === "string") {
    const prefixing = createPrefixingTransform(prefix);
    prefixing.on("data", (chunk: Buffer) => destination.write(chunk));
    source.on("data", (chunk: Buffer) => prefixing.write(chunk));
  } else {
    source.on("data", (chunk: Buffer) => destination.write(chunk));
  }
}

/**
 * Pipe both of the child's output streams into their destinations right away.
 * Returns a no-op flush, as nothing gets buffered.
 */
function inheritOutput(
  childStdout: Readable,
  childStderr: Readable,
  stdout: Writable,
  stderr: Writable,
  prefix: string | undefined,
): (stream?: "stdout" | "stderr" | "both") => void {
  pipeOutput(childStdout, stdout, prefix);
  pipeOutput(childStderr, stderr, prefix);
  return () => {
    // Nothing to flush
  };
}

/**
 * Buffer the output instead of piping the child into the destinations.
 * Returns a flush which forwards the buffer directly into the destinations,
 * adding no listeners to them.
 */
function bufferOutput(
  childStdout: Readable,
  childStderr: Readable,
  stdout: Writable,
  stderr: Writable,
  prefix: string | undefined,
  maxLines: number,
  maxBytes: number,
): (stream?: "stdout" | "stderr" | "both") => void {
  const transform = createMultiBufferedTransform(
    [childStdout, childStderr] as const,
    { end: false, maxLines, maxBytes },
  );
  const [stdoutOutput, stderrOutput] = transform.outputs;
  return (stream = "both") => {
    forwardOutput(stdoutOutput, stdout, prefix);
    forwardOutput(stderrOutput, stderr, prefix);
    transform.flush(determineStream(stream, childStdout, childStderr));
    transform.destroy();
  };
}

function determineStream(
  stream: "stdout" | "stderr" | "both",
  stdout: Readable,
  stderr: Readable,
) {
  if (stream === "stdout") {
    return stdout;
  } else if (stream === "stderr") {
    return stderr;
  } else if (stream === "both") {
    return undefined;
  } else {
    throw new Error(`Unexpected stream '${stream as string}'`);
  }
}

/**
 * Attach and detach sources to the child's stdin, one at a time.
 */
function bindInput(childStdin: Writable) {
  // Writing to a child which exited (or closed its stdin) fails with EPIPE (or similar):
  // its failure is reported through the exit code instead.
  childStdin.on("error", () => {});
  let attached: Readable | null = null;
  const detach = () => {
    if (attached) {
      disconnectInput(attached, childStdin);
      attached = null;
    }
  };
  const attach = (source: Readable) => {
    assert(source instanceof Readable, "Expected a Readable source");
    detach();
    if (childStdin.writableEnded || childStdin.destroyed) {
      return;
    }
    attached = source;
    connectInput(source, childStdin, () => {
      if (attached === source) {
        attached = null;
        childStdin.end();
      }
    });
  };
  // The child closed its stdin (or exited)
  childStdin.once("close", detach);
  return { attach, detach };
}

/**
 * Spawn a child process, with it's buffer
 */
export function spawn(
  command: string,
  args: string[],
  {
    outputMode = "inherit",
    outputPrefix,
    stdin = "pipe",
    maxBufferedLines = Infinity,
    maxBufferedBytes = Infinity,
    stdout = process.stdout,
    stderr = process.stderr,
    ...options
  }: SpawnOptions = {},
): SpawnedChild<void> {
  if (outputMode !== "inherit" && outputMode !== "buffered") {
    throw new Error(`Unexpected output mode ${outputMode as string}`);
  }
  for (const [name, value] of Object.entries({
    maxBufferedLines,
    maxBufferedBytes,
  })) {
    if (!(value === Infinity || (Number.isInteger(value) && value > 0))) {
      throw new TypeError(
        `Expected '${name}' to be a positive integer or Infinity, got ${value}`,
      );
    }
  }
  if (stdin !== "pipe" && stdin !== "close" && !(stdin instanceof Readable)) {
    throw new TypeError(
      `Expected 'stdin' to be "pipe", "close" or a Readable, got ${String(stdin)}`,
    );
  }
  const child = cp.spawn(command, args, {
    ...options,
    stdio: "pipe",
  });
  const { stdin: childStdin, stdout: childStdout, stderr: childStderr } = child;
  assert(childStdin, "Expected child to have stdin");
  assert(childStdout, "Expected child to have stdout");
  assert(childStderr, "Expected child to have stderr");
  // Kill the child process if the main process exits or gets interrupted
  registerChild(child);

  const input = bindInput(childStdin);
  if (stdin === "close") {
    childStdin.end();
  } else if (stdin instanceof Readable) {
    input.attach(stdin);
  }

  // Bind transformed and buffered outputs to the destination streams
  const flushOutput =
    outputMode === "inherit"
      ? inheritOutput(childStdout, childStderr, stdout, stderr, outputPrefix)
      : bufferOutput(
          childStdout,
          childStderr,
          stdout,
          stderr,
          outputPrefix,
          maxBufferedLines,
          maxBufferedBytes,
        );

  const result = new Promise<void>((resolve, reject) => {
    child.once("exit", (code, signal) => {
      // The child can no longer be killed, nor react to an interrupt, nor read input
      unregisterChild(child);
      input.detach();
      if (code === 0 && signal === null) {
        resolve();
      } else {
        reject(new SpawnFailure(command, args, code, signal, flushOutput));
      }
    });
    // Propagate errors (a child failing to spawn emits "error" but never "exit")
    child.once("error", (error) => {
      unregisterChild(child);
      input.detach();
      reject(error);
    });
  }) as SpawnedChild<void>;

  // Propagate the kill method
  result.kill = child.kill.bind(child);
  result.stdin = childStdin;
  result.attachStdin = input.attach;
  result.detachStdin = input.detach;

  return result;
}

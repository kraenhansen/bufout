import assert from "node:assert/strict";
import cp, { ChildProcess } from "node:child_process";

import { createMultiBufferedTransform } from "./MultiBufferedTransform.ts";
import { createPrefixingTransform } from "./PrefixingTransform.ts";
import { PassThrough, Readable, Writable } from "node:stream";

export type KillablePromise<T> = Promise<T> & {
  /**
   * Kills the child process.
   */
  kill: ChildProcess["kill"];
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
   * Use this when flushing output to stdout.
   */
  stdout?: Writable | typeof process.stdout;
  /**
   * Use this when flushing output to stderr.
   */
  stderr?: Writable | typeof process.stderr;
} & cp.CommonSpawnOptions;

/**
 * Children which are currently running.
 * These are killed by a single shared pair of "exit" and "SIGINT" listeners,
 * keeping the number of listeners on the process constant,
 * regardless of the number of concurrently spawned children.
 */
const activeChildren = new Set<ChildProcess>();
let killListenerAttached = false;
let interruptListenerAttached = false;

function killActiveChildren() {
  killListenerAttached = false;
  for (const child of activeChildren) {
    child.kill();
  }
}

function interruptActiveChildren() {
  interruptListenerAttached = false;
  for (const child of activeChildren) {
    child.kill("SIGINT");
  }
}

/**
 * Register the child to be killed if the main process exits and interrupted on SIGINT.
 */
function registerChild(child: ChildProcess) {
  activeChildren.add(child);
  if (!killListenerAttached) {
    killListenerAttached = true;
    process.once("exit", killActiveChildren);
  }
  if (!interruptListenerAttached) {
    interruptListenerAttached = true;
    process.once("SIGINT", interruptActiveChildren);
  }
}

function unregisterChild(child: ChildProcess) {
  activeChildren.delete(child);
  if (activeChildren.size === 0) {
    if (killListenerAttached) {
      killListenerAttached = false;
      process.off("exit", killActiveChildren);
    }
    if (interruptListenerAttached) {
      interruptListenerAttached = false;
      process.off("SIGINT", interruptActiveChildren);
    }
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
 * Spawn a child process, with it's buffer
 */
export function spawn(
  command: string,
  args: string[],
  {
    outputMode = "inherit",
    outputPrefix,
    stdout = process.stdout,
    stderr = process.stderr,
    ...options
  }: SpawnOptions = {},
): KillablePromise<void> {
  if (outputMode !== "inherit" && outputMode !== "buffered") {
    throw new Error(`Unexpected output mode ${outputMode as string}`);
  }
  const child = cp.spawn(command, args, {
    ...options,
    stdio: "pipe",
  });
  const { stdout: childStdout, stderr: childStderr } = child;
  assert(childStdout, "Expected child to have stdout");
  assert(childStderr, "Expected child to have stderr");
  // Kill the child process if the main process exits or gets interrupted
  registerChild(child);

  // Bind transformed and buffered outputs to the destination streams
  let flushOutput: (stream?: "stdout" | "stderr" | "both") => void;
  if (outputMode === "inherit") {
    pipeOutput(childStdout, stdout, outputPrefix);
    pipeOutput(childStderr, stderr, outputPrefix);
    flushOutput = () => {
      // Nothing to flush
    };
  } else {
    // Buffer the output instead of piping the child into the destinations:
    // flushing forwards the buffer directly, adding no listeners to the destinations.
    const transform = createMultiBufferedTransform(
      [childStdout, childStderr] as const,
      { end: false },
    );
    const [stdoutOutput, stderrOutput] = transform.outputs;
    flushOutput = (stream = "both") => {
      forwardOutput(stdoutOutput, stdout, outputPrefix);
      forwardOutput(stderrOutput, stderr, outputPrefix);
      transform.flush(determineStream(stream, childStdout, childStderr));
      transform.destroy();
    };
  }

  const result = new Promise<void>((resolve, reject) => {
    child.once("exit", (code, signal) => {
      // The child can no longer be killed, nor react to an interrupt
      unregisterChild(child);
      if (code === 0 && signal === null) {
        resolve();
      } else {
        reject(new SpawnFailure(command, args, code, signal, flushOutput));
      }
    });
    // Propagate errors (a child failing to spawn emits "error" but never "exit")
    child.once("error", (error) => {
      unregisterChild(child);
      reject(error);
    });
  }) as KillablePromise<void>;

  // Propagate the kill method
  result.kill = child.kill.bind(child);

  return result;
}

import assert from "node:assert/strict";
import cp, { ChildProcess } from "node:child_process";

import { createMultiBufferedTransform } from "./MultiBufferedTransform.js";
import { createPrefixingTransform } from "./PrefixingTransform.js";
import { Readable, Writable } from "node:stream";

export type KillablePromise<T> = Promise<T> & {
  /**
   * Kills the child process.
   */
  kill: ChildProcess["kill"];
};

export class SpawnFailure extends Error {
  constructor(
    public readonly command: string,
    public readonly args: string[],
    public readonly code: number | null,
    public readonly signal: NodeJS.Signals | null,
    private readonly flush: (stream?: "stdout" | "stderr" | "both") => void,
  ) {
    super(
      `Running '${command}' failed` +
        (code !== null ? ` (code = ${code})` : "") +
        (signal !== null ? ` (signal = ${signal})` : ""),
    );
  }

  /**
   * Flush the buffered output, preserving order across the streams,
   * correctly interleave information with errors emitted by the child process.
   * @param [stream="both"] Optionally, flush chunks from only one stream (dropping others)
   */
  flushOutput(stream: "stdout" | "stderr" | "both" = "both") {
    this.flush(stream);
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

type TransformedStdio = [
  /** stdin */
  Writable | null,
  /** stdout */
  Readable,
  /** stderr */
  Readable,
  /**
   * Flush and destroy output streams
   */
  (stream?: "stdout" | "stderr" | "both") => void,
];

function determineStream(stream: "stdout" | "stderr" | "both") {
  if (stream === "stdout") {
    return process.stdout;
  } else if (stream === "stderr") {
    return process.stdout;
  } else if (stream === "both") {
    return undefined;
  } else {
    throw new Error(`Unexpected stream '${stream as string}'`);
  }
}

function transformStdio(
  child: ChildProcess,
  mode: OutputMode,
): TransformedStdio {
  assert(child.stdin, "Expected child to have stdin");
  assert(child.stdout, "Expected child to have stdout");
  assert(child.stderr, "Expected child to have stderr");
  if (mode === "inherit") {
    return [
      child.stdin,
      child.stdout,
      child.stderr,
      () => {
        throw new Error("Switch to 'buffered' output mode to flush buffers");
      },
    ];
  } else if (mode === "buffered") {
    const transform = createMultiBufferedTransform(
      [child.stdout, child.stderr] as const,
      { end: false },
    );
    return [
      null,
      ...transform.outputs,
      (stream: "stdout" | "stderr" | "both" = "both") => {
        transform.flush(determineStream(stream));
        transform.destroy();
      },
    ];
  } else {
    throw new Error(`Unexpected output mode ${mode as string}`);
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
  const child = cp.spawn(command, args, {
    ...options,
    stdio: "pipe",
  });
  // Exit child process if main process exits
  const killChild = () => child.kill();
  const interruptChild = () => child.kill("SIGINT");
  process.once("exit", killChild);
  process.once("SIGINT", interruptChild);

  // Bind and attach transformed and buffered outputs to process streams
  const [stdin, childStdout, childStderr, flushOutput] = transformStdio(
    child,
    outputMode,
  );
  if (stdin) {
    stdin.pipe(process.stdin);
  }
  if (typeof outputPrefix === "string") {
    childStdout.pipe(createPrefixingTransform(outputPrefix)).pipe(stdout);
    childStderr.pipe(createPrefixingTransform(outputPrefix)).pipe(stderr);
  } else {
    childStdout.pipe(stdout);
    childStderr.pipe(stderr);
  }

  const result = new Promise<void>((resolve, reject) => {
    child.once("exit", (code, signal) => {
      // Flush or destroy buffers when child exits and remove process listeners
      process.off("exit", killChild);
      process.off("SIGINT", interruptChild);
      if (code === 0 && signal === null) {
        resolve();
      } else {
        reject(new SpawnFailure(command, args, code, signal, flushOutput));
      }
    });
    // Propagate errors
    child.once("error", reject);
  }) as KillablePromise<void>;

  // Propagate the kill method
  result.kill = child.kill.bind(child);

  return result;
}

import assert from "node:assert/strict";
import path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { tmpdir } from "node:os";
import fs from "node:fs";

import { SpawnFailure, spawn } from "./spawn.ts";

const TEST_UTILS_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "./test-utils",
);
const INSTRUMENTED_SCRIPT_PATH = path.resolve(
  TEST_UTILS_DIR,
  "./instrumented-script.ts",
);

const ORIGINALS = {
  stdout: Object.getOwnPropertyDescriptor(process, "stdout")!,
  stderr: Object.getOwnPropertyDescriptor(process, "stderr")!,
};

type BufferedWriteable = Writable & { drain: () => string };

function createBufferedWriteable() {
  const buffer: string[] = [];
  const result = new Writable({
    write(chunk: Buffer, _, callback) {
      buffer.push(chunk.toString());
      callback();
    },
  }) as BufferedWriteable;
  result.drain = () => buffer.splice(0, buffer.length).join("");
  return result;
}

const PATCHED = {
  stdout: createBufferedWriteable(),
  stderr: createBufferedWriteable(),
};

function assertOutput(
  stream: BufferedWriteable | "stdout" | "stderr",
  text: string,
) {
  if (typeof stream === "string") {
    assert.equal(PATCHED[stream].drain(), text);
  } else {
    assert.equal(stream.drain(), text);
  }
}

function getTempFilePath() {
  const tempDir = fs.mkdtempSync(`${tmpdir()}${path.sep}`);
  return path.join(tempDir, "temp.file");
}

describe("BufferedWriteable util", () => {
  it("buffers and drains", () => {
    const buffered = createBufferedWriteable();
    assert.equal(buffered.drain(), "");
    buffered.write("hello");
    buffered.write("world");
    assert.equal(buffered.drain(), "helloworld");
    buffered.write("!");
    assert.equal(buffered.drain(), "!");
  });
});

describe("spawn", () => {
  beforeEach(function () {
    Object.defineProperties(process, {
      stdout: {
        get: () => PATCHED.stdout,
      },
      stderr: {
        get: () => PATCHED.stderr,
      },
    });
  });

  afterEach(function () {
    PATCHED.stdout.drain();
    PATCHED.stderr.drain();
    Object.defineProperties(process, ORIGINALS);
  });

  describe("inherit output-mode", () => {
    it("inherits stdio", async () => {
      await spawn(process.execPath, [INSTRUMENTED_SCRIPT_PATH], {
        outputMode: "inherit",
        env: {
          ...process.env,
          CONSOLE_LOG: "hi",
        },
      });
      assertOutput("stdout", "hi\n");
      assertOutput("stderr", "");
    });

    it("throws on failure", async () => {
      await spawn(process.execPath, [INSTRUMENTED_SCRIPT_PATH], {
        outputMode: "inherit",
        env: {
          ...process.env,
          CONSOLE_ERROR: "failure",
          EXIT_CODE: "123",
        },
      }).catch((error) => {
        assert(error instanceof SpawnFailure);
        assert.equal(error.code, 123);
        assert.equal(error.signal, null);
        assert.equal(error.command, process.execPath);
        assert.deepEqual(error.args, [INSTRUMENTED_SCRIPT_PATH]);
        assertOutput("stdout", "");
        assertOutput("stderr", "failure\n");
      });
    });

    it("use stdout and stderr passed through options", async () => {
      const stdout = createBufferedWriteable();
      const stderr = createBufferedWriteable();
      await spawn(process.execPath, [INSTRUMENTED_SCRIPT_PATH], {
        outputMode: "inherit",
        stdout,
        stderr,
        env: {
          ...process.env,
          CONSOLE_LOG: "hi",
          CONSOLE_ERROR: "failure",
        },
      });
      assertOutput("stdout", "");
      assertOutput("stderr", "");
      assertOutput(stdout, "hi\n");
      assertOutput(stderr, "failure\n");
    });
  });

  describe("buffered output-mode", () => {
    it("doesn't print on success", async () => {
      await spawn(process.execPath, [INSTRUMENTED_SCRIPT_PATH], {
        outputMode: "buffered",
        env: {
          ...process.env,
          CONSOLE_LOG: "ok",
        },
      });
      assertOutput("stdout", "");
      assertOutput("stderr", "");
    });

    it("doesn't print on failure, until flushed", async () => {
      await spawn(process.execPath, [INSTRUMENTED_SCRIPT_PATH], {
        outputMode: "buffered",
        env: {
          ...process.env,
          CONSOLE_LOG: "starting",
          CONSOLE_ERROR: "failed",
          EXIT_CODE: "1",
        },
      }).catch((error) => {
        assert(error instanceof SpawnFailure);
        assertOutput("stdout", "");
        assertOutput("stderr", "");
        error.flushOutput();
      });
      assertOutput("stdout", "starting\n");
      assertOutput("stderr", "failed\n");
    });

    it("doesn't print prefix, until flushed", async () => {
      await spawn(process.execPath, [INSTRUMENTED_SCRIPT_PATH], {
        outputMode: "buffered",
        outputPrefix: "[prefix] ",
        env: {
          ...process.env,
          CONSOLE_LOG: "starting",
          CONSOLE_ERROR: "failed",
          EXIT_CODE: "1",
        },
      }).catch((error) => {
        assert(error instanceof SpawnFailure);
        assertOutput("stdout", "");
        assertOutput("stderr", "");
        error.flushOutput();
      });
      assertOutput("stdout", "[prefix] starting\n");
      assertOutput("stderr", "[prefix] failed\n");
    });

    it("flushes only the selected stream", async () => {
      await spawn(process.execPath, [INSTRUMENTED_SCRIPT_PATH], {
        outputMode: "buffered",
        env: {
          ...process.env,
          CONSOLE_LOG: "starting",
          CONSOLE_ERROR: "failed",
          EXIT_CODE: "1",
        },
      }).catch((error) => {
        assert(error instanceof SpawnFailure);
        error.flushOutput("stderr");
      });
      assertOutput("stdout", "");
      assertOutput("stderr", "failed\n");
    });

    it("use stdout and stderr passed through options", async () => {
      const stdout = createBufferedWriteable();
      const stderr = createBufferedWriteable();
      await spawn(process.execPath, [INSTRUMENTED_SCRIPT_PATH], {
        outputMode: "buffered",
        stdout,
        stderr,
        env: {
          ...process.env,
          CONSOLE_LOG: "hi",
          CONSOLE_ERROR: "failure",
        },
      }).catch((error) => {
        assert(error instanceof SpawnFailure);
        assertOutput("stdout", "");
        assertOutput("stderr", "");
        assertOutput(stdout, "hi\n");
        assertOutput(stderr, "failure\n");
      });
    });
  });

  describe("bounded buffered output-mode", () => {
    // Prints numbered lines alternating between stdout and stderr, then fails.
    // Pauses between writes, as the parent reads the pipes in no particular order.
    const ALTERNATING_SCRIPT = `
      let i = 1;
      function next() {
        const stream = i % 2 === 0 ? process.stderr : process.stdout;
        stream.write((i % 2 === 0 ? "err " : "out ") + i + "\\n");
        if (++i <= 10) {
          setTimeout(next, 20);
        } else {
          process.exitCode = 1;
        }
      }
      next();
    `;

    it("keeps only the most recent lines", async () => {
      const stdout = createBufferedWriteable();
      const stderr = createBufferedWriteable();
      await assert.rejects(
        spawn(process.execPath, ["-e", ALTERNATING_SCRIPT], {
          outputMode: "buffered",
          maxBufferedLines: 3,
          stdout,
          stderr,
        }).catch((error) => {
          assert(error instanceof SpawnFailure);
          error.flushOutput();
          throw error;
        }),
        SpawnFailure,
      );
      assertOutput(stdout, "out 9\n");
      assertOutput(stderr, "err 8\nerr 10\n");
    });

    it("preserves order across streams when flushing", async () => {
      // A single destination for both streams reveals the interleaving
      const both = createBufferedWriteable();
      await spawn(process.execPath, ["-e", ALTERNATING_SCRIPT], {
        outputMode: "buffered",
        maxBufferedLines: 4,
        outputPrefix: "> ",
        stdout: both,
        stderr: both,
      }).catch((error) => {
        assert(error instanceof SpawnFailure);
        error.flushOutput();
      });
      assertOutput(both, "> out 7\n> err 8\n> out 9\n> err 10\n");
    });

    it("flushes a single stream", async () => {
      const stdout = createBufferedWriteable();
      const stderr = createBufferedWriteable();
      await spawn(process.execPath, ["-e", ALTERNATING_SCRIPT], {
        outputMode: "buffered",
        maxBufferedLines: 4,
        stdout,
        stderr,
      }).catch((error) => {
        assert(error instanceof SpawnFailure);
        error.flushOutput("stdout");
      });
      assertOutput(stdout, "out 7\nout 9\n");
      assertOutput(stderr, "");
    });

    it("bounds by bytes", async () => {
      const stdout = createBufferedWriteable();
      const script = `
        console.log("a".repeat(100));
        setTimeout(() => {
          console.log("b".repeat(10));
          process.exitCode = 1;
        }, 20);
      `;
      await spawn(process.execPath, ["-e", script], {
        outputMode: "buffered",
        maxBufferedBytes: 20,
        stdout,
      }).catch((error) => {
        assert(error instanceof SpawnFailure);
        error.flushOutput();
      });
      // The older line is evicted entirely
      assertOutput(stdout, "b".repeat(10) + "\n");
    });

    it("truncates a line exceeding the byte bound", async () => {
      const stdout = createBufferedWriteable();
      await spawn(
        process.execPath,
        ["-e", "console.log('a'.repeat(100)); process.exitCode = 1;"],
        { outputMode: "buffered", maxBufferedBytes: 20, stdout },
      ).catch((error) => {
        assert(error instanceof SpawnFailure);
        error.flushOutput();
      });
      assertOutput(stdout, "a".repeat(19) + "\n");
    });

    it("rejects invalid bounds before spawning", () => {
      assert.throws(
        () => spawn("this-is-never-spawned", [], { maxBufferedLines: 0 }),
        TypeError,
      );
    });
  });

  describe("stdin", function () {
    this.timeout(10_000);

    // Echoes stdin to stdout and exits once stdin ends (prints "EOF" before exiting)
    const ECHO_UNTIL_EOF_SCRIPT = `
      process.stdin.pipe(process.stdout, { end: false });
      process.stdin.once("end", () => console.log("EOF"));
    `;

    function sleep(ms: number) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Resolves to true if the promise settles within the given time.
     */
    async function settlesWithin(promise: Promise<unknown>, ms: number) {
      let settled = false;
      promise.then(
        () => (settled = true),
        () => (settled = true),
      );
      await sleep(ms);
      return settled;
    }

    it("pipes a Readable into the child (cat)", async () => {
      const stdout = createBufferedWriteable();
      await spawn("cat", [], {
        stdin: Readable.from(["hello ", "from ", "stdin\n"]),
        stdout,
      });
      assertOutput(stdout, "hello from stdin\n");
    });

    it("pipes a Readable into the child in buffered output-mode", async () => {
      const stdout = createBufferedWriteable();
      await spawn("sh", ["-c", "cat; exit 1"], {
        outputMode: "buffered",
        stdin: Readable.from(["buffered\n"]),
        stdout,
      }).catch((error) => {
        assert(error instanceof SpawnFailure);
        assertOutput(stdout, "");
        error.flushOutput();
      });
      assertOutput(stdout, "buffered\n");
    });

    it("closes stdin when asked, letting a child waiting on EOF exit", async () => {
      const stdout = createBufferedWriteable();
      await spawn(process.execPath, ["-e", ECHO_UNTIL_EOF_SCRIPT], {
        stdin: "close",
        stdout,
      });
      assertOutput(stdout, "EOF\n");
    });

    it("leaves stdin open by default", async () => {
      const stdout = createBufferedWriteable();
      const child = spawn(process.execPath, ["-e", ECHO_UNTIL_EOF_SCRIPT], {
        stdout,
      });
      assert.equal(await settlesWithin(child, 500), false);
      child.stdin.end("bye\n");
      await child;
      assertOutput(stdout, "bye\nEOF\n");
    });

    it("exposes stdin for writing directly", async () => {
      const stdout = createBufferedWriteable();
      const child = spawn("cat", [], { stdout });
      child.stdin.write("written ");
      child.stdin.write("directly\n");
      child.stdin.end();
      await child;
      assertOutput(stdout, "written directly\n");
    });

    it("ends the child's stdin when the source ends", async () => {
      const stdout = createBufferedWriteable();
      const source = new PassThrough();
      const child = spawn(process.execPath, ["-e", ECHO_UNTIL_EOF_SCRIPT], {
        stdin: source,
        stdout,
      });
      source.write("before end\n");
      source.end();
      await child;
      assertOutput(stdout, "before end\nEOF\n");
    });

    it("ends the child's stdin when attaching an ended source", async () => {
      const stdout = createBufferedWriteable();
      const source = Readable.from([]);
      source.resume();
      await new Promise((resolve) => source.once("end", resolve));
      await spawn(process.execPath, ["-e", ECHO_UNTIL_EOF_SCRIPT], {
        stdin: source,
        stdout,
      });
      assertOutput(stdout, "EOF\n");
    });

    it("detaches and attaches sources while running", async () => {
      const stdout = createBufferedWriteable();
      const first = new PassThrough();
      const second = new PassThrough();
      const child = spawn("cat", [], { stdin: first, stdout });

      first.write("first\n");
      await sleep(100);
      child.detachStdin();
      // Neither the source nor the child's stdin are ended by detaching
      assert.equal(first.writableEnded, false);
      assert.equal(child.stdin.writableEnded, false);
      // Buffered by the paused source, until it's attached again
      first.write("held\n");
      await sleep(100);

      child.attachStdin(second);
      second.write("second\n");
      await sleep(100);
      // Attaching another source detaches the previous
      child.attachStdin(first);
      second.write("dropped\n");
      first.write("first again\n");
      await sleep(100);

      // Ending a detached source doesn't end the child's stdin
      second.end();
      await sleep(100);
      assert.equal(child.stdin.writableEnded, false);
      assert.equal(await settlesWithin(child, 100), false);

      first.end();
      await child;
      assertOutput(stdout, "first\nsecond\nheld\nfirst again\n");
    });

    it("routes a single source to whichever child is attached", async () => {
      const source = new PassThrough();
      const stdouts = [createBufferedWriteable(), createBufferedWriteable()];
      const children = stdouts.map((stdout) => spawn("cat", [], { stdout }));

      children[0].attachStdin(source);
      source.write("to first\n");
      await sleep(100);
      children[0].detachStdin();
      children[1].attachStdin(source);
      source.write("to second\n");
      await sleep(100);
      // Both children can be attached at once
      children[0].attachStdin(source);
      source.write("to both\n");
      source.end();
      await Promise.all(children);
      assertOutput(stdouts[0], "to first\nto both\n");
      assertOutput(stdouts[1], "to second\nto both\n");
      assert.equal(source.listenerCount("data"), 0);
    });

    it("detaches the source when the child exits", async () => {
      const source = new PassThrough();
      await spawn(process.execPath, ["-e", ""], { stdin: source });
      assert.equal(source.listenerCount("data"), 0);
      assert.equal(source.listenerCount("end"), 0);
      // The source is left open and paused, as it was found
      assert.equal(source.writableEnded, false);
      assert.equal(source.isPaused(), true);
      // Writing to it doesn't fail
      source.write("after exit\n");
    });

    it("ignores writes after the child exited", async () => {
      const child = spawn(process.execPath, ["-e", ""]);
      await child;
      child.stdin.write("nobody is listening\n");
      child.attachStdin(new PassThrough());
      await sleep(50);
    });

    it("applies backpressure from the child to the source", async () => {
      // The child never reads from stdin, so writes eventually don't drain
      const source = new PassThrough();
      const child = spawn(
        process.execPath,
        ["-e", "setTimeout(() => {}, 30000)"],
        {
          stdin: source,
        },
      );
      const chunk = Buffer.alloc(64 * 1024);
      for (let i = 0; i < 64; i++) {
        source.write(chunk);
      }
      await sleep(200);
      assert.equal(source.isPaused(), true);
      child.kill();
      await assert.rejects(child, SpawnFailure);
      assert.equal(source.listenerCount("data"), 0);
    });

    it("rejects an invalid stdin before spawning", () => {
      assert.throws(
        () =>
          spawn("this-is-never-spawned", [], {
            stdin: "inherit" as "pipe",
          }),
        TypeError,
      );
    });
  });

  describe("hanging process", function () {
    // Spawning takes a while and the child is killed by a timeout
    this.timeout(20_000);

    it("can timeout", async () => {
      const tempPath = getTempFilePath();
      assert.equal(fs.existsSync(tempPath), false);
      // Hangs until killed by the timeout, then touches the file upon SIGTERM and
      // re-raises the signal to die from it (making the child exit by the signal,
      // deterministically, instead of exiting normally from its own handler).
      const hangingScript = `
        setTimeout(() => {}, 30000);
        process.once("SIGTERM", () => {
          require("node:fs").writeFileSync(${JSON.stringify(tempPath)}, "SIGTERM");
          process.kill(process.pid, "SIGTERM");
        });
      `;
      await spawn(process.execPath, ["-e", hangingScript], {
        outputMode: "inherit",
        timeout: 1000,
      }).catch((error) => {
        assert(error instanceof SpawnFailure);
        assert.equal(error.signal, "SIGTERM");
        assert.equal(error.code, null);
      });
      assert.equal(fs.existsSync(tempPath), true);
    });

    it("is killable", async () => {
      const sleeper = spawn("sleep", ["10"]);
      sleeper.kill();
      await sleeper.catch((error) => {
        assert(error instanceof SpawnFailure);
      });
    });
  });

  describe("listener hygiene", function () {
    // Spawning takes a while and some tests spawn sequentially
    this.timeout(20_000);

    // Enough to exceed the default limit of 10 listeners, should listeners leak per spawn
    const SPAWN_COUNT = 12;
    // Prints to both stdout and stderr to exercise the output plumbing
    const PRINTING_SCRIPT = "console.log('out'); console.error('err');";

    function getListenerCounts(emitter: NodeJS.EventEmitter) {
      const result: Record<string, number> = {};
      for (const event of emitter.eventNames()) {
        result[String(event)] = emitter.listenerCount(event);
      }
      return result;
    }

    /**
     * Run an async action a number of times in sequence.
     */
    async function repeat(
      count: number,
      action: (index: number) => Promise<void>,
    ) {
      for (const index of Array(count).keys()) {
        await action(index);
      }
    }

    /**
     * Asserts that running the action neither grows the number of listeners on the
     * process and its stdio streams, nor emits a MaxListenersExceededWarning.
     */
    async function assertListenerHygiene(action: () => Promise<void>) {
      // Touch process.stdin: it's instantiated lazily on first access and needs
      // a tick to settle its internal one-time construction listener
      assert(process.stdin, "Expected process.stdin");
      // Warm up: the first spawn towards a destination attaches a small constant
      // number of listeners to it, shared by all subsequent spawns
      await spawn(process.execPath, ["-e", ""], { outputMode: "inherit" });

      const warnings: Error[] = [];
      const captureWarning = (warning: Error) => {
        if (warning.name === "MaxListenersExceededWarning") {
          warnings.push(warning);
        }
      };
      process.on("warning", captureWarning);
      try {
        const emitters: [string, NodeJS.EventEmitter][] = [
          ["process", process],
          ["process.stdout", process.stdout],
          ["process.stderr", process.stderr],
          ["process.stdin", process.stdin],
        ];
        const baselines = emitters.map(
          ([name, emitter]) =>
            [name, emitter, getListenerCounts(emitter)] as const,
        );
        await action();
        // Warnings are emitted asynchronously
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(warnings, []);
        for (const [name, emitter, baseline] of baselines) {
          assert.deepEqual(
            getListenerCounts(emitter),
            baseline,
            `Expected listeners on ${name} to return to their baseline`,
          );
        }
      } finally {
        process.off("warning", captureWarning);
      }
    }

    for (const outputMode of ["inherit", "buffered"] as const) {
      describe(`${outputMode} output-mode`, () => {
        it("doesn't leak listeners on sequential spawns", async () => {
          await assertListenerHygiene(async () => {
            await repeat(SPAWN_COUNT, async (i) => {
              await spawn(process.execPath, ["-e", PRINTING_SCRIPT], {
                outputMode,
                outputPrefix: i % 2 === 0 ? "[prefix] " : undefined,
              });
            });
          });
        });

        it("doesn't leak listeners on concurrent spawns", async () => {
          await assertListenerHygiene(async () => {
            await Promise.all(
              Array.from({ length: SPAWN_COUNT }, (_, i) =>
                spawn(process.execPath, ["-e", PRINTING_SCRIPT], {
                  outputMode,
                  outputPrefix: i % 2 === 0 ? "[prefix] " : undefined,
                }),
              ),
            );
          });
        });

        it("doesn't leak listeners when spawning fails", async () => {
          await assertListenerHygiene(async () => {
            await repeat(SPAWN_COUNT, () =>
              assert.rejects(
                spawn("this-command-does-not-exist", [], { outputMode }),
                /ENOENT/,
              ),
            );
          });
        });
      });
    }

    it("doesn't leak listeners on a source shared by concurrent children", async () => {
      const source = new PassThrough();
      const sourceBaseline = getListenerCounts(source);
      const warnings: Error[] = [];
      const captureWarning = (warning: Error) => warnings.push(warning);
      process.on("warning", captureWarning);
      try {
        const stdout = createBufferedWriteable();
        await assertListenerHygiene(async () => {
          const children = Array.from({ length: SPAWN_COUNT }, () =>
            spawn("cat", [], { stdin: source, stdout }),
          );
          source.write("x");
          source.end();
          await Promise.all(children);
        });
        // The promise settles on "exit", which may precede the last output: wait for it
        let output = "";
        for (let i = 0; i < 100 && output.length < SPAWN_COUNT; i++) {
          output += stdout.drain();
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(output, "x".repeat(SPAWN_COUNT));
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(warnings, []);
        assert.deepEqual(getListenerCounts(source), sourceBaseline);
      } finally {
        process.off("warning", captureWarning);
      }
    });

    it("doesn't leak listeners when spawning fails with a stdin source", async () => {
      const source = new PassThrough();
      const sourceBaseline = getListenerCounts(source);
      await assertListenerHygiene(async () => {
        await repeat(SPAWN_COUNT, () =>
          assert.rejects(
            spawn("this-command-does-not-exist", [], { stdin: source }),
            /ENOENT/,
          ),
        );
      });
      assert.deepEqual(getListenerCounts(source), sourceBaseline);
    });

    it("doesn't leak listeners when failures are never flushed", async () => {
      await assertListenerHygiene(async () => {
        await repeat(SPAWN_COUNT, () =>
          assert.rejects(
            spawn(
              process.execPath,
              ["-e", PRINTING_SCRIPT + " process.exit(1);"],
              { outputMode: "buffered" },
            ),
            SpawnFailure,
          ),
        );
      });
    });

    it("doesn't leak listeners when failures are flushed", async () => {
      await assertListenerHygiene(async () => {
        await repeat(SPAWN_COUNT, () =>
          spawn(
            process.execPath,
            ["-e", PRINTING_SCRIPT + " process.exit(1);"],
            { outputMode: "buffered", outputPrefix: "[prefix] " },
          ).catch((error) => {
            assert(error instanceof SpawnFailure);
            error.flushOutput();
          }),
        );
        // Sanity check that flushing actually wrote through to the output
        assert.notEqual(PATCHED.stdout.drain(), "");
        assert.notEqual(PATCHED.stderr.drain(), "");
      });
    });
  });
});

import assert from "node:assert/strict";
import path from "node:path";
import { Writable } from "node:stream";
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

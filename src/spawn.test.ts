import assert from "node:assert/strict";
import path from "node:path";
import { Writable } from "node:stream";
import { tmpdir } from "node:os";
import fs from "node:fs";

import { SpawnFailure, spawn } from "./spawn.js";

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
      await spawn("npx", ["tsx", INSTRUMENTED_SCRIPT_PATH], {
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
      await spawn("npx", ["tsx", INSTRUMENTED_SCRIPT_PATH], {
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
        assert.equal(error.command, "npx");
        assert.deepEqual(error.args, ["tsx", INSTRUMENTED_SCRIPT_PATH]);
        assertOutput("stdout", "");
        assertOutput("stderr", "failure\n");
      });
    });

    it("use stdout and stderr passed through options", async () => {
      const stdout = createBufferedWriteable();
      const stderr = createBufferedWriteable();
      await spawn("npx", ["tsx", INSTRUMENTED_SCRIPT_PATH], {
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
      await spawn("npx", ["tsx", INSTRUMENTED_SCRIPT_PATH], {
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
      await spawn("npx", ["tsx", INSTRUMENTED_SCRIPT_PATH], {
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
      await spawn("npx", ["tsx", INSTRUMENTED_SCRIPT_PATH], {
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

    it("use stdout and stderr passed through options", async () => {
      const stdout = createBufferedWriteable();
      const stderr = createBufferedWriteable();
      await spawn("npx", ["tsx", INSTRUMENTED_SCRIPT_PATH], {
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

  describe("hanging process", () => {
    it("can timeout", async () => {
      const tempPath = getTempFilePath();
      assert.equal(fs.existsSync(tempPath), false);
      await spawn("npx", ["tsx", INSTRUMENTED_SCRIPT_PATH], {
        outputMode: "inherit",
        timeout: 500,
        env: {
          ...process.env,
          SET_TIMEOUT_MS: "1000",
          TOUCH_PATH_ON_EXIT: tempPath,
        },
      }).catch((error) => {
        assert(error instanceof SpawnFailure);
        assert.equal(error.code, null);
        assert.equal(error.signal, "SIGTERM");
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
});

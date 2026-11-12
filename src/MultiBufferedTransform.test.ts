import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";

import { createMultiBufferedTransform } from "./MultiBufferedTransform.ts";

async function streamsToString(streams: Readable[]) {
  let output = "";
  await Promise.all(
    streams.map(
      (stream) =>
        new Promise((resolve) =>
          stream
            .on("data", (chunk: Buffer) => {
              output += chunk.toString();
            })
            .once("close", resolve),
        ),
    ),
  );
  return output;
}

describe("MultiBufferedTransform", () => {
  it("passes through a single readable in order", async () => {
    const transform = createMultiBufferedTransform([
      Readable.from(["hello", "world", "here", "i", "am"]),
    ]);

    process.nextTick(() => {
      transform.flush();
    });

    assert.equal(transform.outputs.length, 1, "Expected a single output");
    const output = streamsToString(transform.outputs);
    assert.equal(await output, "helloworldhereiam");
  });

  it("passes through multiple readables in order", async () => {
    const passthrough1 = new PassThrough();
    const passthrough2 = new PassThrough();
    const passthrough3 = new PassThrough();
    const transform = createMultiBufferedTransform([
      passthrough1,
      passthrough2,
      passthrough3,
    ]);

    // Writing out order passed when created
    process.nextTick(() => {
      passthrough1.write("hello");
      passthrough1.end();
    });
    process.nextTick(() => {
      passthrough3.write("world");
      passthrough3.end();
    });
    process.nextTick(() => {
      passthrough2.write("!");
      passthrough2.end();
    });

    process.nextTick(() => {
      transform.flush();
    });

    assert.equal(transform.outputs.length, 3, "Expected a three outputs");
    const output = streamsToString(transform.outputs);
    assert.equal(await output, "helloworld!");
  });

  it("flushes a stream exclusively", async () => {
    const passthrough1 = new PassThrough();
    const passthrough2 = new PassThrough();
    const transform = createMultiBufferedTransform([
      passthrough1,
      passthrough2,
    ]);

    // Writing out order passed when created
    process.nextTick(() => {
      passthrough1.write("hello");
      passthrough1.end();
    });
    process.nextTick(() => {
      passthrough2.write("world");
      passthrough2.end();
    });

    process.nextTick(() => {
      transform.flush(passthrough1);
    });

    assert.equal(transform.outputs.length, 2, "Expected a three outputs");
    const output = streamsToString(transform.outputs);
    assert.equal(await output, "hello");
  });

  it("can clear and resume output", async () => {
    const passthrough = new PassThrough();
    const transform = createMultiBufferedTransform([passthrough]);

    // Writing out order passed when created
    process.nextTick(() => {
      passthrough.write("hello");
      transform.clear();
      passthrough.write("great");
      passthrough.write("world");
    });

    process.nextTick(() => {
      transform.flush();
      transform.destroy();
    });

    assert.equal(transform.outputs.length, 1, "Expected a single output");
    const output = streamsToString(transform.outputs);
    assert.equal(await output, "greatworld");
  });

  describe("bounded by maxLines", () => {
    it("evicts the oldest lines, in order across inputs", async () => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const transform = createMultiBufferedTransform([stdout, stderr], {
        maxLines: 3,
      });

      process.nextTick(() => {
        stdout.write("out 1\n");
        stderr.write("err 1\n");
        stdout.write("out 2\nout 3\n");
        stderr.write("err 2\n");
      });

      setImmediate(() => {
        transform.flush();
        transform.destroy();
      });

      const output = streamsToString(transform.outputs);
      assert.equal(await output, "out 2\nout 3\nerr 2\n");
    });

    it("joins partial lines across chunks", async () => {
      const passthrough = new PassThrough();
      const transform = createMultiBufferedTransform([passthrough], {
        maxLines: 2,
      });

      process.nextTick(() => {
        passthrough.write("first\nsec");
        passthrough.write("ond\nthi");
        passthrough.write("rd\nfou");
      });

      setImmediate(() => {
        transform.flush();
        transform.destroy();
      });

      const output = streamsToString(transform.outputs);
      assert.equal(await output, "third\nfou");
    });

    it("flushes a stream exclusively", async () => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const transform = createMultiBufferedTransform([stdout, stderr], {
        maxLines: 2,
      });

      process.nextTick(() => {
        stdout.write("out 1\n");
        stderr.write("err 1\n");
        stdout.write("out 2\n");
        stderr.write("err 2\n");
      });

      setImmediate(() => {
        transform.flush(stderr);
        transform.destroy();
      });

      const output = streamsToString(transform.outputs);
      // The two most recent lines were "out 2" and "err 2"
      assert.equal(await output, "err 2\n");
    });
  });

  it("bounds by maxBytes", async () => {
    const passthrough = new PassThrough();
    const transform = createMultiBufferedTransform([passthrough], {
      maxBytes: 8,
    });

    process.nextTick(() => {
      passthrough.write("123\n456\n789\n");
    });

    setImmediate(() => {
      transform.flush();
      transform.destroy();
    });

    const output = streamsToString(transform.outputs);
    assert.equal(await output, "456\n789\n");
  });
});

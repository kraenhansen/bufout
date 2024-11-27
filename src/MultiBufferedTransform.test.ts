import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";

import { createMultiBufferedTransform } from "./MultiBufferedTransform.js";

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
});

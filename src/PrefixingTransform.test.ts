import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";

import { createPrefixingTransform } from "./PrefixingTransform.ts";

function testPrefixingTransform(
  chunks: (string | Buffer)[],
  prefix: string,
  expectedOutput: string,
  done: () => void,
) {
  const transform = createPrefixingTransform(prefix);
  let output = "";

  const readable = Readable.from(chunks);
  const writable = new Writable({
    write(chunk: Buffer, _, callback) {
      output += chunk.toString();
      callback();
    },
  });

  readable
    .pipe(transform)
    .pipe(writable)
    .on("finish", () => {
      assert.equal(output, expectedOutput);
      done();
    });
}

describe("PrefixingTransform", () => {
  it("should handle empty input", function (done) {
    testPrefixingTransform([], "[PREFIX] ", "", done);
  });

  it("should prefix complete lines correctly", (done) => {
    testPrefixingTransform(
      ["Line1\nLine2\nLine3\n"],
      "[PREFIX] ",
      "[PREFIX] Line1\n[PREFIX] Line2\n[PREFIX] Line3\n",
      done,
    );
  });

  it("adds a prefix", (done) => {
    testPrefixingTransform(
      ["Line1\nPartia", "lLine\nLine2\n"],
      "[PREFIX] ",
      "[PREFIX] Line1\n[PREFIX] PartialLine\n[PREFIX] Line2\n",
      done,
    );
  });

  it("should handle input ending without a newline", function (done) {
    testPrefixingTransform(
      ["Line1\nLine2"],
      "[PREFIX] ",
      "[PREFIX] Line1\n[PREFIX] Line2",
      done,
    );
  });

  it("should handle input with only newlines", function (done) {
    testPrefixingTransform(
      ["\n\n\n"],
      "[PREFIX] ",
      "[PREFIX] \n[PREFIX] \n[PREFIX] \n",
      done,
    );
  });

  it("should handle input with mixed empty lines and partial lines", function (done) {
    testPrefixingTransform(
      ["\nPartialLine", "\nAnotherPartial\nLine\n"],
      "[PREFIX] ",
      "[PREFIX] \n[PREFIX] PartialLine\n[PREFIX] AnotherPartial\n[PREFIX] Line\n",
      done,
    );
  });

  it("should handle input with a single character", function (done) {
    testPrefixingTransform(["A"], "[PREFIX] ", "[PREFIX] A", done);
  });

  it("should handle input with only a newline character", function (done) {
    testPrefixingTransform(["\n"], "[PREFIX] ", "[PREFIX] \n", done);
  });

  it("should handle input split exactly at the newline boundary", function (done) {
    testPrefixingTransform(
      ["Line1\n", "Line2\n", "Line3\n"],
      "[PREFIX] ",
      "[PREFIX] Line1\n[PREFIX] Line2\n[PREFIX] Line3\n",
      done,
    );
  });

  it("should handle very large input chunks", function (done) {
    const largeInput = "Line\n".repeat(10000); // 10,000 lines
    const expectedOutput = "[PREFIX] Line\n".repeat(10000);
    testPrefixingTransform([largeInput], "[PREFIX] ", expectedOutput, done);
  });

  it("should decode multi-byte characters split across chunks", function (done) {
    const bytes = Buffer.from("æøå\n🚀 launch\n");
    // Split into single bytes, splitting every multi-byte character
    const chunks = [...bytes].map((byte) => Buffer.from([byte]));
    testPrefixingTransform(
      chunks,
      "[PREFIX] ",
      "[PREFIX] æøå\n[PREFIX] 🚀 launch\n",
      done,
    );
  });

  it("should decode a multi-byte character split at a line start", function (done) {
    const rocket = Buffer.from("🚀");
    testPrefixingTransform(
      [
        Buffer.concat([Buffer.from("a\n"), rocket.subarray(0, 2)]),
        Buffer.concat([rocket.subarray(2), Buffer.from("\n")]),
      ],
      "> ",
      "> a\n> 🚀\n",
      done,
    );
  });

  it("should flush an incomplete character at the end", function (done) {
    const rocket = Buffer.from("🚀");
    // StringDecoder emits a replacement character for the incomplete bytes
    testPrefixingTransform([rocket.subarray(0, 2)], "> ", "> \ufffd", done);
  });
});

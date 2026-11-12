import assert from "node:assert/strict";

import { LineRingBuffer } from "./LineRingBuffer.ts";

function texts<S>(ring: LineRingBuffer<S>, source?: S) {
  return [...ring.entries(source)].map(({ data }) => data.toString());
}

describe("LineRingBuffer", () => {
  it("is unbounded by default", () => {
    const ring = new LineRingBuffer();
    for (let i = 0; i < 1000; i++) {
      ring.write(`line ${i}\n`);
    }
    assert.equal(ring.lineCount, 1000);
    assert.equal(ring.evictedLines, 0);
    assert.equal(ring.lines()[0], "line 0");
    assert.equal(ring.lines()[999], "line 999");
  });

  it("rejects invalid bounds", () => {
    assert.throws(() => new LineRingBuffer({ maxLines: 0 }), TypeError);
    assert.throws(() => new LineRingBuffer({ maxLines: 1.5 }), TypeError);
    assert.throws(() => new LineRingBuffer({ maxBytes: -1 }), TypeError);
    assert.throws(() => new LineRingBuffer({ maxBytes: NaN }), TypeError);
  });

  it("evicts the oldest lines", () => {
    const ring = new LineRingBuffer({ maxLines: 3 });
    for (let i = 0; i < 10; i++) {
      ring.write(`line ${i}\n`);
    }
    assert.deepEqual(ring.lines(), ["line 7", "line 8", "line 9"]);
    assert.equal(ring.lineCount, 3);
    assert.equal(ring.evictedLines, 7);
    assert.equal(ring.byteLength, "line 7\nline 8\nline 9\n".length);
  });

  it("splits chunks containing many lines", () => {
    const ring = new LineRingBuffer({ maxLines: 2 });
    ring.write("a\nb\nc\nd\ne\n");
    assert.deepEqual(texts(ring), ["d\n", "e\n"]);
    assert.equal(ring.evictedLines, 3);
  });

  it("joins partial lines split across chunks", () => {
    const ring = new LineRingBuffer({ maxLines: 2 });
    ring.write("he");
    ring.write("ll");
    ring.write("o\nwor");
    assert.deepEqual(
      [...ring.entries()].map(({ data, complete }) => [
        data.toString(),
        complete,
      ]),
      [
        ["hello\n", true],
        ["wor", false],
      ],
    );
    ring.write("ld\n!");
    assert.deepEqual(ring.lines(), ["world", "!"]);
  });

  it("counts a partial line as a line", () => {
    const ring = new LineRingBuffer({ maxLines: 2 });
    ring.write("a\nb\nc");
    assert.deepEqual(ring.lines(), ["b", "c"]);
    // Completing the partial line doesn't add another line
    ring.write("c\n");
    assert.deepEqual(ring.lines(), ["b", "cc"]);
  });

  it("strips line endings when decoding lines", () => {
    const ring = new LineRingBuffer();
    ring.write("unix\nwindows\r\n\nlast");
    assert.deepEqual(ring.lines(), ["unix", "windows", "", "last"]);
  });

  it("keeps multi-byte characters split across chunks intact", () => {
    const ring = new LineRingBuffer({ maxLines: 1 });
    const bytes = Buffer.from("æøå 🚀\n");
    for (const byte of bytes) {
      ring.write(Buffer.from([byte]));
    }
    assert.deepEqual(ring.lines(), ["æøå 🚀"]);
  });

  it("preserves order across sources", () => {
    const ring = new LineRingBuffer<"out" | "err">({ maxLines: 4 });
    ring.write("out 1\n", "out");
    ring.write("err 1\n", "err");
    ring.write("out 2\nout 3\n", "out");
    ring.write("err 2\n", "err");
    ring.write("out 4\n", "out");
    assert.deepEqual(
      [...ring.entries()].map(({ source, data }) => [source, data.toString()]),
      [
        ["out", "out 2\n"],
        ["out", "out 3\n"],
        ["err", "err 2\n"],
        ["out", "out 4\n"],
      ],
    );
  });

  it("evicts in write order across sources", () => {
    const ring = new LineRingBuffer<"out" | "err">({ maxLines: 2 });
    ring.write("out 1\n", "out");
    ring.write("err 1\n", "err");
    ring.write("err 2\n", "err");
    assert.deepEqual(texts(ring), ["err 1\n", "err 2\n"]);
    ring.write("out 2\n", "out");
    assert.deepEqual(texts(ring), ["err 2\n", "out 2\n"]);
  });

  it("keeps partial lines per source, at the position of their first chunk", () => {
    const ring = new LineRingBuffer<"out" | "err">();
    ring.write("out sta", "out");
    ring.write("err sta", "err");
    ring.write("err line\n", "err");
    ring.write("rted\n", "out");
    ring.write("rted\n", "err");
    assert.deepEqual(
      [...ring.entries()].map(({ source, data }) => [source, data.toString()]),
      [
        ["out", "out started\n"],
        ["err", "err staerr line\n"],
        ["err", "rted\n"],
      ],
    );
  });

  it("filters entries by source", () => {
    const ring = new LineRingBuffer<"out" | "err">({ maxLines: 3 });
    ring.write("out 1\n", "out");
    ring.write("err 1\n", "err");
    ring.write("out 2\n", "out");
    ring.write("err 2\n", "err");
    assert.deepEqual(ring.lines("out"), ["out 2"]);
    assert.deepEqual(ring.lines("err"), ["err 1", "err 2"]);
  });

  it("continues an evicted partial line as a new line", () => {
    const ring = new LineRingBuffer<"out" | "err">({ maxLines: 1 });
    ring.write("out partial", "out");
    ring.write("err\n", "err");
    ring.write(" rest\n", "out");
    assert.deepEqual(texts(ring), [" rest\n"]);
  });

  it("can be cleared and reused", () => {
    const ring = new LineRingBuffer({ maxLines: 2 });
    ring.write("a\nb\nc");
    ring.clear();
    assert.equal(ring.lineCount, 0);
    assert.equal(ring.byteLength, 0);
    assert.deepEqual(ring.lines(), []);
    ring.write("d\n");
    assert.deepEqual(ring.lines(), ["d"]);
  });

  it("allows writes while iterating", () => {
    const ring = new LineRingBuffer({ maxLines: 2 });
    ring.write("a\nb\n");
    const seen: string[] = [];
    for (const { data } of ring.entries()) {
      seen.push(data.toString());
      ring.write("x\n");
    }
    assert.deepEqual(seen, ["a\n", "b\n"]);
  });

  describe("maxBytes", () => {
    it("evicts the oldest lines", () => {
      const ring = new LineRingBuffer({ maxBytes: 10 });
      ring.write("1234\n");
      ring.write("5678\n");
      assert.equal(ring.byteLength, 10);
      ring.write("9\n");
      assert.deepEqual(ring.lines(), ["5678", "9"]);
      assert.equal(ring.byteLength, 7);
    });

    it("truncates a single line exceeding the bound", () => {
      const ring = new LineRingBuffer({ maxBytes: 5 });
      ring.write("abc");
      ring.write("def");
      ring.write("ghi");
      const [entry, ...rest] = ring.entries();
      assert.deepEqual(rest, []);
      assert.equal(entry.data.toString(), "efghi");
      assert.equal(entry.truncated, true);
      assert.equal(entry.complete, false);
      assert.equal(ring.byteLength, 5);
      // The line can still be completed
      ring.write("\n");
      assert.deepEqual(ring.lines(), ["fghi"]);
    });

    it("doesn't split a multi-byte character when truncating", () => {
      const ring = new LineRingBuffer({ maxBytes: 5 });
      // "ø" is two bytes: keeping the last 5 bytes would split it
      ring.write("øøø");
      assert.deepEqual(ring.lines(), ["øø"]);
      assert.equal(ring.byteLength, 4);
    });

    it("combines with maxLines", () => {
      const ring = new LineRingBuffer({ maxLines: 3, maxBytes: 8 });
      ring.write("a\nb\nc\nd\n");
      assert.deepEqual(ring.lines(), ["b", "c", "d"]);
      ring.write("long line\n");
      assert.deepEqual(ring.lines(), ["ng line"]);
    });
  });

  it("appends in amortised constant time", function () {
    this.timeout(10_000);
    const measure = (writes: number) => {
      const ring = new LineRingBuffer({ maxLines: 100, maxBytes: 4096 });
      const start = process.hrtime.bigint();
      for (let i = 0; i < writes; i++) {
        // Alternate complete lines and fragments of a long partial line
        ring.write(i % 2 === 0 ? "a complete line\n" : "fragment ");
      }
      return Number(process.hrtime.bigint() - start);
    };
    // Warm up
    measure(10_000);
    const small = measure(20_000);
    const large = measure(200_000);
    // 10x the writes should take roughly 10x the time, not 100x
    assert(
      large < small * 40,
      `Expected linear growth (${small}ns for 20k, ${large}ns for 200k)`,
    );
  });

  it("appends to a long partial line in amortised constant time", function () {
    this.timeout(10_000);
    const measure = (writes: number) => {
      const ring = new LineRingBuffer({ maxBytes: 1024 });
      const start = process.hrtime.bigint();
      for (let i = 0; i < writes; i++) {
        ring.write("no newline ");
      }
      assert.equal(ring.lineCount, 1);
      assert(ring.byteLength <= 1024);
      return Number(process.hrtime.bigint() - start);
    };
    measure(10_000);
    const small = measure(20_000);
    const large = measure(200_000);
    assert(
      large < small * 40,
      `Expected linear growth (${small}ns for 20k, ${large}ns for 200k)`,
    );
  });
});

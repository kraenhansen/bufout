const NEWLINE = 0x0a;

export type LineRingBufferOptions = {
  /**
   * Maximum number of lines kept, evicting the oldest line when exceeded.
   * A line still being written (not yet terminated by a newline) counts as a line.
   * @default Infinity
   */
  maxLines?: number;
  /**
   * Maximum number of bytes kept, evicting the oldest lines when exceeded.
   * If the newest line alone exceeds the bound, its oldest bytes are dropped.
   * @default Infinity
   */
  maxBytes?: number;
};

export type LineRingBufferEntry<S> = {
  /**
   * The source passed when writing the line.
   */
  source: S;
  /**
   * The bytes of the line, including its terminating newline when complete.
   */
  data: Buffer;
  /**
   * Is the line terminated by a newline?
   * Only the most recent line of each source can be incomplete.
   */
  complete: boolean;
  /**
   * Was the start of the line dropped to respect `maxBytes`?
   */
  truncated: boolean;
};

type Line<S> = {
  source: S;
  /** Fragments of the line, in order, starting at `start`. */
  parts: Buffer[];
  start: number;
  bytes: number;
  complete: boolean;
  truncated: boolean;
};

function assertBound(name: string, value: number) {
  if (!(value === Infinity || (Number.isInteger(value) && value > 0))) {
    throw new TypeError(
      `Expected '${name}' to be a positive integer or Infinity, got ${value}`,
    );
  }
}

/**
 * Returns true if the byte is a UTF-8 continuation byte (0b10xxxxxx).
 */
function isContinuationByte(byte: number) {
  return (byte & 0xc0) === 0x80;
}

/**
 * Collapse the fragments of a line into a single buffer.
 */
function joinParts<S>(line: Line<S>): Buffer {
  const count = line.parts.length - line.start;
  if (count === 0) {
    return Buffer.alloc(0);
  } else if (count === 1) {
    return line.parts[line.start];
  } else {
    // Collapse once, to avoid joining again on subsequent reads
    const joined = Buffer.concat(line.parts.slice(line.start), line.bytes);
    line.parts = [joined];
    line.start = 0;
    return joined;
  }
}

/**
 * A bounded buffer of the most recent lines written to it, from one or more sources.
 *
 * - Chunks are split into lines (on "\n"): a chunk may contain many lines and a line may
 *   be split across many chunks. A partial line is completed by subsequent writes from the
 *   same source and keeps the position of its first fragment.
 * - Lines from multiple sources are kept in the order they started, so output from
 *   multiple streams (such as stdout and stderr) can be replayed in order.
 * - When a bound is exceeded, the oldest lines are evicted.
 * - Appending is O(1) amortised, per line and per chunk: the buffer is never re-split or copied as a whole.
 *
 * Bytes are split on the newline byte, which is safe for UTF-8 (and other ASCII compatible encodings),
 * without decoding: multi-byte characters split across chunks are kept intact.
 */
export class LineRingBuffer<S = undefined> {
  readonly maxLines: number;
  readonly maxBytes: number;

  /** Circular array of lines, the oldest at `#head` */
  #ring: (Line<S> | undefined)[] = [];
  #head = 0;
  #count = 0;
  #bytes = 0;
  #evictedLines = 0;
  /** The incomplete (most recent) line per source */
  #open = new Map<S, Line<S>>();

  constructor({
    maxLines = Infinity,
    maxBytes = Infinity,
  }: LineRingBufferOptions = {}) {
    assertBound("maxLines", maxLines);
    assertBound("maxBytes", maxBytes);
    this.maxLines = maxLines;
    this.maxBytes = maxBytes;
  }

  /**
   * Number of lines currently in the buffer (including incomplete lines).
   */
  get lineCount() {
    return this.#count;
  }

  /**
   * Number of bytes currently in the buffer.
   */
  get byteLength() {
    return this.#bytes;
  }

  /**
   * Number of lines evicted (entirely) since creation or the last call to `clear`.
   */
  get evictedLines() {
    return this.#evictedLines;
  }

  /**
   * Append a chunk of output from a source.
   */
  write(chunk: Buffer | Uint8Array | string, source?: S): void {
    const buffer =
      typeof chunk === "string"
        ? Buffer.from(chunk)
        : Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const key = source as S;
    let offset = 0;
    while (offset < buffer.length) {
      const newline = buffer.indexOf(NEWLINE, offset);
      const end = newline === -1 ? buffer.length : newline + 1;
      // Copy the fragment, to avoid retaining the entire chunk for a short line
      this.#append(key, Buffer.from(buffer.subarray(offset, end)));
      if (newline !== -1) {
        this.#complete(key);
      }
      offset = end;
    }
    this.#enforceMaxBytes();
  }

  /**
   * Iterate the lines in order, optionally only those from a single source
   * (passing `undefined` iterates lines from all sources).
   */
  *entries(source?: S): IterableIterator<LineRingBufferEntry<S>> {
    // Snapshot to allow writes and clears while iterating
    const lines = this.#snapshot();
    for (const line of lines) {
      if (source !== undefined && line.source !== source) {
        continue;
      }
      yield {
        source: line.source,
        data: joinParts(line),
        complete: line.complete,
        truncated: line.truncated,
      };
    }
  }

  /**
   * Decoded lines in order (optionally from a single source), without their line endings ("\n" or "\r\n").
   */
  lines(source?: S, encoding: BufferEncoding = "utf8"): string[] {
    const result: string[] = [];
    for (const { data } of this.entries(source)) {
      let end = data.length;
      if (end > 0 && data[end - 1] === NEWLINE) {
        end--;
        if (end > 0 && data[end - 1] === 0x0d) {
          end--;
        }
      }
      result.push(data.toString(encoding, 0, end));
    }
    return result;
  }

  /**
   * Remove all lines from the buffer.
   */
  clear(): void {
    this.#ring = [];
    this.#head = 0;
    this.#count = 0;
    this.#bytes = 0;
    this.#evictedLines = 0;
    this.#open.clear();
  }

  #snapshot(): Line<S>[] {
    const result: Line<S>[] = [];
    const capacity = this.#ring.length;
    for (let i = 0; i < this.#count; i++) {
      result.push(this.#ring[(this.#head + i) % capacity]!);
    }
    return result;
  }

  #append(source: S, fragment: Buffer) {
    const open = this.#open.get(source);
    if (open) {
      open.parts.push(fragment);
      open.bytes += fragment.length;
    } else {
      const line: Line<S> = {
        source,
        parts: [fragment],
        start: 0,
        bytes: fragment.length,
        complete: false,
        truncated: false,
      };
      this.#push(line);
      this.#open.set(source, line);
    }
    this.#bytes += fragment.length;
  }

  #complete(source: S) {
    const line = this.#open.get(source);
    if (line) {
      line.complete = true;
      this.#open.delete(source);
    }
  }

  #push(line: Line<S>) {
    if (this.#count >= this.maxLines) {
      this.#evictOldest();
    }
    if (this.#count === this.#ring.length) {
      this.#grow();
    }
    const capacity = this.#ring.length;
    this.#ring[(this.#head + this.#count) % capacity] = line;
    this.#count++;
  }

  #grow() {
    const capacity = this.#ring.length;
    const next = Math.min(Math.max(capacity * 2, 16), this.maxLines);
    // Unroll the lines into a new array, oldest first
    const ring = this.#snapshot() as (Line<S> | undefined)[];
    ring.length = next;
    this.#ring = ring;
    this.#head = 0;
  }

  #evictOldest() {
    const line = this.#ring[this.#head]!;
    this.#ring[this.#head] = undefined;
    this.#head = (this.#head + 1) % this.#ring.length;
    this.#count--;
    this.#bytes -= line.bytes;
    this.#evictedLines++;
    if (this.#open.get(line.source) === line) {
      // The rest of the line gets written into a new line
      this.#open.delete(line.source);
    }
  }

  #enforceMaxBytes() {
    while (this.#bytes > this.maxBytes && this.#count > 1) {
      this.#evictOldest();
    }
    if (this.#bytes > this.maxBytes) {
      this.#truncateOldest(this.#bytes - this.maxBytes);
    }
  }

  /**
   * Drop bytes from the start of the oldest line.
   */
  #truncateOldest(excess: number) {
    const line = this.#ring[this.#head]!;
    let dropped = 0;
    // Drop entire fragments first
    while (dropped + line.parts[line.start].length <= excess) {
      dropped += line.parts[line.start].length;
      line.start++;
    }
    // Then a prefix of the next fragment, avoiding splitting a UTF-8 character
    const first = line.parts[line.start];
    let cut = excess - dropped;
    while (cut < first.length && cut > 0 && isContinuationByte(first[cut])) {
      cut++;
    }
    line.parts[line.start] = first.subarray(cut);
    dropped += cut;
    // Compact the fragments, keeping removal from the front O(1) amortised
    if (line.start > line.parts.length / 2) {
      line.parts = line.parts.slice(line.start);
      line.start = 0;
    }
    line.bytes -= dropped;
    line.truncated = true;
    this.#bytes -= dropped;
  }
}

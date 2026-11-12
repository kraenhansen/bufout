import { Readable, Transform } from "node:stream";

import { LineRingBuffer } from "./LineRingBuffer.ts";

type MultiBufferedTransformResult<T extends Readable[]> = {
  /**
   * Flush streams into their respective outputs
   * @param stream filter for a specific stream and drops chunks belonging to other streams.
   */
  flush(stream?: Readable): void;
  /**
   * Destroy all output streams.
   */
  destroy(): void;
  /**
   * Delete all chunks from the buffer.
   */
  clear(): void;
  /**
   * Output streams corresponding to each of the input streams, to which the buffer will be flushed.
   */
  outputs: T;
};

export type MultiBufferedTransformOptions = {
  /**
   * End the output when the input ends.
   * @default true
   */
  end?: boolean;
  /**
   * Bound the buffer to the most recent lines (across all inputs), evicting the oldest.
   * When bounded, the buffer stores lines instead of chunks: a partial line is completed
   * by later chunks from the same input and keeps the position of its first chunk.
   * @default Infinity (unbounded)
   */
  maxLines?: number;
  /**
   * Bound the buffer to the most recent bytes (across all inputs), evicting the oldest lines.
   * @default Infinity (unbounded)
   */
  maxBytes?: number;
};

type ChunkBuffer = {
  write(chunk: unknown, output: Transform): void;
  /** Push and drop all chunks, skipping those not matching the filter */
  flush(filter: (output: Transform) => boolean): void;
  clear(): void;
};

/**
 * Unbounded buffer of chunks, in the order they were written.
 */
function createChunkBuffer(): ChunkBuffer {
  const buffer: [unknown, Transform][] = [];
  return {
    write(chunk, output) {
      buffer.push([chunk, output]);
    },
    flush(filter) {
      for (const [chunk, transform] of buffer.splice(0, buffer.length)) {
        if (filter(transform)) {
          transform.push(chunk);
        }
      }
    },
    clear() {
      buffer.splice(0, buffer.length);
    },
  };
}

/**
 * Bounded buffer of lines, in the order they started.
 */
function createLineBuffer(maxLines: number, maxBytes: number): ChunkBuffer {
  const ring = new LineRingBuffer<Transform>({ maxLines, maxBytes });
  return {
    write(chunk, output) {
      ring.write(chunk as Buffer | string, output);
    },
    flush(filter) {
      const entries = [...ring.entries()];
      ring.clear();
      for (const { source, data } of entries) {
        if (filter(source)) {
          source.push(data);
        }
      }
    },
    clear() {
      ring.clear();
    },
  };
}

/**
 * Combines multiple readable streams into a single buffer which can be flushed in order of writes across the streams.
 * I.e. if one stream gets a chunk, the second does and then the first gets another, the order of pushing these into
 * the outputs will be preserved when flushing.
 */
export function createMultiBufferedTransform<T extends Readable[]>(
  inputs: T,
  {
    end = true,
    maxLines = Infinity,
    maxBytes = Infinity,
  }: MultiBufferedTransformOptions = {},
): MultiBufferedTransformResult<T> {
  const buffer =
    maxLines === Infinity && maxBytes === Infinity
      ? createChunkBuffer()
      : createLineBuffer(maxLines, maxBytes);
  const outputPerInput = new Map<Readable, Transform>();
  return {
    flush(stream: Readable | undefined) {
      if (stream) {
        const output = outputPerInput.get(stream);
        buffer.flush((transform) => transform === output);
      } else {
        buffer.flush(() => true);
      }
    },
    clear() {
      buffer.clear();
    },
    destroy() {
      for (const r of this.outputs) {
        r.destroy();
      }
    },
    outputs: inputs.map((input) => {
      const transform = new Transform({
        write(chunk: Buffer, _, callback) {
          buffer.write(chunk, this);
          callback();
        },
      });
      outputPerInput.set(input, transform);
      return input.pipe(transform, { end }) as Readable;
    }) as T,
  };
}

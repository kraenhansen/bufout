import { Readable, Transform } from "node:stream";

type MultiBufferedTransformResult<T extends Readable[]> = {
  /**
   * Flush streams into their respective outputs
   * @param stream filter for a specific stream and drops chunks belonging to other streams.
   */
  flush(only?: Readable): void;
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
};

/**
 * Combines multiple readable streams into a single buffer which can be flushed in order of writes across the streams.
 * I.e. if one stream gets a chunk, the second does and then the first gets another, the order of pushing these into
 * the outputs will be preserved when flushing.
 */
export function createMultiBufferedTransform<T extends Readable[]>(
  inputs: T,
  { end = true }: MultiBufferedTransformOptions = {},
): MultiBufferedTransformResult<T> {
  const buffer: [unknown, Transform][] = [];
  const inputPerOutput = new Map<Transform, Readable>();
  return {
    flush(stream: Readable | undefined) {
      for (const [chunk, transform] of buffer.splice(0, buffer.length)) {
        if (stream && inputPerOutput.get(transform) !== stream) {
          continue;
        }
        transform.push(chunk);
      }
    },
    clear() {
      buffer.splice(0, buffer.length);
    },
    destroy() {
      for (const r of this.outputs) {
        r.destroy();
      }
    },
    outputs: inputs.map((input) => {
      const transform = new Transform({
        write(chunk: Buffer, _, callback) {
          buffer.push([chunk, this]);
          callback();
        },
      });
      inputPerOutput.set(transform, input);
      return input.pipe(transform, { end }) as Readable;
    }) as T,
  };
}

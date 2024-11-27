import assert from "node:assert/strict";
import { Transform } from "node:stream";

/**
 * Creates a transform stream which will add a prefix before every new line of text.
 */
export function createPrefixingTransform(
  prefix: string,
  encoding: NodeJS.BufferEncoding = "utf8",
) {
  let needsPrefix = true;
  return new Transform({
    decodeStrings: true,
    transform(chunk: unknown, _, callback) {
      assert(chunk instanceof Buffer, "Expected chunk to be a Buffer");
      const text = chunk.toString(encoding);
      const lines = text.split("\n");
      const remaining = lines.pop();
      for (const line of lines) {
        if (needsPrefix) {
          this.push(prefix);
          needsPrefix = false;
        }
        this.push(line + "\n");
        needsPrefix = true;
      }
      if (remaining) {
        if (needsPrefix) {
          this.push(prefix);
          needsPrefix = false;
        }
        this.push(remaining);
      }
      callback();
    },
  });
}

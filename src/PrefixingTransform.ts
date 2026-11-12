import assert from "node:assert/strict";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * Creates a transform stream which will add a prefix before every new line of text.
 */
export function createPrefixingTransform(
  prefix: string,
  encoding: NodeJS.BufferEncoding = "utf8",
) {
  let needsPrefix = true;
  // Decodes multi-byte characters split across chunks correctly
  const decoder = new StringDecoder(encoding);
  function pushText(this: Transform, text: string) {
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
  }
  return new Transform({
    decodeStrings: true,
    transform(chunk: unknown, _, callback) {
      assert(chunk instanceof Buffer, "Expected chunk to be a Buffer");
      pushText.call(this, decoder.write(chunk));
      callback();
    },
    flush(callback) {
      // Any incomplete character left at the end
      pushText.call(this, decoder.end());
      callback();
    },
  });
}

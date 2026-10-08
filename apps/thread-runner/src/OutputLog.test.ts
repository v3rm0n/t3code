import { assert, describe, it } from "@effect/vitest";

import { OutputLog } from "./OutputLog.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (chunks: ReadonlyArray<{ readonly data: Uint8Array }>) =>
  chunks.map((chunk) => new TextDecoder().decode(chunk.data)).join("");

describe("OutputLog", () => {
  it("resumes a reader from any offset, including mid-chunk", () => {
    const log = new OutputLog(1024);
    log.append("stdout", bytes("hello "));
    log.append("stderr", bytes("world"));

    const all = log.read(0);
    assert.strictEqual(all.gap, null);
    assert.strictEqual(text(all.chunks), "hello world");
    assert.deepStrictEqual(
      all.chunks.map((chunk) => [chunk.stream, chunk.offset]),
      [
        ["stdout", 0],
        ["stderr", 6],
      ],
    );

    const tail = log.read(8);
    assert.strictEqual(text(tail.chunks), "rld");
    assert.strictEqual(tail.chunks[0]?.offset, 8);
    assert.strictEqual(tail.nextOffset, 11);
    assert.deepStrictEqual(log.read(11).chunks, []);
  });

  it("reports the bytes it dropped once over its limit", () => {
    const log = new OutputLog(8);
    log.append("stdout", bytes("aaaa"));
    log.append("stdout", bytes("bbbb"));
    log.append("stdout", bytes("cccc"));

    assert.strictEqual(log.startOffset, 4);
    const read = log.read(0);
    assert.deepStrictEqual(read.gap, { fromOffset: 0, toOffset: 4 });
    assert.strictEqual(text(read.chunks), "bbbbcccc");
    assert.strictEqual(log.read(6).gap, null);
  });

  it("keeps the tail of a chunk larger than the limit with its true offset", () => {
    const log = new OutputLog(4);
    log.append("stdout", bytes("0123456789"));

    assert.strictEqual(log.endOffset, 10);
    assert.strictEqual(log.startOffset, 6);
    const read = log.read(0);
    assert.deepStrictEqual(read.gap, { fromOffset: 0, toOffset: 6 });
    assert.strictEqual(text(read.chunks), "6789");
  });

  it("stays correct after dropping many small chunks", () => {
    const log = new OutputLog(10);
    for (let index = 0; index < 5_000; index += 1) {
      log.append("stdout", bytes(String(index % 10)));
    }
    assert.strictEqual(log.endOffset, 5_000);
    const read = log.read(4_995);
    assert.strictEqual(text(read.chunks), "56789");
  });
});

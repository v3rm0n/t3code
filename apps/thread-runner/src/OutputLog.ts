/**
 * Bounded, offset-addressed output of one process. Offsets count every byte the
 * process ever produced across stdout and stderr, so a client that reconnects
 * can resume from the last offset it saw. When the retained bytes exceed the
 * limit the oldest chunks are dropped and a reader asking for them gets a gap.
 */
export type OutputStream = "stdout" | "stderr";

export interface OutputChunk {
  readonly stream: OutputStream;
  readonly offset: number;
  readonly data: Uint8Array;
}

export interface OutputRead {
  /** Bytes the reader asked for that are no longer retained. */
  readonly gap: { readonly fromOffset: number; readonly toOffset: number } | null;
  readonly chunks: ReadonlyArray<OutputChunk>;
  readonly nextOffset: number;
}

export class OutputLog {
  readonly #maxBytes: number;
  #chunks: Array<OutputChunk> = [];
  /** Index of the oldest retained chunk; dropped chunks are compacted lazily. */
  #head = 0;
  #retainedBytes = 0;
  #endOffset = 0;

  constructor(maxBytes: number) {
    this.#maxBytes = Math.max(1, maxBytes);
  }

  get endOffset(): number {
    return this.#endOffset;
  }

  get startOffset(): number {
    return this.#chunks[this.#head]?.offset ?? this.#endOffset;
  }

  append(stream: OutputStream, data: Uint8Array): void {
    if (data.byteLength === 0) return;
    const kept =
      data.byteLength > this.#maxBytes ? data.subarray(data.byteLength - this.#maxBytes) : data;
    const offset = this.#endOffset + (data.byteLength - kept.byteLength);
    this.#chunks.push({ stream, offset, data: kept });
    this.#retainedBytes += kept.byteLength;
    this.#endOffset += data.byteLength;
    while (this.#retainedBytes > this.#maxBytes && this.#chunks.length - this.#head > 1) {
      const dropped = this.#chunks[this.#head];
      this.#head += 1;
      if (dropped) this.#retainedBytes -= dropped.data.byteLength;
    }
    if (this.#head > 1024 && this.#head * 2 > this.#chunks.length) {
      this.#chunks = this.#chunks.slice(this.#head);
      this.#head = 0;
    }
  }

  read(fromOffset: number): OutputRead {
    const from = Math.min(Math.max(0, fromOffset), this.#endOffset);
    const start = this.startOffset;
    const gap = from < start ? { fromOffset: from, toOffset: start } : null;
    const chunks: Array<OutputChunk> = [];
    for (let index = this.#firstChunkEndingAfter(from); index < this.#chunks.length; index += 1) {
      const chunk = this.#chunks[index];
      if (!chunk) continue;
      chunks.push(
        chunk.offset >= from
          ? chunk
          : { stream: chunk.stream, offset: from, data: chunk.data.subarray(from - chunk.offset) },
      );
    }
    return { gap, chunks, nextOffset: this.#endOffset };
  }

  #firstChunkEndingAfter(offset: number): number {
    let low = this.#head;
    let high = this.#chunks.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const chunk = this.#chunks[middle];
      if (chunk && chunk.offset + chunk.data.byteLength <= offset) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }
}

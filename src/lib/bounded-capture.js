// A live stdout or stderr capture that keeps its head and tail up to a hard
// cap (why: see MAX_CAPTURED_STREAM_BYTES).

// A worker's stdout is an agent transcript and can run to hundreds of
// megabytes (tool output echoed back by the CLI). Appending every chunk to one
// string eventually throws RangeError: Invalid string length inside the data
// handler, which kills the kernel and, with it, every worker it supervises
// (observed twice on 2026-09-09 with a command-code worker). Nothing reads the
// whole transcript: fatal signatures look at the last 4,000 characters, the
// event decoder consumes chunks as they arrive, and plain-text extraction
// wants the answer, which is never megabytes long. So keep the head and the
// tail of each stream up to a hard cap and count what was dropped.
export const MAX_CAPTURED_STREAM_BYTES = 32 * 1024 * 1024;

export class BoundedCapture {
  constructor(limit = MAX_CAPTURED_STREAM_BYTES) {
    this.limit = Math.max(2, Math.floor(limit));
    this.headLimit = Math.ceil(this.limit / 2);
    this.tailLimit = this.limit - this.headLimit;
    this.headText = '';
    this.tailText = '';
    this.dropped = 0;
    this.total = 0;
  }

  push(chunk) {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    this.total += text.length;
    let rest = text;
    if (this.headText.length < this.headLimit) {
      const room = this.headLimit - this.headText.length;
      if (rest.length <= room) { this.headText += rest; return; }
      this.headText += rest.slice(0, room);
      rest = rest.slice(room);
    }
    if (rest.length >= this.tailLimit) {
      this.dropped += this.tailText.length + (rest.length - this.tailLimit);
      this.tailText = rest.slice(-this.tailLimit);
      return;
    }
    const combined = this.tailText + rest;
    if (combined.length > this.tailLimit) {
      this.dropped += combined.length - this.tailLimit;
      this.tailText = combined.slice(-this.tailLimit);
    } else {
      this.tailText = combined;
    }
  }

  /** The last n characters actually kept (contiguous). */
  tail(n) {
    return this.dropped ? this.tailText.slice(-n) : (this.headText + this.tailText).slice(-n);
  }

  text() {
    if (!this.dropped) return this.headText + this.tailText;
    return `${this.headText}\n…[bullswarm: ${this.dropped} characters of this stream were not kept; ${this.total} total]…\n${this.tailText}`;
  }
}

import { describe, expect, test } from "bun:test";
import { flushWrite, type FlushableStream } from "./stdio";

/** A stream that hands back its completion callback instead of running it. */
function createPendingStream() {
  let complete: ((error?: Error | null) => void) | undefined;
  const written: string[] = [];

  const stream: FlushableStream = {
    write(text, callback) {
      written.push(text);
      complete = callback;
      // A pipe that is already full answers exactly this way.
      return false;
    },
  };

  return {
    stream,
    written,
    finish: (error?: Error) => complete?.(error ?? null),
  };
}

describe("flushWrite", () => {
  test("waits for the stream to report the write completed", async () => {
    const { stream, written, finish } = createPendingStream();
    let settled = false;

    const pending = flushWrite(stream, "payload").then(() => {
      settled = true;
    });

    // The write is queued, not delivered. Treating this moment as done is precisely the bug:
    // a caller that exits here drops everything the pipe could not take.
    await Bun.sleep(1);
    expect(written).toEqual(["payload"]);
    expect(settled).toBe(false);

    finish();
    await pending;
    expect(settled).toBe(true);
  });

  test("propagates a write failure rather than reporting a clean flush", async () => {
    const { stream, finish } = createPendingStream();
    const pending = flushWrite(stream, "payload");

    finish(new Error("EPIPE"));

    expect(pending).rejects.toThrow("EPIPE");
  });

  test("skips the write entirely for empty text", async () => {
    const { stream, written } = createPendingStream();

    // Nothing completes this stream's writes, so reaching the callback at all would hang.
    await flushWrite(stream, "");

    expect(written).toEqual([]);
  });
});

/** The one stream capability this module needs, so a test double is a one-method object. */
export interface FlushableStream {
  write(text: string, callback: (error?: Error | null) => void): boolean;
}

/**
 * Write one payload to a stream and resolve only once the OS has accepted all of it.
 *
 * A pipe accepts one buffer before it blocks — 64 KiB on the platforms Hunk runs on — so a
 * larger payload leaves a remainder queued in userspace. `write` reports success for that
 * remainder because it is queued, not written, and `process.exit` discards it. Awaiting the
 * write callback is what turns "queued" into "the reader has it".
 */
export async function flushWrite(stream: FlushableStream, text: string): Promise<void> {
  if (text.length === 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    stream.write(text, (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Emit one headless command's output and end the process.
 *
 * Every command that prints a payload and exits goes through here rather than pairing
 * `write` with `process.exit` itself: the truncation that pairing causes is silent — the
 * exit code stays 0 and the output simply stops mid-token — so it has to be impossible to
 * reintroduce by writing the obvious two lines.
 */
export async function exitAfterWriting(
  text: string,
  code = 0,
  stream: FlushableStream = process.stdout,
): Promise<never> {
  await flushWrite(stream, text);

  return process.exit(code);
}

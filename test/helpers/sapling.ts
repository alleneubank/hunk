/** Detect a real Sapling CLI rather than an unrelated executable named `sl`. */
export async function hasSaplingCli(timeoutMs = 1_000) {
  let processHandle: Bun.Subprocess;
  try {
    processHandle = Bun.spawn(["sl", "version"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return false;
  }

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    processHandle.kill();
  }, timeoutMs);
  timeout.unref?.();

  try {
    const stdoutStream = processHandle.stdout;
    const stderrStream = processHandle.stderr;
    if (!(stdoutStream instanceof ReadableStream) || !(stderrStream instanceof ReadableStream)) {
      processHandle.kill();
      return false;
    }

    const [exitCode, stdout, stderr] = await Promise.all([
      processHandle.exited,
      new Response(stdoutStream).text(),
      new Response(stderrStream).text(),
    ]);
    return !timedOut && exitCode === 0 && /sapling/i.test(`${stdout}\n${stderr}`);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

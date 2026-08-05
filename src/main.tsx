#!/usr/bin/env bun

import { formatCliError } from "./core/errors";
import { pagePlainText } from "./core/pager";
import { prepareStartupPlan } from "./app/startup";
import { exitAfterWriting, flushWrite } from "./lib/stdio";
import { sanitizeTerminalText } from "./lib/terminalText";
import { serveSessionBrokerDaemon } from "./session/broker/brokerServer";
import { runSessionCommand } from "./session/agent/commands";

async function main() {
  const startupPlan = await prepareStartupPlan();

  if (startupPlan.kind === "help") {
    await exitAfterWriting(startupPlan.text);
  }

  if (startupPlan.kind === "daemon-serve") {
    const server = serveSessionBrokerDaemon();
    await server.stopped;
    return;
  }

  if (startupPlan.kind === "session-command") {
    await exitAfterWriting(await runSessionCommand(startupPlan.input));
  }

  if (startupPlan.kind === "markup-guide") {
    const { runMarkupGuideCommand } = await import("./ui/lib/stml/cli");
    const guide: string[] = [];
    const code = runMarkupGuideCommand({
      stdout: (text) => {
        guide.push(text);
      },
    });

    await exitAfterWriting(guide.join(""), code);
  }

  if (startupPlan.kind === "markup-render") {
    const { runMarkupRenderCommand } = await import("./ui/lib/stml/cli");
    // Collected rather than written through: the command emits its payload before it knows
    // its exit code, and only a completed write may be followed by an exit.
    const rendered: string[] = [];
    const diagnostics: string[] = [];
    const code = await runMarkupRenderCommand(startupPlan.input, {
      stdout: (text) => {
        rendered.push(text);
      },
      stderr: (text) => {
        diagnostics.push(text);
      },
      stdoutIsTTY: Boolean(process.stdout.isTTY),
      readStdinText: () => new Response(Bun.stdin.stream()).text(),
    });

    await flushWrite(process.stderr, diagnostics.join(""));
    await exitAfterWriting(rendered.join(""), code);
  }

  if (startupPlan.kind === "review-command") {
    const { formatReviewResult, runReviewCommand } = await import("./app/reviewCommand");
    await exitAfterWriting(formatReviewResult(await runReviewCommand(startupPlan.input)));
  }

  if (startupPlan.kind === "plain-text-pager") {
    await pagePlainText(startupPlan.text);
    process.exit(0);
  }

  if (startupPlan.kind === "passthrough") {
    await exitAfterWriting(sanitizeTerminalText(startupPlan.text));
  }

  if (startupPlan.kind === "static-diff-pager") {
    const { renderStaticDiffPager } = await import("./ui/staticDiffPager");
    await exitAfterWriting(
      await renderStaticDiffPager(startupPlan.text, startupPlan.options, {
        customThemes: startupPlan.customThemes,
        stderr: process.stderr,
      }),
    );
  }

  if (startupPlan.kind !== "app") {
    throw new Error("Unreachable startup plan.");
  }

  // OpenTUI stays behind the interactive plan so headless commands never
  // materialize its embedded native library.
  const { runInteractiveApp } = await import("./ui/runInteractiveApp");
  await runInteractiveApp(startupPlan);
}

await main().catch(async (error) => {
  // `hunk review` is a machine-facing surface, and a client should not have to parse two
  // error formats depending on how early the failure happened — a bad flag and a missing
  // repo both reach it as the same JSON envelope.
  if (process.argv[2] === "review") {
    const { formatReviewError } = await import("./app/reviewCommand");
    await exitAfterWriting(formatReviewError(error), 1, process.stderr);
  }

  await exitAfterWriting(formatCliError(error), 1, process.stderr);
});

#!/usr/bin/env bun

import { formatCliError } from "./core/run/errors";
import { pagePlainText } from "./core/process/pager";
import { prepareStartupPlan } from "./app/startup";
import { sanitizeTerminalText } from "./lib/terminalText";
import { serveSessionBrokerDaemon } from "./session/broker/brokerServer";
import { runSessionCommand } from "./session/agent/commands";
import { disposeHighlightWorker } from "./ui/diff/worker";
import { exitAfterWriting, flushWrite } from "./lib/stdio";

async function main() {
  const startupPlan = await prepareStartupPlan();

  if (startupPlan.kind === "help") {
    process.stdout.write(startupPlan.text);
    process.exit(0);
  }

  if (startupPlan.kind === "daemon-serve") {
    const server = serveSessionBrokerDaemon();
    await server.stopped;
    return;
  }

  if (startupPlan.kind === "session-command") {
    process.stdout.write(await runSessionCommand(startupPlan.input));
    process.exit(0);
  }

  if (startupPlan.kind === "extension-manage") {
    const [{ runExtensionManageCommand }, readline] = await Promise.all([
      import("./extensions/manage/cli"),
      import("node:readline/promises"),
    ]);
    // A confirmation needs a real terminal on both sides; piped runs use --yes.
    const canConfirm = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
    process.exit(
      await runExtensionManageCommand(startupPlan.input, {
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
        confirm: canConfirm
          ? async (question) => {
              const prompt = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
              });
              try {
                const answer = await prompt.question(question);
                return ["y", "yes"].includes(answer.trim().toLowerCase());
              } finally {
                prompt.close();
              }
            }
          : undefined,
      }),
    );
  }

  if (startupPlan.kind === "review-command") {
    const { formatReviewError, formatReviewResult, runReviewCommand } =
      await import("./app/reviewCommand");
    try {
      await exitAfterWriting(formatReviewResult(await runReviewCommand(startupPlan.input)));
    } catch (error) {
      await flushWrite(process.stderr, formatReviewError(error));
      process.exit(1);
    }
  }

  if (startupPlan.kind === "markup-guide") {
    const { runMarkupGuideCommand } = await import("./ui/lib/stml/cli");
    process.exit(runMarkupGuideCommand({ stdout: (text) => process.stdout.write(text) }));
  }

  if (startupPlan.kind === "markup-render") {
    const { runMarkupRenderCommand } = await import("./ui/lib/stml/cli");
    process.exit(
      await runMarkupRenderCommand(startupPlan.input, {
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
        stdoutIsTTY: Boolean(process.stdout.isTTY),
        readStdinText: () => new Response(Bun.stdin.stream()).text(),
      }),
    );
  }

  if (startupPlan.kind === "plain-text-pager") {
    await pagePlainText(startupPlan.text);
    process.exit(0);
  }

  if (startupPlan.kind === "passthrough") {
    process.stdout.write(
      sanitizeTerminalText(startupPlan.text, { preserveAnsiStyle: startupPlan.preserveColor }),
    );
    process.exit(0);
  }

  if (startupPlan.kind === "static-diff-pager") {
    const { renderStaticDiffPager } = await import("./ui/staticDiffPager");
    process.stdout.write(
      await renderStaticDiffPager(startupPlan.text, startupPlan.options, {
        customThemes: startupPlan.customThemes,
        stderr: process.stderr,
      }),
    );
    process.exit(0);
  }

  if (startupPlan.kind !== "app") {
    throw new Error("Unreachable startup plan.");
  }

  // OpenTUI stays behind the interactive plan so headless commands never materialize its embedded
  // native library. The highlighting client starts the compiled worker only when an opted-in,
  // eligible large diff needs it, so normal sessions do not pay its startup cost.
  try {
    const { runInteractiveApp } = await import("./ui/runInteractiveApp");
    await runInteractiveApp(startupPlan);
  } finally {
    disposeHighlightWorker();
  }
}

await main().catch(async (error) => {
  // Headless `hunk review` callers parse stderr as JSON; a text stack there looks like
  // "the review is empty" once they fail to decode it.
  if (process.argv[2] === "review") {
    const { formatReviewError } = await import("./app/reviewCommand");
    await flushWrite(process.stderr, formatReviewError(error));
  } else {
    process.stderr.write(formatCliError(error));
  }
  process.exit(1);
});

import { z } from "incur";
import { createChromeExtensionService } from "../composition/chromeExtension.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import type { ChromeExtensionOperation } from "../application/extensions/ChromeExtensionService.js";

/** Thin terminal adapters retain the same extension scopes, errors and Evidence as MCP. */
export const registerChromeExtensionCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  const service = createChromeExtensionService();
  const run = (
    name: string,
    operation: ChromeExtensionOperation,
    input: unknown,
  ) =>
    withCommandCancellation((signal) =>
      logCliCommand(logger, name, async () => {
        const result = await service.execute(operation, input, {
          signal,
          progress: {
            report: async (update) => {
              process.stderr.write(
                `${JSON.stringify({ rea_progress: update })}\n`,
              );
            },
          },
        });
        return result.ok ? result.value : projectAnalysisError(result.error);
      }),
    );
  cli.command(CLI_COMMANDS.traceChromeExtensionContentScript, {
    description:
      "Observe isolated-world content-script execution and webpage interactions",
    args: z.object({
      cdp_endpoint: z.string(),
      extension_id: z.string(),
      target_id: z.string(),
    }),
    options: z.object({
      observationMs: z.number().int().min(250).max(30000).default(5000),
    }),
    run: ({ args, options }) =>
      run(
        CLI_COMMANDS.traceChromeExtensionContentScript,
        "trace_chrome_extension_content_script",
        { ...args, observation_ms: options.observationMs },
      ),
  });
  cli.command(CLI_COMMANDS.inspectChromeExtension, {
    description:
      "Inspect an unpacked extension, ZIP or CRX package without execution",
    args: z.object({ path: z.string() }),
    run: ({ args }) =>
      run(CLI_COMMANDS.inspectChromeExtension, "inspect_chrome_extension", {
        path: absoluteCallerPath(args.path),
      }),
  });
  cli.command(CLI_COMMANDS.listChromeExtensionContexts, {
    description:
      "Find already-running CDP contexts for one exact Chrome extension ID",
    args: z.object({ cdp_endpoint: z.string(), extension_id: z.string() }),
    run: ({ args }) =>
      run(
        CLI_COMMANDS.listChromeExtensionContexts,
        "list_chrome_extension_contexts",
        args,
      ),
  });
  cli.command(CLI_COMMANDS.inspectChromeExtensionContext, {
    description:
      "Snapshot loaded sources in one exact extension worker or page target",
    args: z.object({
      cdp_endpoint: z.string(),
      extension_id: z.string(),
      target_id: z.string(),
    }),
    run: ({ args }) =>
      run(
        CLI_COMMANDS.inspectChromeExtensionContext,
        "inspect_chrome_extension_context",
        args,
      ),
  });
};

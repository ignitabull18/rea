import { Cli, z } from "incur";
import { createWebApiCaptureService } from "../composition/webApiCapture.js";
import { createWebRuntimeService } from "../composition/webRuntime.js";
import { browserCliError } from "../cliBrowserContext.js";
import {
  browserScopeOptions,
  observationDuration,
} from "../cliObservationOptions.js";
import { logCliCommand } from "../cliLogging.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import type { Logger } from "pino";
import type { ProgressReporter } from "../application/ProgressReporter.js";
import { withCommandCancellation } from "./commandCancellation.js";

/** CLI progress exposes the actual armed point on stderr without corrupting JSON results. */
const runtimeProgress: ProgressReporter = {
  report: async (update) => {
    process.stderr.write(`${JSON.stringify({ rea_progress: update })}\n`);
  },
};

/** Register public equivalents of the two modular website runtime tools. */
export const registerWebRuntimeCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.observeWebApi, {
    description:
      "Capture API response values from an existing tab while browsing",
    args: z.object({ endpoint: z.string(), targetId: z.string() }),
    options: z.object({
      ...browserScopeOptions,
      observationMs: z.number().int().min(250).max(30000).default(5000),
      urlContains: z.string().optional(),
      includeRequestBody: z.boolean().default(false),
      maxRequests: z.number().int().min(1).max(1000).default(100),
      maxBodyBytes: z.number().int().min(1).max(2097152).default(262144),
      maxTotalBodyBytes: z.number().int().min(1).max(8388608).default(2097152),
      sensitiveValues: z.array(z.string()).default([]),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.observeWebApi, async () => {
          const result = await createWebApiCaptureService().observe(
            {
              cdp_endpoint: args.endpoint,
              target_id: args.targetId,
              allowed_origins: options.allowedOrigins,
              observation_ms: options.observationMs,
              url_contains: options.urlContains,
              include_request_body: options.includeRequestBody,
              max_requests: options.maxRequests,
              max_body_bytes: options.maxBodyBytes,
              max_total_body_bytes: options.maxTotalBodyBytes,
              sensitive_values: options.sensitiveValues,
            },
            { signal, progress: runtimeProgress },
          );
          return result.ok ? result.value : browserCliError(result.error);
        }),
      ),
  });
  cli.command(CLI_COMMANDS.observeWebExecution, {
    description:
      "Observe precise page execution; resets counters and temporarily disables optimization",
    args: z.object({
      endpoint: z.string().describe("Existing loopback browser CDP endpoint"),
      targetId: z
        .string()
        .describe("Selected page target ID from list-browser-targets"),
    }),
    options: z.object({
      ...browserScopeOptions,
      observationMs: observationDuration(10_000, 1),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, "observe-web-execution", async () => {
          const result = await createWebRuntimeService().observe(
            {
              cdp_endpoint: args.endpoint,
              target_id: args.targetId,
              allowed_origins: options.allowedOrigins,
              observation_ms: options.observationMs,
            },
            { progress: runtimeProgress, signal },
          );
          return result.ok ? result.value : browserCliError(result.error);
        }),
      ),
  });
  cli.command(CLI_COMMANDS.inspectWebEventListeners, {
    description:
      "Inspect native listener source locations on the first main-document CSS match",
    args: z.object({
      endpoint: z.string().describe("Existing loopback browser CDP endpoint"),
      targetId: z
        .string()
        .describe("Selected page target ID from list-browser-targets"),
      selector: z
        .string()
        .describe("Native CSS selector; inspect the first main-document match"),
    }),
    options: z.object({ ...browserScopeOptions }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, "inspect-web-event-listeners", async () => {
          const result = await createWebRuntimeService().inspect(
            {
              cdp_endpoint: args.endpoint,
              target_id: args.targetId,
              selector: args.selector,
              allowed_origins: options.allowedOrigins,
            },
            { signal },
          );
          return result.ok ? result.value : browserCliError(result.error);
        }),
      ),
  });
};

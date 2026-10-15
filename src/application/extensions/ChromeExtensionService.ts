import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { ChromeExtensionPort } from "./ChromeExtensionPort.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { digestCanonicalValue } from "../../domain/canonicalDigest.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  chromeExtensionReportSchema,
  extensionContextListSchema,
  extensionContextInspectionSchema,
  inspectChromeExtensionInputSchema,
  listChromeExtensionContextsInputSchema,
  inspectChromeExtensionContextInputSchema,
} from "../../domain/extensions/chromeExtension.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { CHROME_EXTENSION_PROVIDER_IDENTITY } from "../../domain/extensions/chromeExtension.js";

const identity = CHROME_EXTENSION_PROVIDER_IDENTITY;
export type ChromeExtensionOperation =
  | "inspect_chrome_extension"
  | "list_chrome_extension_contexts"
  | "inspect_chrome_extension_context";

/** Validate public requests and bind observations to one shared CLI/MCP Evidence contract. */
export class ChromeExtensionService {
  constructor(readonly provider: ChromeExtensionPort) {}

  async execute(
    operation: ChromeExtensionOperation,
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    try {
      if (options?.signal?.aborted)
        return err(new AnalysisCancelledError(operation));
      let report;
      let parameters;
      if (operation === "inspect_chrome_extension") {
        const parsed = inspectChromeExtensionInputSchema.safeParse(rawInput);
        if (!parsed.success)
          return err(
            analysisInputErrorFromIssues(
              operation,
              parsed.error.issues,
              rawInput,
            ),
          );
        parameters = parsed.data;
        report = chromeExtensionReportSchema.parse(
          await this.provider.inspectPackage(parsed.data, options),
        );
      } else if (operation === "list_chrome_extension_contexts") {
        const parsed =
          listChromeExtensionContextsInputSchema.safeParse(rawInput);
        if (!parsed.success)
          return err(
            analysisInputErrorFromIssues(
              operation,
              parsed.error.issues,
              rawInput,
            ),
          );
        parameters = parsed.data;
        report = extensionContextListSchema.parse(
          await this.provider.listContexts(parsed.data, options),
        );
      } else {
        const parsed =
          inspectChromeExtensionContextInputSchema.safeParse(rawInput);
        if (!parsed.success)
          return err(
            analysisInputErrorFromIssues(
              operation,
              parsed.error.issues,
              rawInput,
            ),
          );
        parameters = parsed.data;
        report = extensionContextInspectionSchema.parse(
          await this.provider.inspectContext(parsed.data, options),
        );
      }
      if (options?.signal?.aborted)
        return err(new AnalysisCancelledError(operation));
      if (Buffer.byteLength(JSON.stringify(report)) > 32 * 1024 * 1024)
        return err(
          new AnalysisResourceConstraintError(
            operation,
            "transport",
            "Complete extension report exceeds the 32 MiB inline budget",
            { maximum_output_bytes: 32 * 1024 * 1024 },
          ),
        );
      const target =
        "artifact" in report
          ? {
              path: report.artifact.path,
              sha256: report.artifact.sha256,
              format:
                report.artifact.format === "directory"
                  ? ("directory" as const)
                  : ("zip" as const),
            }
          : {
              path: `chrome-extension://${report.extension_id}/`,
              sha256: digestCanonicalValue(report),
              format: "javascript" as const,
            };
      return ok(
        createEvidence(target, identity, {
          operation,
          parameters,
          result: report,
          confidence: "observed",
          limitations: report.limitations,
        }),
      );
    } catch (cause) {
      if (cause instanceof AnalysisError) return err(cause);
      if (options?.signal?.aborted)
        return err(new AnalysisCancelledError(operation));
      return err(
        new ProviderAdapterError(identity.id, operation, {
          cause,
          diagnostics: {
            reason: cause instanceof Error ? cause.message : String(cause),
          },
        }),
      );
    }
  }
}

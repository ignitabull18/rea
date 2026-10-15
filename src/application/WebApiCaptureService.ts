import { browserObservationEndpointSchema } from "../domain/browserObservation.js";
import type { ExecutionOptions } from "./AnalysisProvider.js";
import type { WebApiCapturePort } from "./WebApiCapturePort.js";
import {
  observeWebApiInputSchema,
  webApiCaptureSchema,
} from "../domain/webApiCapture.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { redactExplicitFailure } from "../domain/explicitSensitiveFailure.js";
import { redactExplicitText } from "../domain/explicitSensitiveValues.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { err, ok, type Result } from "../domain/result.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";

/** Validate once and retain the same API evidence through CLI and MCP. */
export class WebApiCaptureService {
  constructor(readonly provider: WebApiCapturePort) {}
  async observe(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const operation = "observe_web_api";
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const parsed = observeWebApiInputSchema.safeParse(rawInput);
    if (!parsed.success)
      return err(
        analysisInputErrorFromIssues(operation, parsed.error.issues, undefined),
      );
    const input = parsed.data;
    const result = await this.provider.capture(input, options);
    if (!result.ok)
      return err(redactExplicitFailure(result.error, input.sensitive_values));
    const report = webApiCaptureSchema.safeParse(result.value);
    if (!report.success)
      return err(
        new AnalysisOutputError(operation, "Malformed API capture output"),
      );
    if (
      report.data.target.target_id !== input.target_id ||
      report.data.window.requested_ms !== input.observation_ms
    )
      return err(
        new AnalysisOutputError(
          operation,
          "API provider changed the selected target or observation window",
        ),
      );
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    if (Buffer.byteLength(JSON.stringify(report.data)) > 32 * 1024 * 1024)
      return err(
        new AnalysisResourceConstraintError(
          operation,
          "transport",
          "API report exceeds 32 MiB",
          null,
        ),
      );
    const { sensitive_values, url_contains, ...parameters } = input;
    const safeParameters = {
      ...parameters,
      cdp_endpoint: redactExplicitText(
        browserObservationEndpointSchema.parse(input.cdp_endpoint).recorded,
        sensitive_values,
      ),
      target_id: redactExplicitText(input.target_id, sensitive_values),
      allowed_origins: input.allowed_origins.map((origin) =>
        redactExplicitText(origin, sensitive_values),
      ),
      ...(url_contains === undefined
        ? {}
        : {
            url_contains: redactExplicitText(url_contains, sensitive_values),
          }),
      sensitive_value_count: sensitive_values.length,
    };
    const redact = (value: string): string =>
      redactExplicitText(value, sensitive_values);
    const safeReport = {
      ...report.data,
      target: {
        ...report.data.target,
        target_id: redact(report.data.target.target_id),
        frame_id: redact(report.data.target.frame_id),
        loader_id:
          report.data.target.loader_id === null
            ? null
            : redact(report.data.target.loader_id),
      },
      transactions: report.data.transactions.map((row) => ({
        ...row,
        request_id: redact(row.request_id),
      })),
    };
    if (!webApiCaptureSchema.safeParse(safeReport).success)
      return err(
        new AnalysisOutputError(
          operation,
          "Explicit sensitive-value exclusions prevent a valid API result identity",
        ),
      );
    return ok(
      createEvidence(undefined, this.provider.identity(), {
        operation,
        parameters: safeParameters,
        result: safeReport,
        confidence: "observed",
        authority: "external-service",
        limitations: report.data.limitations,
      }),
    );
  }
}

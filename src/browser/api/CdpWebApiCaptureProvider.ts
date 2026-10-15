import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import type { WebApiCapturePort } from "../../application/WebApiCapturePort.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { BrowserObservationError } from "../../domain/browserObservationError.js";
import { analysisErrorWithCleanupFailure } from "../../domain/analysisErrorCleanup.js";
import {
  webApiCaptureSchema,
  type WebApiCapture,
  type ObserveWebApiInput,
} from "../../domain/webApiCapture.js";
import { err, ok, type Result } from "../../domain/result.js";
import { CDP_BROWSER_PROVIDER_IDENTITY } from "../providerIdentities.js";
import { cdpTargetEventMatches } from "../CdpTargetEvents.js";
import { CdpRuntimeSession } from "../execution/CdpRuntimeSession.js";
import { CdpExecutionWindow } from "../execution/CdpExecutionWindow.js";
import { CdpApiTransactions } from "./CdpApiTransactions.js";

const operation = "observe_web_api";
const limitations = [
  "Only Fetch/XHR requests begun in the armed window, from the selected main frame and allowed origins, are selected. Existing earlier requests, iframe/OOPIF requests, worker-only traffic, WebSockets and browser-internal traffic are outside coverage. url_contains is a literal filter.",
  "Response bodies come only from Network.getResponseBody for the exact observed CDP request ID after loadingFinished. No request is replayed or refetched. Chrome may evict or not expose a body; unavailability is explicit. Bytes are browser-decoded representations, not compressed wire bytes.",
  "Existing browser cookies/session are used by the page normally. REA does not navigate, click, evaluate scripts, inject hooks, pause/modify requests or read cookie/authorization headers. Headers are not retained. JSON/text response values and ordinary URL query values are retained; URL userinfo and caller-declared literal sensitive_values are removed.",
  "Request bodies are optional and limited to postData exposed by CDP; absence does not prove no upload. Multipart file bytes may be omitted. Explicit sensitive_values redaction is literal UTF-8 text only; binary bodies are omitted when such redaction is requested.",
  "Pending responses at cutoff are marked unfinished; REA drains only body reads admitted for requests already finished in the window. Navigation/reload or disconnect invalidates capture. Request/byte-budget omissions remain explicit and make coverage partial. Response JSON is returned as readable UTF-8 text; binary content is base64.",
];
const failure = (cause: unknown): AnalysisError =>
  cause instanceof AnalysisError
    ? cause
    : new AnalysisOutputError(
        operation,
        cause instanceof Error ? cause.message : String(cause),
      );
/** Passive selected-tab API content capture through the existing owned CDP lifecycle. */
export class CdpWebApiCaptureProvider implements WebApiCapturePort {
  identity() {
    return CDP_BROWSER_PROVIDER_IDENTITY;
  }
  async capture(
    input: ObserveWebApiInput,
    options: ExecutionOptions = {},
  ): Promise<Result<WebApiCapture, AnalysisError>> {
    let session: CdpRuntimeSession | undefined;
    let result: Result<WebApiCapture, AnalysisError>;
    try {
      session = await CdpRuntimeSession.open(input, operation, options);
      result = ok(await this.observe(session, input));
    } catch (cause) {
      result = err(failure(cause));
    }
    if (session) {
      try {
        const cleanup = await session.close(
          result.ok ? undefined : result.error,
        );
        if (cleanup)
          return err(
            result.ok
              ? cleanup
              : analysisErrorWithCleanupFailure(
                  result.error,
                  cleanup,
                  operation,
                ),
          );
      } catch (cause) {
        return err(
          result.ok
            ? failure(cause)
            : analysisErrorWithCleanupFailure(
                result.error,
                failure(cause),
                operation,
              ),
        );
      }
    }
    return result;
  }
  private async observe(
    session: CdpRuntimeSession,
    input: ObserveWebApiInput,
  ): Promise<WebApiCapture> {
    const window = new CdpExecutionWindow(session);
    let observedFailure: unknown;
    const fail = (cause: unknown): void => {
      observedFailure ??= cause;
      window.fail(failure(cause));
    };
    const transactions = new CdpApiTransactions(session, input, fail);
    const stops = [
      session.transport.connection.onEvent((event) => {
        if (!cdpTargetEventMatches(event, session.transport.sessionId)) return;
        try {
          window.ingest(event);
          if (window.active) transactions.ingest(event);
          else if (
            window.reason === "document_changed" ||
            window.reason === "target_terminated"
          )
            fail(new BrowserObservationError(operation, "target_changed"));
        } catch (cause) {
          fail(cause);
        }
      }),
      session.transport.connection.onDisconnect(fail),
      session.transport.connection.onProtocolFailure(fail),
    ];
    try {
      if (session.target.loader_id === null)
        throw new BrowserObservationError(operation, "target_not_allowed", {
          detail:
            "API capture requires a loaded main document with a loader ID",
        });
      await session.enable("Page");
      session.enabledDomains.push("Network");
      await session.command("Network.enable", {
        maxTotalBufferSize: input.max_total_body_bytes,
        maxResourceBufferSize: input.max_body_bytes,
        maxPostDataSize: input.include_request_body ? input.max_body_bytes : 0,
      });
      await session.assertDocument();
      window.check();
      const waiting = window.start(input.observation_ms);
      void waiting.catch(() => undefined);
      await session.options.progress?.report({
        phase: "web_api",
        completed: 1,
        total: 2,
        message: "API capture armed; browse or perform the webpage action now",
      });
      const reason = await waiting;
      if (reason !== "window_elapsed")
        throw new BrowserObservationError(operation, "target_changed");
      session.beginCompletion();
      await transactions.finish();
      await session.assertDocument();
      if (observedFailure) throw observedFailure;
      const target = {
        ...session.target,
        initial_url: transactions.text(session.target.initial_url),
        origin: transactions.text(session.target.origin),
      };
      const partial =
        transactions.requestOmissions > 0 ||
        transactions.rows.some(
          (row) =>
            row.response_body.state === "unavailable" ||
            (input.include_request_body &&
              row.request_body.state === "unavailable"),
        );
      return webApiCaptureSchema.parse({
        target,
        window: {
          armed_at: window.armedAt!,
          ended_at: window.endedAt!,
          requested_ms: input.observation_ms,
        },
        transactions: transactions.rows,
        coverage: {
          state: partial ? "partial" : "complete-within-window",
          excluded_requests: transactions.excludedRequests,
          request_limit_omissions: transactions.requestOmissions,
        },
        limitations,
      });
    } finally {
      transactions.cancel();
      window.dispose();
      for (const stop of stops) stop();
    }
  }
}

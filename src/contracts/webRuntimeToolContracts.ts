import {
  observeWebApiInputSchema,
  webApiCaptureSchema,
} from "../domain/webApiCapture.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import {
  observeWebExecutionInputSchema,
  webExecutionSchema,
} from "../domain/webExecution.js";
import {
  inspectWebEventListenersInputSchema,
  webEventListenersSchema,
} from "../domain/webEventListeners.js";

/** Native website runtime primitives distinguish instrumentation from listener inspection. */
export const WEB_RUNTIME_TOOL_CONTRACTS = [
  {
    name: "observe_web_api",
    ...toolContractMetadata("observe_web_api"),
    kind: "browser-provider",
    description:
      "Passively capture actual API response values from Fetch/XHR requests in an already-open signed-in page. Select a loopback CDP endpoint and exact target ID; current page origin is the default scope, with optional allowed_origins and literal url_contains. Wait for armed progress, then browse normally using separate controls. Returns request IDs/redirect hops, method, URL, status, MIME/cache/worker metadata and readable UTF-8 response bodies (base64 for binary), byte counts and digests. Optional include_request_body retains only CDP-exposed postData. Reads Network.getResponseBody for exact completed requests; never replays/refetches URLs, navigates, clicks, injects code, pauses or modifies requests. Headers/cookies are not retained; declared literal sensitive_values are excluded from retained text. New requests only; main frame only; workers/WebSockets/iframes and earlier requests outside coverage. Navigation or disconnect fails closed. Budgets default to 100 requests, 256 KiB/body and 2 MiB total; omissions and unavailable bodies remain explicit. This is read-only response capture, not request editing or an official API integration.",
    inputSchema: observeWebApiInputSchema,
    outputSchema: evidenceResultOf(webApiCaptureSchema),
    examples: [
      {
        title: "Read selected API responses while browsing",
        input: {
          cdp_endpoint: "http://127.0.0.1:9222",
          target_id: "TARGET_ID_FROM_LIST_BROWSER_TARGETS",
          url_contains: "/api/",
          observation_ms: 10000,
        },
      },
    ],
  },
  {
    name: "observe_web_execution",
    ...toolContractMetadata("observe_web_execution"),
    description:
      "Instrument one selected CDP page for a finite, externally driven precise coverage window. Resets execution counters and prevents optimized execution until stopped. Returns complete nested UTF-16 ranges/counts, independently hashed script text and request initiator associations by session script ID. Does not navigate, click, evaluate selected code or close the externally owned page. Navigation ends document-scoped collection; workers and UI causality remain outside this claim. Emits an actual armed progress notification before external actions.",
    kind: "browser-provider",
    inputSchema: observeWebExecutionInputSchema,
    outputSchema: evidenceResultOf(webExecutionSchema),
    examples: [
      {
        title: "Attribute externally triggered page execution",
        input: {
          cdp_endpoint: "http://127.0.0.1:9222",
          target_id: "TARGET_ID_FROM_LIST_BROWSER_TARGETS",
          observation_ms: 10_000,
        },
      },
    ],
  },
  {
    name: "inspect_web_event_listeners",
    ...toolContractMetadata("inspect_web_event_listeners"),
    description:
      "Inspect listeners registered directly on the first main-document CSS match in one selected CDP page. Returns event flags, native callback locations, source ownership and exact script text/digests inline. Does not dispatch events, evaluate JavaScript or invoke handlers. Delegated ancestor/framework listeners and execution history remain unknown. Releases REA's object group and transport, preserving the external page.",
    kind: "browser-provider",
    inputSchema: inspectWebEventListenersInputSchema,
    outputSchema: evidenceResultOf(webEventListenersSchema),
    examples: [
      {
        title: "Find a selected button's callback source",
        input: {
          cdp_endpoint: "http://127.0.0.1:9222",
          target_id: "TARGET_ID_FROM_LIST_BROWSER_TARGETS",
          selector: "#submit",
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];

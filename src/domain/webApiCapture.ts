import { z } from "zod";
import { createHash } from "node:crypto";
import { browserObservationEndpointSchema } from "./browserObservation.js";
import { webRuntimeScopeSchema, webRuntimeTargetSchema } from "./webRuntime.js";

/** Passive content selection for one already-open authenticated page. */
export const observeWebApiInputSchema = webRuntimeScopeSchema.extend({
  cdp_endpoint: browserObservationEndpointSchema.transform(
    (endpoint) => endpoint.url,
  ),
  observation_ms: z.number().int().min(250).max(30000).default(5000),
  url_contains: z.string().min(1).max(2048).optional(),
  include_request_body: z.boolean().default(false),
  max_requests: z.number().int().min(1).max(1000).default(100),
  max_body_bytes: z.number().int().min(1).max(2097152).default(262144),
  max_total_body_bytes: z.number().int().min(1).max(8388608).default(2097152),
  sensitive_values: z.array(z.string().min(1).max(4096)).max(256).default([]),
});
export const webApiBodySchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("captured"),
    encoding: z.enum(["utf8", "base64"]),
    content: z.string(),
    bytes: z.number().int().nonnegative(),
    sha256: z.string(),
    redacted: z.boolean(),
  }),
  z.strictObject({
    state: z.literal("unavailable"),
    reason: z.enum([
      "not_requested",
      "not_exposed",
      "pending",
      "unfinished",
      "request_failed",
      "redirect",
      "body_not_retained",
      "body_size_limit",
      "total_body_limit",
      "binary_redaction_unavailable",
    ]),
  }),
]);
export const webApiTransactionSchema = z.strictObject({
  transaction_id: z.number().int().nonnegative(),
  request_id: z.string(),
  redirect_from_transaction_id: z.number().int().nonnegative().nullable(),
  url: z.string(),
  method: z.string(),
  resource_type: z.string(),
  timestamp: z.number(),
  status: z.number().nullable(),
  response_url: z.string().nullable(),
  mime_type: z.string().nullable(),
  from_service_worker: z.boolean().nullable(),
  from_disk_cache: z.boolean().nullable(),
  request_body: webApiBodySchema,
  response_body: webApiBodySchema,
});
export const webApiCaptureSchema = z
  .strictObject({
    target: webRuntimeTargetSchema,
    window: z.strictObject({
      armed_at: z.string(),
      ended_at: z.string(),
      requested_ms: z.number(),
    }),
    transactions: z.array(webApiTransactionSchema),
    coverage: z.strictObject({
      state: z.enum(["complete-within-window", "partial"]),
      excluded_requests: z.number().int().nonnegative(),
      request_limit_omissions: z.number().int().nonnegative(),
    }),
    limitations: z.array(z.string()),
  })
  .superRefine((report, context) => {
    for (const [index, transaction] of report.transactions.entries()) {
      for (const field of ["request_body", "response_body"] as const) {
        const body = transaction[field];
        if (body.state === "unavailable") {
          if (body.reason === "pending")
            context.addIssue({
              code: "custom",
              path: ["transactions", index, field],
              message: "Completed API capture contains pending content",
            });
          continue;
        }
        const bytes = Buffer.from(
          body.content,
          body.encoding === "utf8" ? "utf8" : "base64",
        );
        if (
          (body.encoding === "base64" &&
            bytes.toString("base64") !== body.content) ||
          bytes.length !== body.bytes ||
          createHash("sha256").update(bytes).digest("hex") !== body.sha256
        )
          context.addIssue({
            code: "custom",
            path: ["transactions", index, field],
            message: "API body bytes or digest disagree with retained content",
          });
      }
    }
  });
export type ObserveWebApiInput = z.infer<typeof observeWebApiInputSchema>;
export type WebApiCapture = z.infer<typeof webApiCaptureSchema>;
export type WebApiTransaction = z.infer<typeof webApiTransactionSchema>;
export type WebApiBody = z.infer<typeof webApiBodySchema>;

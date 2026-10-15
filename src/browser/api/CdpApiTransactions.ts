import { z } from "zod";
import type { CdpEvent } from "../CdpConnection.js";
import { CdpCommandRejection } from "../CdpCommandRejection.js";
import type { CdpRuntimeSession } from "../execution/CdpRuntimeSession.js";
import type {
  ObserveWebApiInput,
  WebApiTransaction,
} from "../../domain/webApiCapture.js";
import { sanitizeBrowserUrl } from "../../domain/browserObservation.js";
import { redactExplicitText } from "../../domain/explicitSensitiveValues.js";
import {
  AnalysisOutputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { CdpApiBodies } from "./CdpApiBodies.js";

const responseSchema = z.object({
  url: z.string(),
  status: z.number(),
  mimeType: z.string(),
  fromDiskCache: z.boolean().optional(),
  fromServiceWorker: z.boolean().optional(),
});
const requestSchema = z.object({
  requestId: z.string(),
  frameId: z.string().optional(),
  type: z.string().optional(),
  timestamp: z.number(),
  request: z.object({
    url: z.string(),
    method: z.string(),
    postData: z.string().optional(),
  }),
  redirectResponse: responseSchema.optional(),
});
const responseEventSchema = z.object({
  requestId: z.string(),
  response: responseSchema,
});

/** Associate exact CDP request IDs and redirect hops; queued body reads never replay a URL. */
export class CdpApiTransactions {
  readonly rows: WebApiTransaction[] = [];
  readonly current = new Map<string, WebApiTransaction>();
  readonly bodies: CdpApiBodies;
  readonly reads = new Set<Promise<void>>();
  readonly queue: WebApiTransaction[] = [];
  excludedRequests = 0;
  requestOmissions = 0;
  metadataBytes = 0;
  eventCount = 0;
  failure: unknown;
  closed = false;
  constructor(
    readonly session: CdpRuntimeSession,
    readonly input: ObserveWebApiInput,
    readonly fail: (error: unknown) => void,
  ) {
    this.bodies = new CdpApiBodies(input);
  }
  text(value: string): string {
    return redactExplicitText(value, this.input.sensitive_values);
  }
  allowed(url: string): boolean {
    const origin = sanitizeBrowserUrl(url).origin;
    return origin !== null && this.session.allowedOrigins.has(origin);
  }
  ingest(event: CdpEvent): void {
    if (!event.method.startsWith("Network.")) return;
    if (++this.eventCount > 10000)
      throw new AnalysisResourceConstraintError(
        "observe_web_api",
        "memory",
        "API capture exceeds 10,000 network events",
        null,
      );
    if (event.method === "Network.requestWillBeSent")
      this.request(event.params);
    else if (event.method === "Network.responseReceived") {
      const data = responseEventSchema.parse(event.params);
      const row = this.current.get(data.requestId);
      if (row) this.response(row, data.response);
    } else if (
      event.method === "Network.loadingFinished" ||
      event.method === "Network.loadingFailed"
    ) {
      const { requestId } = z
        .object({ requestId: z.string() })
        .parse(event.params);
      const row = this.current.get(requestId);
      if (
        !row ||
        row.response_body.state !== "unavailable" ||
        row.response_body.reason !== "pending"
      )
        return;
      if (event.method === "Network.loadingFailed")
        row.response_body = { state: "unavailable", reason: "request_failed" };
      else if (row.status === null)
        row.response_body = { state: "unavailable", reason: "not_exposed" };
      else {
        this.queue.push(row);
        this.pump();
      }
    }
  }
  private request(params: unknown): void {
    const data = requestSchema.parse(params);
    const previous = this.current.get(data.requestId);
    this.current.delete(data.requestId);
    if (previous) {
      if (!data.redirectResponse)
        throw new AnalysisOutputError(
          "observe_web_api",
          "CDP request ID reused without redirect linkage",
        );
      this.response(previous, data.redirectResponse);
      previous.response_body = { state: "unavailable", reason: "redirect" };
    }
    if (
      data.frameId !== this.session.target.frame_id ||
      !["Fetch", "XHR"].includes(data.type ?? "") ||
      !this.allowed(data.request.url) ||
      (this.input.url_contains !== undefined &&
        !data.request.url.includes(this.input.url_contains))
    ) {
      this.excludedRequests++;
      return;
    }
    if (this.rows.length >= this.input.max_requests) {
      this.requestOmissions++;
      return;
    }
    const row: WebApiTransaction = {
      transaction_id: this.rows.length,
      request_id: data.requestId,
      redirect_from_transaction_id: previous?.transaction_id ?? null,
      url: this.text(sanitizeBrowserUrl(data.request.url).url),
      method: this.text(data.request.method),
      resource_type: data.type!,
      timestamp: data.timestamp,
      status: null,
      response_url: null,
      mime_type: null,
      from_service_worker: null,
      from_disk_cache: null,
      request_body: {
        state: "unavailable",
        reason: this.input.include_request_body
          ? "not_exposed"
          : "not_requested",
      },
      response_body: { state: "unavailable", reason: "pending" },
    };
    const cost = Buffer.byteLength(JSON.stringify(row));
    if (cost + this.metadataBytes > 2 * 1024 * 1024)
      throw new AnalysisResourceConstraintError(
        "observe_web_api",
        "memory",
        "API metadata exceeds 2 MiB",
        null,
      );
    this.metadataBytes += cost;
    if (this.input.include_request_body && data.request.postData !== undefined)
      row.request_body = this.bodies.retain(data.request.postData, false);
    this.rows.push(row);
    this.current.set(data.requestId, row);
  }
  private response(
    row: WebApiTransaction,
    data: z.infer<typeof responseSchema>,
  ): void {
    const url = this.text(sanitizeBrowserUrl(data.url).url);
    const mime = this.text(data.mimeType);
    const cost = Buffer.byteLength(url) + Buffer.byteLength(mime);
    if (cost + this.metadataBytes > 2 * 1024 * 1024)
      throw new AnalysisResourceConstraintError(
        "observe_web_api",
        "memory",
        "API response metadata exceeds 2 MiB",
        null,
      );
    this.metadataBytes += cost;
    row.status = data.status;
    row.response_url = url;
    row.mime_type = mime;
    row.from_disk_cache = data.fromDiskCache ?? null;
    row.from_service_worker = data.fromServiceWorker ?? null;
    if (!this.allowed(data.url))
      row.response_body = { state: "unavailable", reason: "not_exposed" };
  }
  private pump(): void {
    while (!this.closed && this.reads.size < 4 && this.queue.length > 0) {
      const row = this.queue.shift()!;
      const job = this.read(row)
        .catch((cause) => {
          this.failure ??= cause;
          this.fail(cause);
        })
        .finally(() => {
          this.reads.delete(job);
          this.pump();
        });
      this.reads.add(job);
    }
  }
  private async read(row: WebApiTransaction): Promise<void> {
    try {
      const result = z
        .object({ body: z.string(), base64Encoded: z.boolean() })
        .parse(
          await this.session.command("Network.getResponseBody", {
            requestId: row.request_id,
          }),
        );
      if (this.current.get(row.request_id) !== row) {
        row.response_body = { state: "unavailable", reason: "redirect" };
        return;
      }
      row.response_body = this.bodies.retain(result.body, result.base64Encoded);
    } catch (cause) {
      if (!(cause instanceof CdpCommandRejection)) throw cause;
      row.response_body = { state: "unavailable", reason: "body_not_retained" };
    }
  }
  cancel(): void {
    this.closed = true;
    this.queue.length = 0;
  }
  async finish(): Promise<void> {
    while (this.reads.size > 0) await Promise.all(this.reads);
    if (this.failure) throw this.failure;
    for (const row of this.rows)
      if (
        row.response_body.state === "unavailable" &&
        row.response_body.reason === "pending"
      )
        row.response_body = { state: "unavailable", reason: "unfinished" };
  }
}

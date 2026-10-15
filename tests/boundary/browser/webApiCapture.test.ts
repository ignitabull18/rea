import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { CdpApiBodies } from "../../../src/browser/api/CdpApiBodies.js";
import { observeWebApiInputSchema } from "../../../src/domain/webApiCapture.js";
import { WebApiCaptureService } from "../../../src/application/WebApiCaptureService.js";
import { ok } from "../../../src/domain/result.js";
import { createWebApiCaptureService } from "../../../src/composition/webApiCapture.js";
const input = (extra: Record<string, unknown> = {}) =>
  observeWebApiInputSchema.parse({
    cdp_endpoint: "http://127.0.0.1:9222",
    target_id: "page",
    ...extra,
  });
describe("passive API body fidelity and independent budgets", () => {
  it("retains readable JSON values and exact UTF-8 bytes including BOM", () => {
    const body = new CdpApiBodies(input()).retain('\ufeff{"total":137}', false);
    expect(body.state).toBe("captured");
    if (body.state !== "captured") return;
    expect(body.content).toBe('\ufeff{"total":137}');
    expect(body.sha256).toBe(
      createHash("sha256").update(body.content).digest("hex"),
    );
    expect(body.bytes).toBe(Buffer.byteLength(body.content));
  });
  it("keeps binary bytes as base64 and rejects malformed producer encodings", () => {
    const collector = new CdpApiBodies(input());
    const result = collector.retain(
      Buffer.from([255, 0, 128]).toString("base64"),
      true,
    );
    expect(result.state).toBe("captured");
    if (result.state === "captured") {
      expect(result.encoding).toBe("base64");
      expect(result.content).toBe("/wCA");
    }
    expect(() => collector.retain("not_base64", true)).toThrow("Malformed");
  });
  it("redacts declared literals before hashing and omits binary when text redaction cannot be guaranteed", () => {
    const collector = new CdpApiBodies(
      input({ sensitive_values: ["private"] }),
    );
    const result = collector.retain('{"data":"private"}', false);
    expect(result.state).toBe("captured");
    if (result.state === "captured") {
      expect(result.redacted).toBe(true);
      expect(result.content).not.toContain("private");
      expect(result.sha256).toBe(
        createHash("sha256").update(result.content).digest("hex"),
      );
    }
    expect(collector.retain("/wCA", true)).toEqual({
      state: "unavailable",
      reason: "binary_redaction_unavailable",
    });
  });
  it("bounds each body and the aggregate rather than silently truncating content", () => {
    const collector = new CdpApiBodies(
      input({ max_body_bytes: 4, max_total_body_bytes: 6 }),
    );
    expect(collector.retain("12345", false)).toEqual({
      state: "unavailable",
      reason: "body_size_limit",
    });
    expect(collector.retain("1234", false).state).toBe("captured");
    expect(collector.retain("abc", false)).toEqual({
      state: "unavailable",
      reason: "total_body_limit",
    });
    expect(collector.retainedBytes).toBe(4);
  });
  it("accounts for redaction expansion before retaining bytes", () => {
    const collector = new CdpApiBodies(
      input({ sensitive_values: ["x"], max_body_bytes: 1 }),
    );
    expect(collector.retain("x", false)).toEqual({
      state: "unavailable",
      reason: "body_size_limit",
    });
    expect(collector.retainedBytes).toBe(0);
  });
  it("validates scope and cancellation before contacting the browser", async () => {
    const service = createWebApiCaptureService();
    expect(
      (
        await service.observe({
          cdp_endpoint: "https://example.com",
          target_id: "page",
        })
      ).ok,
    ).toBe(false);
    expect(
      (await service.observe({ ...input(), observation_ms: 30001 })).ok,
    ).toBe(false);
    expect(
      (await service.observe(input(), { signal: AbortSignal.abort() })).ok,
    ).toBe(false);
  });
});

it("excludes marked identifiers from the complete persisted Evidence after validating raw target identity", async () => {
  const service = new WebApiCaptureService({
    identity: () => ({ id: "fixture", name: "fixture", version: "1" }),
    capture: async () =>
      ok({
        target: {
          target_id: "target-secret",
          frame_id: "frame-secret",
          loader_id: "loader-secret",
          origin: "http://localhost",
          initial_url: "http://localhost/",
        },
        window: {
          armed_at: "2026-10-15T00:00:00Z",
          ended_at: "2026-10-15T00:00:01Z",
          requested_ms: 5000,
        },
        transactions: [
          {
            transaction_id: 0,
            request_id: "request-secret",
            redirect_from_transaction_id: null,
            url: "http://localhost/api",
            method: "GET",
            resource_type: "Fetch",
            timestamp: 1,
            status: 200,
            response_url: "http://localhost/api",
            mime_type: "application/json",
            from_service_worker: false,
            from_disk_cache: false,
            request_body: { state: "unavailable", reason: "not_requested" },
            response_body: {
              state: "unavailable",
              reason: "body_not_retained",
            },
          },
        ],
        coverage: {
          state: "partial",
          excluded_requests: 0,
          request_limit_omissions: 0,
        },
        limitations: [],
      }),
  });
  const sensitive_values = [
    "target-secret",
    "frame-secret",
    "loader-secret",
    "request-secret",
  ];
  const result = await service.observe({
    ...input(),
    target_id: "target-secret",
    sensitive_values,
  });
  expect(result.ok).toBe(true);
  for (const value of sensitive_values)
    expect(JSON.stringify(result)).not.toContain(value);
});

import { describe, it, expect } from "vitest";
import { ChromeExtensionTraceCollection } from "../../../src/extensions/ChromeExtensionTraceCollection.js";
import { createChromeExtensionService } from "../../../src/composition/chromeExtension.js";
const id = "abcdefghijklmnopabcdefghijklmnop";
const world = (
  origin = `chrome-extension://${id}`,
  isDefault = false,
  frameId = "main",
) => ({
  method: "Runtime.executionContextCreated",
  params: {
    context: {
      id: 3,
      origin,
      uniqueId: "unique-context",
      auxData: { isDefault, type: "isolated", frameId },
    },
  },
});
const script = {
  method: "Debugger.scriptParsed",
  params: {
    scriptId: "7",
    url: `chrome-extension://${id}/spoof.js`,
    executionContextId: 3,
    startLine: 0,
    startColumn: 0,
    endLine: 0,
    endColumn: 20,
  },
};
describe("content-script producer ownership and bounded attribution", () => {
  it.each([
    [`chrome-extension://${id}`, true, "main"],
    ["http://localhost", false, "main"],
    [`chrome-extension://${id}`, false, "child"],
    [`chrome-extension://${"b".repeat(32)}`, false, "main"],
  ])(
    "excludes foreign/default/subframe worlds even when script URL labels name the extension",
    (origin, isDefault, frameId) => {
      const collection = new ChromeExtensionTraceCollection(id, "main");
      collection.ingest(world(origin, isDefault, frameId));
      collection.ingest(script);
      expect(collection.owns("7")).toBe(false);
    },
  );
  it("attributes only a top synchronous stack in the exact world/frame, without request payloads or DOM values", () => {
    const collection = new ChromeExtensionTraceCollection(id, "main");
    collection.ingest(world());
    collection.ingest(script);
    collection.active = true;
    const frame = {
      scriptId: "7",
      url: "untrusted-label",
      lineNumber: 1,
      columnNumber: 2,
      functionName: "action",
    };
    const request = {
      requestId: "request",
      frameId: "main",
      timestamp: 1,
      request: {
        url: "http://user:password@localhost/probe?value=kept",
        method: "POST",
        headers: { secret: "omitted" },
        postData: "omitted",
      },
      initiator: { type: "script", stack: { callFrames: [frame] } },
    };
    collection.ingest({ method: "Network.requestWillBeSent", params: request });
    collection.ingest({
      method: "Network.requestWillBeSent",
      params: {
        ...request,
        initiator: {
          type: "script",
          stack: { callFrames: [], parent: { callFrames: [frame] } },
        },
      },
    });
    collection.ingest({
      method: "DOM.attributeModified",
      params: { nodeId: 10, name: "data-test", value: "private-value" },
    });
    expect(collection.requests).toHaveLength(1);
    expect(collection.requests[0]?.url).toBe(
      "http://localhost/probe?value=kept",
    );
    expect(collection.unattributedRequests).toBe(1);
    expect(JSON.stringify(collection.requests)).not.toContain("omitted");
    expect(JSON.stringify(collection.domChanges)).not.toContain(
      "private-value",
    );
  });
  it("rejects replacement contexts, malformed events and source ranges beyond exact retained text", () => {
    const collection = new ChromeExtensionTraceCollection(id, "main");
    collection.ingest(world());
    collection.ingest(script);
    expect(() => collection.ingest(world())).toThrow("reused");
    expect(() =>
      collection.ingest({
        method: "Runtime.executionContextDestroyed",
        params: { executionContextId: 3 },
      }),
    ).toThrow("destroyed");
    expect(() =>
      collection.ingest({ method: "Debugger.scriptParsed", params: {} }),
    ).toThrow();
    expect(() =>
      collection.coverage(
        {
          timestamp: 1,
          result: [
            {
              scriptId: "7",
              url: "label",
              functions: [
                {
                  functionName: "action",
                  isBlockCoverage: true,
                  ranges: [{ startOffset: 0, endOffset: 10, count: 1 }],
                },
              ],
            },
          ],
        },
        new Map([["7", { source: "short", sha256: "hash" }]]),
      ),
    ).toThrow("bounds");
  });
  it("does not retroactively assign older scripts when a world appears later", () => {
    const collection = new ChromeExtensionTraceCollection(id, "main");
    collection.ingest(script);
    collection.ingest(world());
    expect(collection.owns("7")).toBe(false);
    expect(() => collection.ingest(world("http://localhost", true))).toThrow(
      "reused",
    );
  });
  it("bounds retained metadata independently of protocol event count", () => {
    const collection = new ChromeExtensionTraceCollection(id, "main");
    expect(() =>
      collection.ingest({
        ...script,
        params: { ...script.params, url: "x".repeat(8 * 1024 * 1024) },
      }),
    ).toThrow("metadata");
    expect(collection.scripts.size).toBe(0);
  });
  it("rejects invalid trace scopes before connecting", async () => {
    const service = createChromeExtensionService();
    for (const observation_ms of [0, 30001, 1.5])
      expect(
        (
          await service.execute("trace_chrome_extension_content_script", {
            cdp_endpoint: "http://127.0.0.1:9222",
            extension_id: id,
            target_id: "page",
            observation_ms,
          })
        ).ok,
      ).toBe(false);
  });
});

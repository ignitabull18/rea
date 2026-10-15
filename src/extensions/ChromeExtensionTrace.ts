import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import {
  openCdpEndpoint,
  openCdpTargetSession,
  type CdpTargetSession,
} from "../browser/CdpTargetSession.js";
import {
  runtimeFrameTreeSchema,
  preciseCoverageSchema,
} from "../browser/execution/CdpRuntimeProtocol.js";
import {
  browserObservationEndpointSchema,
  sanitizeBrowserUrl,
} from "../domain/browserObservation.js";
import type {
  ExtensionContentTrace,
  TraceChromeExtensionContentScriptInput,
} from "../domain/extensions/chromeExtension.js";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { extensionDigest } from "./ExtensionPackageReader.js";
import { extensionFailure } from "./ExtensionFailure.js";
import { ChromeExtensionTraceCollection } from "./ChromeExtensionTraceCollection.js";

const OPERATION = "trace_chrome_extension_content_script";
const LIMIT = 16 * 1024 * 1024;
const limitations = [
  "Ownership uses CDP isolated execution-world origin, non-default flag and exact main-frame ID. Source URLs are untrusted labels; hashes bind observed source text, not authenticated package files.",
  "Only main-frame isolated-world JavaScript is covered. MAIN-world injections, iframe/OOPIF content scripts, WebAssembly, workers, browser APIs and message payloads are outside this trace. Empty coverage does not establish extension absence or inactivity outside the window.",
  "Precise coverage counts preserve nested function/block ranges in UTF-16 code units with exclusive end offsets; overlapping ranges must not be summed. Coverage records execution during instrumentation, not a full call timeline. Producer coverage timestamps bound counters; wall-clock armed/ended markers bound streamed events and may differ by command latency.",
  "Requests require the top synchronous initiator frame to belong to the selected world and the request to name the selected main frame. Indirect, asynchronous-only and unattributed requests are excluded. Headers, cookies and bodies are not retained; URLs (including query values) are retained except transport credentials.",
  "DOM changes are concurrent page observations with unknown causality, not proof the extension caused them. DOM events can include materialized same-process child frames. Node IDs are session-local; DOM values/text and node subtrees are not retained. Changes below unmaterialized DOM/shadow trees may be absent.",
  "REA enables Debugger, Runtime, Page, DOM, Network and Profiler on its own connection. Precise coverage affects JIT optimization and timing. REA does not inject/evaluate code, click, navigate, reload, or start/stop extension workers. Trigger actions separately after armed progress.",
];

/** Scope one instrumented observation to an existing page and one immutable main document. */
class ContentTraceSession {
  readonly domains: string[] = [];
  precise = false;
  constructor(
    readonly session: CdpTargetSession,
    readonly input: TraceChromeExtensionContentScriptInput,
    readonly signal: AbortSignal,
  ) {}
  command(method: string, params: Record<string, unknown> = {}) {
    return this.session.connection.send(
      method,
      params,
      this.session.sessionId,
      this.signal,
    );
  }
  async enable(domain: string): Promise<void> {
    this.domains.push(domain);
    await this.command(`${domain}.enable`);
  }
  async frame() {
    const frame = runtimeFrameTreeSchema.parse(
      await this.command("Page.getFrameTree"),
    ).frameTree.frame;
    if (!frame.loaderId || !/^https?:\/\//u.test(frame.url))
      throw new ArtifactReaderFailure(
        "path",
        "Content tracing requires an already-loaded HTTP(S) main document with a loader ID",
      );
    return { url: frame.url, frame_id: frame.id, loader_id: frame.loaderId };
  }
  async verify(
    expected: Awaited<ReturnType<ContentTraceSession["frame"]>>,
  ): Promise<void> {
    const current = await this.frame();
    const { targetInfo } = z
      .object({
        targetInfo: z.object({
          targetId: z.string(),
          type: z.string(),
          url: z.string(),
        }),
      })
      .parse(
        await this.session.connection.send(
          "Target.getTargetInfo",
          { targetId: this.input.target_id },
          undefined,
          this.signal,
        ),
      );
    if (
      JSON.stringify(current) !== JSON.stringify(expected) ||
      targetInfo.targetId !== this.input.target_id ||
      targetInfo.type !== "page" ||
      targetInfo.url !== expected.url
    )
      throw new ArtifactReaderFailure(
        "integrity",
        "Selected webpage identity changed during content tracing",
      );
  }
  async sources(collection: ChromeExtensionTraceCollection) {
    const sources = new Map<string, { source: string; sha256: string }>();
    let bytes = 0;
    for (const script of [...collection.scripts.values()]) {
      if (!collection.owns(script.scriptId)) continue;
      const { scriptSource } = z.object({ scriptSource: z.string() }).parse(
        await this.command("Debugger.getScriptSource", {
          scriptId: script.scriptId,
        }),
      );
      bytes += Buffer.byteLength(scriptSource);
      if (bytes > LIMIT)
        throw new ArtifactReaderFailure(
          "limit",
          "Content-script source exceeds 16 MiB",
        );
      sources.set(script.scriptId, {
        source: scriptSource,
        sha256: extensionDigest(scriptSource),
      });
    }
    return sources;
  }
  async close(primaryFailure: unknown): Promise<void> {
    const signal = AbortSignal.timeout(5000);
    const failures: unknown[] = [];
    const cleanup = async (
      method: string,
      params: Record<string, unknown> = {},
      sessionId = this.session.sessionId,
    ) => {
      try {
        await this.session.connection.send(method, params, sessionId, signal);
      } catch (cause) {
        failures.push(cause);
      }
    };
    if (this.precise) await cleanup("Profiler.stopPreciseCoverage");
    for (const domain of this.domains.toReversed())
      await cleanup(`${domain}.disable`);
    if (this.session.sessionId !== undefined) {
      try {
        await this.session.connection.send(
          "Target.detachFromTarget",
          { sessionId: this.session.sessionId },
          undefined,
          signal,
        );
      } catch (cause) {
        failures.push(cause);
      }
    }
    try {
      await this.session.connection.close();
    } catch (cause) {
      failures.push(cause);
    }
    if (!failures.length) return;
    const failure = new ProviderCleanupError(
      "chrome-extension",
      [this.input.target_id],
      {
        reason: "Content-script instrumentation cleanup could not be confirmed",
      },
      { cause: failures[0], operation: OPERATION },
    );
    throw primaryFailure === undefined
      ? failure
      : analysisErrorWithCleanupFailure(
          extensionFailure(OPERATION, primaryFailure, this.signal),
          failure,
          OPERATION,
        );
  }
}

/** Bounded live observation; the caller performs interactions using separate controls after progress arming. */
export const traceExtensionContentScript = async (
  input: TraceChromeExtensionContentScriptInput,
  options?: ExecutionOptions,
): Promise<ExtensionContentTrace> => {
  const signal = AbortSignal.any([
    ...(options?.signal ? [options.signal] : []),
    AbortSignal.timeout(50000),
  ]);
  const opened = await openCdpEndpoint(
    browserObservationEndpointSchema.parse(input.cdp_endpoint),
    OPERATION,
    signal,
  );
  const target = opened.discovery.targets.find(
    (item) =>
      item.id === input.target_id &&
      item.type === "page" &&
      /^https?:\/\//u.test(item.url),
  );
  await opened.connection?.close();
  if (!target)
    throw new ArtifactReaderFailure(
      "path",
      "Selected target is missing or is not an HTTP(S) webpage",
    );
  const session = new ContentTraceSession(
    await openCdpTargetSession(opened.discovery, target, OPERATION, signal, {
      maxPayloadBytes: LIMIT,
    }),
    input,
    signal,
  );
  let primaryFailure: unknown;
  let observationFailure: unknown;
  const failed = new AbortController();
  const fail = (cause: unknown): void => {
    observationFailure ??= cause;
    failed.abort();
  };
  const stops: (() => void)[] = [];
  try {
    const page = await session.frame();
    const collection = new ChromeExtensionTraceCollection(
      input.extension_id,
      page.frame_id,
    );
    stops.push(
      session.session.connection.onEvent((event) => {
        if (event.sessionId !== session.session.sessionId) return;
        try {
          collection.ingest(event);
        } catch (cause) {
          fail(cause);
        }
      }),
      session.session.connection.onDisconnect(fail),
      session.session.connection.onProtocolFailure(fail),
    );
    for (const domain of [
      "Page",
      "Runtime",
      "Debugger",
      "DOM",
      "Network",
      "Profiler",
    ])
      await session.enable(domain);
    await session.command("DOM.getDocument", { depth: -1, pierce: false });
    await session.verify(page);
    if (observationFailure) throw observationFailure;
    session.precise = true;
    const started = z.object({ timestamp: z.number() }).parse(
      await session.command("Profiler.startPreciseCoverage", {
        callCount: true,
        detailed: true,
        allowTriggeredUpdates: false,
      }),
    );
    if (observationFailure) throw observationFailure;
    const armedAt = new Date().toISOString();
    collection.active = true;
    const waiting = delay(input.observation_ms, undefined, {
      signal: AbortSignal.any([signal, failed.signal]),
    });
    void waiting.catch(() => undefined);
    await options?.progress?.report({
      phase: "extension_content_trace",
      completed: 1,
      total: 2,
      message: "Content-script trace armed; perform the webpage action now",
    });
    await waiting;
    const raw = preciseCoverageSchema.parse(
      await session.command("Profiler.takePreciseCoverage"),
    );
    collection.active = false;
    const endedAt = new Date().toISOString();
    await session.command("Profiler.stopPreciseCoverage");
    session.precise = false;
    const sources = await session.sources(collection);
    await session.verify(page);
    if (observationFailure) throw observationFailure;
    return {
      cdp_endpoint: input.cdp_endpoint,
      extension_id: input.extension_id,
      target_id: input.target_id,
      page: { ...page, url: sanitizeBrowserUrl(page.url).url },
      window: {
        armed_at: armedAt,
        ended_at: endedAt,
        requested_ms: input.observation_ms,
        coverage_started_timestamp: started.timestamp,
        coverage_ended_timestamp: raw.timestamp,
      },
      contexts: [...collection.contexts.values()],
      scripts: collection.coverage(raw, sources),
      requests: collection.requests.filter(
        (request) =>
          request.timestamp >= started.timestamp &&
          request.timestamp <= raw.timestamp,
      ),
      dom_changes: collection.domChanges,
      excluded_script_count: [...collection.scripts.keys()].filter(
        (id) => !collection.owns(id),
      ).length,
      unattributed_request_count: collection.unattributedRequests,
      limitations,
    };
  } catch (cause) {
    primaryFailure = observationFailure ?? cause;
    throw primaryFailure;
  } finally {
    for (const stop of stops) stop();
    await session.close(primaryFailure);
  }
};

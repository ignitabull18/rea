import { z } from "zod";
import type { CdpEvent } from "../browser/CdpConnection.js";
import {
  runtimeContextSchema,
  runtimeScriptParsedSchema,
  runtimeRequestSchema,
  runtimeStackSchema,
  preciseCoverageSchema,
} from "../browser/execution/CdpRuntimeProtocol.js";
import type { ExtensionContentTrace } from "../domain/extensions/chromeExtension.js";
import { sanitizeBrowserUrl } from "../domain/browserObservation.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";

const domMethods = new Set([
  "DOM.attributeModified",
  "DOM.attributeRemoved",
  "DOM.childNodeInserted",
  "DOM.childNodeRemoved",
  "DOM.characterDataModified",
]);
const domSchema = z.object({
  nodeId: z.number().optional(),
  parentNodeId: z.number().optional(),
  name: z.string().optional(),
  node: z
    .object({ nodeId: z.number(), nodeName: z.string().optional() })
    .optional(),
});

/** Own the join from producer execution worlds to scripts; sourceURL labels confer no authority. */
export class ChromeExtensionTraceCollection {
  readonly contexts = new Map<
    number,
    ExtensionContentTrace["contexts"][number]
  >();
  readonly scripts = new Map<
    string,
    Pick<
      z.infer<typeof runtimeScriptParsedSchema>,
      "scriptId" | "url" | "executionContextId" | "scriptLanguage"
    > & { contextUniqueId: string | null }
  >();
  readonly seenContexts = new Set<number>();
  readonly requests: ExtensionContentTrace["requests"] = [];
  readonly domChanges: ExtensionContentTrace["dom_changes"] = [];
  unattributedRequests = 0;
  active = false;
  eventCount = 0;
  retainedBytes = 0;
  private retain<T>(value: T): T {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (this.retainedBytes + bytes > 8 * 1024 * 1024)
      throw new ArtifactReaderFailure(
        "limit",
        "Content trace metadata exceeds the 8 MiB retained budget",
      );
    this.retainedBytes += bytes;
    return value;
  }
  constructor(
    readonly extensionId: string,
    readonly frameId: string,
  ) {}

  ingest(event: CdpEvent): void {
    if (++this.eventCount > 10000)
      throw new ArtifactReaderFailure(
        "limit",
        "Content trace exceeds 10,000 protocol events",
      );
    if (event.method === "Runtime.executionContextCreated") {
      const context = runtimeContextSchema.parse(event.params).context;
      if (this.seenContexts.has(context.id))
        throw new ArtifactReaderFailure(
          "integrity",
          "Execution context ID was reused during tracing",
        );
      this.seenContexts.add(this.retain(context.id));
      if (
        context.origin === `chrome-extension://${this.extensionId}` &&
        context.auxData?.isDefault === false &&
        context.auxData.type === "isolated" &&
        context.auxData.frameId === this.frameId &&
        context.uniqueId
      ) {
        this.contexts.set(
          context.id,
          this.retain({
            id: context.id,
            unique_id: context.uniqueId,
            origin: context.origin,
            frame_id: this.frameId,
          }),
        );
      }
    } else if (event.method === "Debugger.scriptParsed") {
      const script = runtimeScriptParsedSchema.parse(event.params);
      this.scripts.set(
        script.scriptId,
        this.retain({
          scriptId: script.scriptId,
          url: script.url,
          executionContextId: script.executionContextId,
          contextUniqueId:
            this.contexts.get(script.executionContextId)?.unique_id ?? null,
          ...(script.scriptLanguage === undefined
            ? {}
            : { scriptLanguage: script.scriptLanguage }),
        }),
      );
    } else if (event.method === "Runtime.executionContextDestroyed") {
      const destroyed = z
        .object({ executionContextId: z.number() })
        .parse(event.params);
      if (this.contexts.has(destroyed.executionContextId))
        throw new ArtifactReaderFailure(
          "integrity",
          "Selected content-script context was destroyed",
        );
    } else if (
      [
        "Runtime.executionContextsCleared",
        "Debugger.globalObjectCleared",
        "Inspector.detached",
        "Inspector.targetCrashed",
      ].includes(event.method)
    ) {
      throw new ArtifactReaderFailure(
        "integrity",
        "Webpage execution contexts changed during content tracing",
      );
    } else if (event.method === "Page.frameNavigated") {
      const { frame } = z
        .object({ frame: z.object({ id: z.string() }) })
        .parse(event.params);
      if (frame.id === this.frameId)
        throw new ArtifactReaderFailure(
          "integrity",
          "Selected webpage navigated during content tracing",
        );
    } else if (event.method === "Page.frameDetached") {
      const { frameId } = z.object({ frameId: z.string() }).parse(event.params);
      if (frameId === this.frameId)
        throw new ArtifactReaderFailure(
          "integrity",
          "Selected webpage frame detached during content tracing",
        );
    } else if (this.active && event.method === "Network.requestWillBeSent")
      this.request(event.params);
    else if (this.active && domMethods.has(event.method)) {
      const change = domSchema.parse(event.params);
      this.domChanges.push(
        this.retain({
          method: event.method,
          node_id: change.nodeId ?? change.node?.nodeId ?? null,
          parent_node_id: change.parentNodeId ?? null,
          attribute_name: change.name ?? null,
          node_name: change.node?.nodeName ?? null,
        }),
      );
    }
  }

  owns(scriptId: string): boolean {
    const script = this.scripts.get(scriptId);
    return (
      script !== undefined &&
      script.scriptLanguage !== "WebAssembly" &&
      script.contextUniqueId !== null &&
      this.contexts.get(script.executionContextId)?.unique_id ===
        script.contextUniqueId
    );
  }

  private request(params: unknown): void {
    const request = runtimeRequestSchema.parse(params);
    // Only a direct synchronous stack frame is an attribution. URL labels and async parents are insufficient.
    const stack = runtimeStackSchema.safeParse(request.initiator.stack);
    const initiator =
      stack.success && request.frameId === this.frameId
        ? stack.data.callFrames[0]
        : undefined;
    if (!initiator || !this.owns(initiator.scriptId)) {
      this.unattributedRequests++;
      return;
    }
    this.requests.push(
      this.retain({
        request_id: request.requestId,
        url: sanitizeBrowserUrl(request.request.url).url,
        method: request.request.method,
        timestamp: request.timestamp,
        initiator_script_id: initiator.scriptId,
        line_number: initiator.lineNumber,
        column_number: initiator.columnNumber,
      }),
    );
  }

  coverage(
    raw: unknown,
    sources: Map<string, { source: string; sha256: string }>,
  ): ExtensionContentTrace["scripts"] {
    const coverage = preciseCoverageSchema.parse(raw);
    return coverage.result
      .filter((script) => this.owns(script.scriptId))
      .map((script) => {
        const metadata = this.scripts.get(script.scriptId)!;
        const retained = sources.get(script.scriptId);
        if (!retained)
          throw new ArtifactReaderFailure(
            "integrity",
            "Coverage source is missing from the retained content-script inventory",
          );
        return {
          script_id: script.scriptId,
          execution_context_id: metadata.executionContextId,
          reported_url: sanitizeBrowserUrl(metadata.url).url,
          ...retained,
          functions: script.functions.map((fn) => ({
            name: fn.functionName,
            is_block_coverage: fn.isBlockCoverage,
            ranges: fn.ranges.map((range) => {
              if (
                range.endOffset < range.startOffset ||
                range.endOffset > retained.source.length
              )
                throw new ArtifactReaderFailure(
                  "integrity",
                  "Content-script coverage is outside retained UTF-16 source bounds",
                );
              return {
                start_offset: range.startOffset,
                end_offset: range.endOffset,
                count: range.count,
              };
            }),
          })),
        };
      });
  }
}

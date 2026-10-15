import { z } from "zod";
import {
  openCdpEndpoint,
  openCdpTargetSession,
} from "../browser/CdpTargetSession.js";
import type { CdpEndpointTarget } from "../browser/CdpEndpoint.js";
import type { CdpTargetSession } from "../browser/CdpTargetSession.js";
import { browserObservationEndpointSchema } from "../domain/browserObservation.js";
import type {
  ExtensionContextInspection,
  ExtensionContextList,
  ListChromeExtensionContextsInput,
  InspectChromeExtensionContextInput,
} from "../domain/extensions/chromeExtension.js";
import { extensionDigest } from "./ExtensionPackageReader.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { extensionFailure } from "./ExtensionFailure.js";

const OPERATION = "inspect_chrome_extension_context";
const LIMIT = 16 * 1024 * 1024;
const scriptSchema = z.object({
  scriptId: z.string(),
  url: z.string(),
  scriptLanguage: z.string().optional(),
});
const sameExtension = (url: string, id: string): boolean => {
  const parsed = URL.parse(url);
  return (
    parsed !== null &&
    parsed.protocol === "chrome-extension:" &&
    parsed.hostname === id &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.port === ""
  );
};
const admittedTarget = (target: CdpEndpointTarget, id: string): boolean =>
  ["service_worker", "background_page", "page", "other"].includes(
    target.type,
  ) && sameExtension(target.url, id);
const contextFor = (target: CdpEndpointTarget) => ({
  target_id: target.id,
  type: target.type,
  url: target.url,
  title: target.title,
});
const limitations = [
  "Only currently exposed CDP targets for the exact extension ID are covered. A dormant service worker or closed popup can be absent without the extension being absent.",
  "Website content-script isolated worlds are outside this extension-target snapshot; inspect packaged content scripts statically.",
  "Debugger attachment can affect service-worker lifetime and timing. No extension code is evaluated, no page is navigated, and no worker is started or stopped by this operation.",
  "Loaded source snapshots do not establish that a function ran, a permission was granted, a network request occurred or a message was delivered.",
  "Script URLs are debugger-reported labels and may come from sourceURL declarations. Source hashes bind the observed text, not an authenticated package-file attribution.",
];

/** Discover already-running extension contexts without attaching to or waking them. */
export const listExtensionContexts = async (
  input: ListChromeExtensionContextsInput,
  signal?: AbortSignal,
): Promise<ExtensionContextList> => {
  const endpoint = browserObservationEndpointSchema.parse(input.cdp_endpoint);
  const opened = await openCdpEndpoint(
    endpoint,
    "list_chrome_extension_contexts",
    signal,
  );
  try {
    return {
      cdp_endpoint: input.cdp_endpoint,
      extension_id: input.extension_id,
      contexts: opened.discovery.targets
        .filter((target) => admittedTarget(target, input.extension_id))
        .map(contextFor),
      limitations,
    };
  } finally {
    await opened.connection?.close();
  }
};

const verifyTarget = async (
  session: CdpTargetSession,
  input: InspectChromeExtensionContextInput,
  expected: CdpEndpointTarget,
  signal?: AbortSignal,
): Promise<void> => {
  const current = z
    .object({
      targetInfo: z.object({
        targetId: z.string(),
        type: z.string(),
        url: z.string(),
      }),
    })
    .parse(
      await session.connection.send(
        "Target.getTargetInfo",
        { targetId: input.target_id },
        undefined,
        signal,
      ),
    ).targetInfo;
  if (
    current.targetId !== input.target_id ||
    current.url !== expected.url ||
    current.type !== expected.type ||
    !sameExtension(current.url, input.extension_id)
  )
    throw new ArtifactReaderFailure(
      "integrity",
      "Selected extension target changed during observation",
    );
};

/** Snapshot JavaScript already loaded by one exact extension context; no Runtime.evaluate or target launch. */
export const inspectExtensionContext = async (
  input: InspectChromeExtensionContextInput,
  signal?: AbortSignal,
): Promise<ExtensionContextInspection> => {
  signal =
    signal === undefined
      ? AbortSignal.timeout(20000)
      : AbortSignal.any([signal, AbortSignal.timeout(20000)]);
  const endpoint = browserObservationEndpointSchema.parse(input.cdp_endpoint);
  const opened = await openCdpEndpoint(endpoint, OPERATION, signal);
  const target = opened.discovery.targets.find(
    (item) =>
      item.id === input.target_id && admittedTarget(item, input.extension_id),
  );
  if (!target) {
    await opened.connection?.close();
    throw new ArtifactReaderFailure(
      "path",
      "Target is missing or does not belong to the selected extension",
    );
  }
  await opened.connection?.close();
  const session = await openCdpTargetSession(
    opened.discovery,
    target,
    OPERATION,
    signal,
    { maxPayloadBytes: LIMIT },
  );
  const parsedScripts = new Map<string, z.infer<typeof scriptSchema>>();
  let observationFailure: unknown;
  const stop = session.connection.onEvent((event) => {
    if (event.sessionId !== session.sessionId) return;
    if (
      event.method === "Debugger.globalObjectCleared" ||
      event.method === "Inspector.detached" ||
      event.method === "Inspector.targetCrashed"
    ) {
      observationFailure = new ArtifactReaderFailure(
        "integrity",
        "Selected extension execution context changed during the snapshot",
      );
      return;
    }
    if (event.method !== "Debugger.scriptParsed") return;
    const parsed = scriptSchema.safeParse(event.params);
    if (!parsed.success) {
      observationFailure = new Error("Malformed extension script metadata");
      return;
    }
    if (parsedScripts.size >= 10000) {
      observationFailure = new ArtifactReaderFailure(
        "limit",
        "Extension context exceeds 10,000 observed scripts",
      );
      return;
    }
    parsedScripts.set(parsed.data.scriptId, parsed.data);
  });
  const stopDisconnect = session.connection.onDisconnect((error) => {
    observationFailure = error;
  });
  const stopProtocol = session.connection.onProtocolFailure((error) => {
    observationFailure = error;
  });
  let enabled = false;
  let primaryFailure: unknown;
  try {
    await verifyTarget(session, input, target, signal);
    await session.connection.send(
      "Debugger.enable",
      {},
      session.sessionId,
      signal,
    );
    enabled = true;
    // The enable response follows initial scriptParsed notifications; freeze this observed inventory.
    const inventory = [...parsedScripts.values()];
    const scripts: ExtensionContextInspection["scripts"] = [];
    let sourceBytes = 0;
    let excluded = 0;
    for (const item of inventory) {
      signal?.throwIfAborted();
      if (
        !sameExtension(item.url, input.extension_id) ||
        item.scriptLanguage === "WebAssembly"
      ) {
        excluded++;
        continue;
      }
      const result = z
        .object({ scriptSource: z.string() })
        .parse(
          await session.connection.send(
            "Debugger.getScriptSource",
            { scriptId: item.scriptId },
            session.sessionId,
            signal,
          ),
        );
      sourceBytes += Buffer.byteLength(result.scriptSource);
      if (sourceBytes > LIMIT)
        throw new ArtifactReaderFailure(
          "limit",
          "Extension script sources exceed the 16 MiB snapshot budget",
        );
      scripts.push({
        script_id: item.scriptId,
        url: item.url,
        sha256: extensionDigest(result.scriptSource),
        source: result.scriptSource,
      });
    }
    await verifyTarget(session, input, target, signal);
    if (observationFailure) throw observationFailure;
    return {
      cdp_endpoint: input.cdp_endpoint,
      extension_id: input.extension_id,
      context: contextFor(target),
      scripts,
      excluded_script_count: excluded,
      limitations: [
        ...limitations,
        "Only scripts reported before Debugger.enable completes and bearing this extension's URL are returned. Anonymous, other-origin and WebAssembly scripts are excluded.",
      ],
    };
  } catch (cause) {
    primaryFailure = cause;
    throw cause;
  } finally {
    stop();
    stopDisconnect();
    stopProtocol();
    // Cleanup has an independent deadline even when the caller cancels.
    const cleanupSignal = AbortSignal.timeout(5000);
    const failures: unknown[] = [];
    if (enabled)
      try {
        await session.connection.send(
          "Debugger.disable",
          {},
          session.sessionId,
          cleanupSignal,
        );
      } catch (cause) {
        failures.push(cause);
      }
    if (session.sessionId !== undefined)
      try {
        await session.connection.send(
          "Target.detachFromTarget",
          { sessionId: session.sessionId },
          undefined,
          cleanupSignal,
        );
      } catch (cause) {
        failures.push(cause);
      }
    await session.connection.close();
    if (failures.length) {
      const cleanup = new ProviderCleanupError(
        "chrome-extension",
        [input.target_id],
        { reason: "Extension debugger cleanup could not be confirmed" },
        { cause: failures[0], operation: OPERATION },
      );
      throw primaryFailure === undefined
        ? cleanup
        : analysisErrorWithCleanupFailure(
            extensionFailure(OPERATION, primaryFailure, signal),
            cleanup,
            OPERATION,
          );
    }
  }
};

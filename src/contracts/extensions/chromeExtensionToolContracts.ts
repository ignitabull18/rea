import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import {
  chromeExtensionReportSchema,
  extensionContextListSchema,
  extensionContextInspectionSchema,
  inspectChromeExtensionInputSchema,
  listChromeExtensionContextsInputSchema,
  inspectChromeExtensionContextInputSchema,
} from "../../domain/extensions/chromeExtension.js";

const id = "abcdefghijklmnopabcdefghijklmnop";
/** Explicit local-package and exact-extension CDP scopes; no extension installation or target evaluation. */
export const CHROME_EXTENSION_TOOL_CONTRACTS = [
  {
    name: "inspect_chrome_extension",
    ...toolContractMetadata("inspect_chrome_extension"),
    kind: "artifact-provider",
    description:
      "Inspect a local Chrome/Chromium extension directory, ZIP, CRX2 or CRX3 without installing or executing it. Returns the complete manifest (permissions, host patterns, CSP and unknown fields), declared background/content/popup/options/devtools/side-panel entrypoints with missing-file findings, file digests and literal chrome/browser API references with source coordinates. CRX signatures are not verified. Input is limited to 128 MiB carrier, 64 MiB expanded bytes and 10,000 entries; scripts over 2 MiB retain digests and explicit partial parsing coverage. Does not download store content, recover private server code or observe runtime behavior.",
    inputSchema: inspectChromeExtensionInputSchema,
    outputSchema: evidenceResultOf(chromeExtensionReportSchema),
    examples: [
      {
        title: "Inspect an unpacked extension",
        input: { path: "/artifacts/extension" },
      },
      {
        title: "Inspect a CRX package",
        input: { path: "/artifacts/extension.crx" },
      },
    ],
  },
  {
    name: "list_chrome_extension_contexts",
    ...toolContractMetadata("list_chrome_extension_contexts"),
    kind: "browser-provider",
    description:
      "List currently exposed page, background-page and service-worker CDP targets belonging to one exact Chrome extension ID at a caller-selected loopback browser endpoint. Does not attach, launch a browser, wake a worker or install an extension. Empty results do not establish extension absence: workers may be dormant and popups closed. Website content-script worlds are not extension targets.",
    inputSchema: listChromeExtensionContextsInputSchema,
    outputSchema: evidenceResultOf(extensionContextListSchema),
    examples: [
      {
        title: "Find one extension's running contexts",
        input: { cdp_endpoint: "http://127.0.0.1:9222", extension_id: id },
      },
    ],
  },
  {
    name: "inspect_chrome_extension_context",
    ...toolContractMetadata("inspect_chrome_extension_context"),
    kind: "browser-provider",
    description:
      "Snapshot JavaScript already loaded in one exact extension-owned CDP target, selected by endpoint, extension ID and target ID. Attaches Debugger, reads exact extension-origin script sources and hashes, revalidates target identity, then disables/detaches its own debugger connection. Attachment can affect worker lifetime and timing. Does not evaluate code, navigate, start/stop workers, read extension storage or capture credentials. Content-script isolated worlds, anonymous scripts and WebAssembly are outside coverage. Bounds: 20-second snapshot deadline, 16 MiB source bytes, 10,000 script records. A snapshot is not execution or network/message-flow evidence.",
    inputSchema: inspectChromeExtensionContextInputSchema,
    outputSchema: evidenceResultOf(extensionContextInspectionSchema),
    examples: [
      {
        title: "Read one discovered background worker",
        input: {
          cdp_endpoint: "http://127.0.0.1:9222",
          extension_id: id,
          target_id: "worker-target-id",
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];

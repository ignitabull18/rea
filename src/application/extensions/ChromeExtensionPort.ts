import type { ExecutionOptions } from "../AnalysisProvider.js";
import type {
  ChromeExtensionReport,
  ExtensionContextList,
  ExtensionContextInspection,
  InspectChromeExtensionInput,
  ListChromeExtensionContextsInput,
  InspectChromeExtensionContextInput,
} from "../../domain/extensions/chromeExtension.js";

/** Package reads and exact-context snapshots; no code execution, installation or store downloads. */
export interface ChromeExtensionPort {
  inspectPackage(
    input: InspectChromeExtensionInput,
    options?: ExecutionOptions,
  ): Promise<ChromeExtensionReport>;
  listContexts(
    input: ListChromeExtensionContextsInput,
    options?: ExecutionOptions,
  ): Promise<ExtensionContextList>;
  inspectContext(
    input: InspectChromeExtensionContextInput,
    options?: ExecutionOptions,
  ): Promise<ExtensionContextInspection>;
}

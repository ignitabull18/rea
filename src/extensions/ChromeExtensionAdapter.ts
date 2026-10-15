import type { ChromeExtensionPort } from "../application/extensions/ChromeExtensionPort.js";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type {
  InspectChromeExtensionInput,
  ListChromeExtensionContextsInput,
  InspectChromeExtensionContextInput,
} from "../domain/extensions/chromeExtension.js";
import { inspectExtensionPackage } from "./ChromeExtensionProvider.js";
import {
  inspectExtensionContext,
  listExtensionContexts,
} from "./ChromeExtensionRuntime.js";
import { extensionFailure } from "./ExtensionFailure.js";

const guarded = async <T>(
  operation: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> => {
  try {
    return await run();
  } catch (cause) {
    throw extensionFailure(operation, cause, signal);
  }
};

/** Own package and CDP parsing and project failures before the application boundary. */
export class ChromeExtensionAdapter implements ChromeExtensionPort {
  inspectPackage(
    input: InspectChromeExtensionInput,
    options?: ExecutionOptions,
  ) {
    return guarded("inspect_chrome_extension", options?.signal, () =>
      inspectExtensionPackage(input.path, options?.signal),
    );
  }
  listContexts(
    input: ListChromeExtensionContextsInput,
    options?: ExecutionOptions,
  ) {
    return guarded("list_chrome_extension_contexts", options?.signal, () =>
      listExtensionContexts(input, options?.signal),
    );
  }
  inspectContext(
    input: InspectChromeExtensionContextInput,
    options?: ExecutionOptions,
  ) {
    return guarded("inspect_chrome_extension_context", options?.signal, () =>
      inspectExtensionContext(input, options?.signal),
    );
  }
}

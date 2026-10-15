import { ZodError } from "zod";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisInputError,
  AnalysisCancelledError,
  AnalysisArtifactChangedError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";

/** Preserve typed I/O, resource and protocol failures at the extension adapter boundary. */
export const extensionFailure = (
  operation: string,
  cause: unknown,
  signal?: AbortSignal,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (signal?.aborted) return new AnalysisCancelledError(operation);
  if (cause instanceof ArtifactReaderFailure) {
    if (cause.reason === "cancelled")
      return new AnalysisCancelledError(operation);
    if (cause.reason === "integrity")
      return new AnalysisArtifactChangedError(
        operation,
        "extension input",
        cause.message,
        { cause },
      );
    if (cause.reason === "limit")
      return new AnalysisResourceConstraintError(
        operation,
        "memory",
        cause.message,
        null,
        { cause },
      );
  }
  if (
    cause instanceof ArtifactReaderFailure ||
    cause instanceof SyntaxError ||
    cause instanceof ZodError
  )
    return new AnalysisInputError(operation, { cause }, [
      { path: [], reason: "invalid_format", message: cause.message },
    ]);
  return new ProviderAdapterError("chrome-extension", operation, {
    cause,
    diagnostics: {
      reason: cause instanceof Error ? cause.message : String(cause),
    },
  });
};

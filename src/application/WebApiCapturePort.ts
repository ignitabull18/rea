import type { ExecutionOptions, ProviderIdentity } from "./AnalysisProvider.js";
import type {
  ObserveWebApiInput,
  WebApiCapture,
} from "../domain/webApiCapture.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Result } from "../domain/result.js";
/** Browser-owned response reads, independent of page actions and request mutation. */
export interface WebApiCapturePort {
  identity(): ProviderIdentity;
  capture(
    input: ObserveWebApiInput,
    options?: ExecutionOptions,
  ): Promise<Result<WebApiCapture, AnalysisError>>;
}

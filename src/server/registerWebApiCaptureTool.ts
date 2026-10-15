import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { WebApiCaptureService } from "../application/WebApiCaptureService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import type { Logger } from "pino";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import { toolContract } from "../contracts/toolContracts.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
/** Passive API capture shares the session Evidence ledger and progress protocol. */
export const registerWebApiCaptureTool = (
  server: EvidenceMcpServer,
  service: WebApiCaptureService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const contract = toolContract("observe_web_api");
  const handler = createEvidenceToolHandler(
    server,
    (input, options) => service.observe(input, options),
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    handler(contract),
  );
};

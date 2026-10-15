import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { ChromeExtensionService } from "../application/extensions/ChromeExtensionService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { CHROME_EXTENSION_TOOL_CONTRACTS } from "../contracts/extensions/chromeExtensionToolContracts.js";
import type { Logger } from "pino";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Register named extension contracts with the shared workflow and session Evidence ledger. */
export const registerChromeExtensionTools = (
  server: EvidenceMcpServer,
  service: ChromeExtensionService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  for (const contract of CHROME_EXTENSION_TOOL_CONTRACTS) {
    const handler = createEvidenceToolHandler(
      server,
      (input, options) => service.execute(contract.name, input, options),
      logger,
      recordEvidence,
      withAdmittedAnalysis,
    );
    server.registerTool(
      contract.name,
      toolRegistrationOptions(contract),
      handler(contract),
    );
  }
};

import { WebApiCaptureService } from "../application/WebApiCaptureService.js";
import { CdpWebApiCaptureProvider } from "../browser/api/CdpWebApiCaptureProvider.js";
/** Construct passive API observation without opening a browser. */
export const createWebApiCaptureService = (): WebApiCaptureService =>
  new WebApiCaptureService(new CdpWebApiCaptureProvider());

import { ChromeExtensionService } from "../application/extensions/ChromeExtensionService.js";
import { ChromeExtensionAdapter } from "../extensions/ChromeExtensionAdapter.js";

/** Bind static package and passive CDP adapters without starting a browser or reading a package. */
export const createChromeExtensionService = (): ChromeExtensionService =>
  new ChromeExtensionService(new ChromeExtensionAdapter());

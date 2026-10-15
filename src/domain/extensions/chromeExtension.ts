import { z } from "zod";
import { localPathStringSchema } from "../localPath.js";
import { jsonObjectSchema } from "../jsonValue.js";
import { browserEndpointSchema } from "../browserObservation.js";

/** Shared identity of this local fork's static and CDP extension inspector. */
export const CHROME_EXTENSION_PROVIDER_IDENTITY = {
  id: "chrome-extension",
  name: "REA Chrome extension inspector",
  version: "1",
} as const;

export const inspectChromeExtensionInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Absolute path to an unpacked extension directory, ZIP, or CRX2/CRX3 package.",
  ),
});
export const listChromeExtensionContextsInputSchema = z.strictObject({
  cdp_endpoint: browserEndpointSchema,
  extension_id: z
    .string()
    .regex(/^[a-p]{32}$/u)
    .describe(
      "Exact Chrome extension ID; only this extension's targets are returned.",
    ),
});
export const inspectChromeExtensionContextInputSchema =
  listChromeExtensionContextsInputSchema.extend({
    target_id: z
      .string()
      .min(1)
      .describe("Exact target ID returned by list_chrome_extension_contexts."),
  });
export const extensionApiReferenceSchema = z.strictObject({
  api: z.string(),
  line: z.number().int().positive(),
  column: z.number().int().nonnegative(),
});
export const chromeExtensionReportSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string(),
    sha256: z.string(),
    format: z.enum(["directory", "zip", "crx2", "crx3"]),
  }),
  signature_verification: z.enum(["not-applicable", "not-performed"]),
  manifest: jsonObjectSchema,
  entrypoints: z.array(
    z.strictObject({
      role: z.string(),
      declared_path: z.string(),
      path: z.string().nullable(),
      present: z.boolean(),
      problem: z.string().nullable(),
    }),
  ),
  files: z.array(
    z.strictObject({
      path: z.string(),
      sha256: z.string(),
      bytes: z.number().int().nonnegative(),
      api_references: z.array(extensionApiReferenceSchema),
      parse_error: z.string().nullable(),
    }),
  ),
  coverage: z.strictObject({
    inventory: z.literal("complete"),
    javascript: z.enum(["complete", "partial"]),
    runtime: z.literal("not-observed"),
  }),
  limitations: z.array(z.string()),
});
export const extensionContextSchema = z.strictObject({
  target_id: z.string(),
  type: z.string(),
  url: z.string(),
  title: z.string(),
});
export const extensionContextListSchema = z.strictObject({
  cdp_endpoint: z.string(),
  extension_id: z.string(),
  contexts: z.array(extensionContextSchema),
  limitations: z.array(z.string()),
});
export const extensionContextInspectionSchema = z.strictObject({
  cdp_endpoint: z.string(),
  extension_id: z.string(),
  context: extensionContextSchema,
  scripts: z.array(
    z.strictObject({
      script_id: z.string(),
      url: z.string(),
      sha256: z.string(),
      source: z.string(),
    }),
  ),
  excluded_script_count: z.number().int().nonnegative(),
  limitations: z.array(z.string()),
});
export type ChromeExtensionReport = z.infer<typeof chromeExtensionReportSchema>;
export type ExtensionContextList = z.infer<typeof extensionContextListSchema>;
export type ExtensionContextInspection = z.infer<
  typeof extensionContextInspectionSchema
>;
export type InspectChromeExtensionInput = z.infer<
  typeof inspectChromeExtensionInputSchema
>;
export type ListChromeExtensionContextsInput = z.infer<
  typeof listChromeExtensionContextsInputSchema
>;
export type InspectChromeExtensionContextInput = z.infer<
  typeof inspectChromeExtensionContextInputSchema
>;

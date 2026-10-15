import { isAbsolute, posix } from "node:path";
import { parse as parseJavaScript } from "@babel/parser";
import { traverseFast, type Node, type Expression } from "@babel/types";
import { parse as parseHtml, type DefaultTreeAdapterTypes } from "parse5";
import { z } from "zod";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  readExtensionPackage,
  extensionDigest,
} from "./ExtensionPackageReader.js";
import type { ChromeExtensionReport } from "../domain/extensions/chromeExtension.js";

const manifestSchema = z.looseObject({
  manifest_version: z.union([z.literal(2), z.literal(3)]),
  name: z.string().min(1),
  version: z.string().min(1),
  background: z
    .looseObject({
      service_worker: z.string().optional(),
      scripts: z.array(z.string()).optional(),
      page: z.string().optional(),
    })
    .optional(),
  content_scripts: z
    .array(
      z.looseObject({
        js: z.array(z.string()).optional(),
        css: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  action: z.looseObject({ default_popup: z.string().optional() }).optional(),
  browser_action: z
    .looseObject({ default_popup: z.string().optional() })
    .optional(),
  page_action: z
    .looseObject({ default_popup: z.string().optional() })
    .optional(),
  options_page: z.string().optional(),
  options_ui: z.looseObject({ page: z.string() }).optional(),
  devtools_page: z.string().optional(),
  side_panel: z.looseObject({ default_path: z.string() }).optional(),
  chrome_url_overrides: z.record(z.string(), z.string()).optional(),
  sandbox: z.looseObject({ pages: z.array(z.string()) }).optional(),
});
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Literal chrome/browser member references are syntax observations, not proof of API execution. */
const apiPath = (node: Expression | null | undefined): string | null => {
  if (node?.type === "Identifier")
    return node.name === "chrome" || node.name === "browser" ? node.name : null;
  if (
    node?.type !== "MemberExpression" &&
    node?.type !== "OptionalMemberExpression"
  )
    return null;
  if (node.object.type === "Super") return null;
  const base = apiPath(node.object);
  const key =
    !node.computed && node.property.type === "Identifier"
      ? node.property.name
      : node.computed && node.property.type === "StringLiteral"
        ? node.property.value
        : null;
  return base === null || key === null ? null : `${base}.${key}`;
};
const scriptReferences = (
  bytes: Buffer,
): Pick<
  ChromeExtensionReport["files"][number],
  "api_references" | "parse_error"
> => {
  if (bytes.byteLength > MAX_SCRIPT_BYTES)
    return {
      api_references: [],
      parse_error:
        "Outside static parsing coverage: script exceeds the 2 MiB per-script parser budget.",
    };
  try {
    const ast = parseJavaScript(utf8.decode(bytes), {
      sourceType: "unambiguous",
      plugins: ["jsx"],
      allowReturnOutsideFunction: true,
    });
    const references = new Map<
      number,
      { api: string; line: number; column: number }
    >();
    traverseFast(ast, (node: Node) => {
      if (
        node.type !== "MemberExpression" &&
        node.type !== "OptionalMemberExpression"
      )
        return;
      const api = apiPath(node);
      if (
        api === null ||
        node.start === null ||
        node.start === undefined ||
        !node.loc
      )
        return;
      const previous = references.get(node.start);
      if (!previous || previous.api.length < api.length)
        references.set(node.start, {
          api,
          line: node.loc.start.line,
          column: node.loc.start.column,
        });
    });
    return { api_references: [...references.values()], parse_error: null };
  } catch (cause) {
    return {
      api_references: [],
      parse_error: cause instanceof Error ? cause.message : String(cause),
    };
  }
};

/** Observe one local extension package without installation, network access or target execution. */
export const inspectExtensionPackage = async (
  path: string,
  signal?: AbortSignal,
): Promise<ChromeExtensionReport> => {
  if (!isAbsolute(path))
    throw new ArtifactReaderFailure(
      "path",
      "Expected an absolute extension path",
    );
  const artifact = await readExtensionPackage(path, signal);
  const manifestBytes = artifact.files.get("manifest.json");
  if (!manifestBytes)
    throw new ArtifactReaderFailure(
      "format",
      "Extension must contain manifest.json at its root",
    );
  if (manifestBytes.byteLength > 1024 * 1024)
    throw new ArtifactReaderFailure(
      "limit",
      "Extension manifest exceeds the 1 MiB parsing budget",
    );
  const rawManifest: unknown = JSON.parse(utf8.decode(manifestBytes));
  const manifest = manifestSchema.parse(rawManifest);
  const entrypoints: ChromeExtensionReport["entrypoints"] = [];
  const add = (role: string, declared: string | undefined, base = ""): void => {
    if (declared === undefined) return;
    let resolved: string | null = null;
    let problem: string | null = null;
    try {
      const htmlUrl = role.startsWith("html-script:")
        ? new URL(
            declared,
            `chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/${base}/`,
          )
        : null;
      const decoded = decodeURIComponent(
        htmlUrl === null ? declared : htmlUrl.pathname.slice(1),
      );
      const candidate = posix.normalize(
        htmlUrl === null ? posix.join(base, decoded) : decoded,
      );
      if (
        (htmlUrl !== null &&
          (htmlUrl.protocol !== "chrome-extension:" ||
            htmlUrl.hostname !== "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ||
            htmlUrl.username !== "" ||
            htmlUrl.password !== "")) ||
        decoded.includes("\\") ||
        decoded.includes("\0") ||
        decoded.startsWith("/") ||
        /^[a-z][a-z\d+.-]*:/iu.test(decoded) ||
        candidate === ".." ||
        candidate.startsWith("../") ||
        (htmlUrl === null && (decoded.includes("?") || decoded.includes("#")))
      )
        problem = "Not a package-local resource path";
      else {
        resolved = candidate;
        if (!artifact.files.has(candidate))
          problem = "Declared resource is missing from this package";
      }
    } catch {
      problem = "Invalid encoded resource path";
    }
    entrypoints.push({
      role,
      declared_path: declared,
      path: resolved,
      present: resolved !== null && artifact.files.has(resolved),
      problem,
    });
  };
  add("background-service-worker", manifest.background?.service_worker);
  for (const script of manifest.background?.scripts ?? [])
    add("background-script", script);
  add("background-page", manifest.background?.page);
  for (const [index, content] of (manifest.content_scripts ?? []).entries()) {
    for (const script of content.js ?? [])
      add(`content-script:${index}`, script);
    for (const css of content.css ?? []) add(`content-style:${index}`, css);
  }
  add("popup", manifest.action?.default_popup);
  add("popup", manifest.browser_action?.default_popup);
  add("popup", manifest.page_action?.default_popup);
  add("options", manifest.options_page);
  add("options", manifest.options_ui?.page);
  add("devtools", manifest.devtools_page);
  add("side-panel", manifest.side_panel?.default_path);
  for (const [key, value] of Object.entries(
    manifest.chrome_url_overrides ?? {},
  ))
    add(`chrome-url-override:${key}`, value);
  for (const page of manifest.sandbox?.pages ?? []) add("sandbox", page);
  const inlineFindings = new Map<string, ReturnType<typeof scriptReferences>>();
  const pageRoles = new Set([
    "background-page",
    "popup",
    "options",
    "devtools",
    "side-panel",
    "sandbox",
  ]);
  const htmlPaths = new Set(
    [...artifact.files.keys()].filter((name) => /\.html?$/iu.test(name)),
  );
  for (const entry of entrypoints)
    if (
      entry.present &&
      entry.path !== null &&
      (pageRoles.has(entry.role) ||
        entry.role.startsWith("chrome-url-override:"))
    )
      htmlPaths.add(entry.path);
  for (const htmlPath of htmlPaths) {
    const html = artifact.files.get(htmlPath);
    if (!html) continue;
    if (html.byteLength > MAX_SCRIPT_BYTES)
      throw new ArtifactReaderFailure(
        "limit",
        "Extension HTML exceeds the 2 MiB parsing budget",
      );
    const tree = parseHtml(utf8.decode(html), { sourceCodeLocationInfo: true });
    const pending: DefaultTreeAdapterTypes.Node[] = [tree];
    const inline: ReturnType<typeof scriptReferences> = {
      api_references: [],
      parse_error: null,
    };
    while (pending.length) {
      const node = pending.pop();
      if (!node) break;
      if ("tagName" in node && node.tagName === "base")
        inline.parse_error =
          "HTML base element requires further resource-resolution analysis";
      if ("tagName" in node && node.tagName === "script") {
        const type =
          node.attrs
            .find((attr) => attr.name === "type")
            ?.value.trim()
            .toLowerCase() ?? "";
        if (
          [
            "",
            "module",
            "text/javascript",
            "application/javascript",
            "text/ecmascript",
            "application/ecmascript",
          ].includes(type)
        ) {
          const src = node.attrs.find((attr) => attr.name === "src")?.value;
          if (src !== undefined)
            add(`html-script:${htmlPath}`, src, posix.dirname(htmlPath));
          else {
            const body = node.childNodes
              .filter(
                (child): child is DefaultTreeAdapterTypes.TextNode =>
                  child.nodeName === "#text",
              )
              .map((child) => child.value)
              .join("");
            const finding = scriptReferences(Buffer.from(body));
            if (finding.parse_error !== null)
              inline.parse_error = finding.parse_error;
            const start = node.sourceCodeLocation?.startTag;
            if (start)
              inline.api_references.push(
                ...finding.api_references.map((reference) => ({
                  ...reference,
                  line: reference.line + start.endLine - 1,
                  column:
                    reference.column +
                    (reference.line === 1 ? start.endCol - 1 : 0),
                })),
              );
            else if (body.length)
              inline.parse_error =
                "Inline script source coordinates are unavailable";
          }
        }
      }
      if ("childNodes" in node) pending.push(...node.childNodes);
    }
    if (inline.parse_error?.startsWith("HTML base element"))
      for (const entry of entrypoints)
        if (entry.role === `html-script:${htmlPath}`) {
          entry.path = null;
          entry.present = false;
          entry.problem = inline.parse_error;
        }
    inlineFindings.set(htmlPath, inline);
  }
  const declaredScripts = new Set(
    entrypoints
      .filter(
        (entry) =>
          entry.role === "background-service-worker" ||
          entry.role === "background-script" ||
          entry.role.startsWith("content-script:") ||
          entry.role.startsWith("html-script:"),
      )
      .flatMap((entry) => (entry.path === null ? [] : [entry.path])),
  );
  const files = [...artifact.files]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, bytes]) => ({
      path: name,
      bytes: bytes.byteLength,
      sha256: extensionDigest(bytes),
      ...(inlineFindings.get(name) ??
        (/\.(?:[cm]?js|jsx)$/iu.test(name) || declaredScripts.has(name)
          ? scriptReferences(bytes)
          : { api_references: [], parse_error: null })),
    }));
  signal?.throwIfAborted();
  return {
    artifact: { path, sha256: artifact.sha256, format: artifact.format },
    signature_verification:
      artifact.format === "crx2" || artifact.format === "crx3"
        ? "not-performed"
        : "not-applicable",
    manifest: JSON.parse(
      JSON.stringify(rawManifest),
    ) as ChromeExtensionReport["manifest"],
    entrypoints,
    files,
    coverage: {
      inventory: "complete",
      javascript:
        entrypoints.some((entry) => entry.problem !== null) ||
        files.some((file) => file.parse_error !== null)
          ? "partial"
          : "complete",
      runtime: "not-observed",
    },
    limitations: [
      "Static package inspection does not install, execute, authenticate a publisher, fetch store content, or observe runtime behavior.",
      "CRX signatures are not verified; file and package digests identify observed bytes only.",
      "Literal chrome/browser member references are syntactic candidates. Aliases, computed dynamic properties, shadowed globals, eval-generated code and behavior on private servers remain unresolved.",
      "Manifest declarations retain permissions, host patterns, CSP and unknown fields; declarations do not prove permissions were granted or APIs were executed.",
      "Directory digests commit to sorted file paths and contents; they are not hashes of a CRX carrier. ZIP/CRX digests commit to the original carrier bytes.",
      "JavaScript coverage describes conventional script files, declared script entrypoints and inline HTML scripts only; dynamic imports and registered resources require further analysis. Missing resources and HTML base elements make coverage partial.",
    ],
  };
};

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { ZipWriter, Uint8ArrayWriter, TextReader } from "@zip.js/zip.js";
import { createChromeExtensionService } from "../../../src/composition/chromeExtension.js";
import { chromeExtensionReportSchema } from "../../../src/domain/extensions/chromeExtension.js";
import { ChromeExtensionService } from "../../../src/application/extensions/ChromeExtensionService.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const root = async () => {
  const directory = await mkdtemp(join(tmpdir(), "rea-extension-test-"));
  roots.push(directory);
  return directory;
};
const inspect = (path: string, signal?: AbortSignal) =>
  createChromeExtensionService().execute(
    "inspect_chrome_extension",
    { path },
    signal === undefined ? {} : { signal },
  );
const manifest = JSON.stringify({
  manifest_version: 3,
  name: "known fixture",
  version: "1.0",
  permissions: ["storage"],
  background: { service_worker: "background.js" },
});
const archive = async (members: [string, string][]) => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  for (const [name, source] of members)
    await writer.add(name, new TextReader(source));
  return Buffer.from(await writer.close());
};

describe("Chrome extension inspection at the shared public workflow", () => {
  it("parses extensionless declared scripts and inline HTML and resolves root-relative script URLs with query strings", async () => {
    const directory = await root();
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify({
        manifest_version: 3,
        name: "fixture",
        version: "1",
        background: { service_worker: "worker" },
        action: { default_popup: "popup.html" },
      }),
    );
    await writeFile(
      join(directory, "worker"),
      "chrome.storage.local.get('key');",
    );
    await writeFile(
      join(directory, "popup.html"),
      '<script>chrome.runtime.sendMessage({});</script><script src="/popup.js?v=1#label"></script>',
    );
    await writeFile(join(directory, "popup.js"), "chrome.tabs.query({});");
    const result = await inspect(directory);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = chromeExtensionReportSchema.parse(
      result.value.normalized_result,
    );
    expect(report.entrypoints).toContainEqual(
      expect.objectContaining({
        role: "html-script:popup.html",
        path: "popup.js",
        present: true,
      }),
    );
    expect(
      report.files.find((file) => file.path === "worker")?.api_references,
    ).toEqual([{ api: "chrome.storage.local.get", line: 1, column: 0 }]);
    expect(
      report.files.find((file) => file.path === "popup.html")?.api_references,
    ).toEqual([{ api: "chrome.runtime.sendMessage", line: 1, column: 8 }]);
    expect(report.coverage.javascript).toBe("complete");
  });
  it("enforces the HTML byte budget before decoding or parsing malformed oversized text", async () => {
    const directory = await root();
    await writeFile(join(directory, "manifest.json"), manifest);
    await writeFile(join(directory, "background.js"), "");
    await writeFile(
      join(directory, "huge.html"),
      Buffer.alloc(2 * 1024 * 1024 + 1, 0xff),
    );
    const result = await inspect(directory);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error._tag).toBe("AnalysisResourceConstraintError");
  });
  it("preserves a typed cleanup failure when the caller has also cancelled", async () => {
    const controller = new AbortController();
    const cleanup = new ProviderCleanupError(
      "chrome-extension",
      ["fixture-worker"],
      { reason: "detach failed" },
      { operation: "inspect_chrome_extension" },
    );
    const service = new ChromeExtensionService({
      async inspectPackage() {
        controller.abort();
        throw cleanup;
      },
      async listContexts() {
        throw new Error("not used");
      },
      async inspectContext() {
        throw new Error("not used");
      },
    });
    const result = await service.execute(
      "inspect_chrome_extension",
      { path: resolve("tests/fixtures/chrome-extension") },
      { signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(cleanup);
  });
});

describe("Chrome extension package and input boundaries", () => {
  it("reads an MV3 fixture, retains permissions and locates actual API syntax without treating comments/strings as code", async () => {
    const result = await inspect(resolve("tests/fixtures/chrome-extension"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = chromeExtensionReportSchema.parse(
      result.value.normalized_result,
    );
    expect(report.manifest.permissions).toEqual(["storage"]);
    expect(report.entrypoints).toContainEqual(
      expect.objectContaining({
        role: "background-service-worker",
        path: "worker.js",
        present: true,
      }),
    );
    expect(report.entrypoints).toContainEqual(
      expect.objectContaining({
        role: "html-script:popup.html",
        path: "popup.js",
        present: true,
      }),
    );
    expect(
      report.files.find((file) => file.path === "worker.js")?.api_references,
    ).toContainEqual({
      api: "chrome.runtime.onMessage.addListener",
      line: 1,
      column: 0,
    });
    expect(report.coverage.runtime).toBe("not-observed");
  });
  it.each(["zip", "crx2", "crx3"])(
    "reads %s framing while preserving the original carrier digest and unverified signature status",
    async (format) => {
      const zip = await archive([
        ["manifest.json", manifest],
        [
          "background.js",
          "// chrome.tabs.remove()\nconst text='chrome.cookies.getAll';\nchrome['runtime'].onMessage.addListener(() => {});",
        ],
      ]);
      let bytes = zip;
      if (format !== "zip") {
        const header = Buffer.alloc(format === "crx2" ? 16 : 12);
        header.write("Cr24");
        header.writeUInt32LE(format === "crx2" ? 2 : 3, 4);
        bytes = Buffer.concat([header, zip]);
      }
      const path = join(await root(), `extension.${format}`);
      await writeFile(path, bytes);
      const result = await inspect(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const report = chromeExtensionReportSchema.parse(
        result.value.normalized_result,
      );
      expect(report.artifact.format).toBe(format);
      expect(report.signature_verification).toBe(
        format === "zip" ? "not-applicable" : "not-performed",
      );
      expect(
        report.files.find((file) => file.path === "background.js")
          ?.api_references,
      ).toEqual([
        { api: "chrome.runtime.onMessage.addListener", line: 3, column: 0 },
      ]);
    },
  );
  it("reports missing/escaping declared resources and syntax failures without claiming complete JavaScript coverage", async () => {
    const directory = await root();
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify({
        manifest_version: 2,
        name: "fixture",
        version: "1",
        background: { scripts: ["missing.js", "../escape.js"] },
      }),
    );
    await writeFile(join(directory, "bad.js"), "function (");
    const result = await inspect(directory);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = chromeExtensionReportSchema.parse(
      result.value.normalized_result,
    );
    expect(report.entrypoints.map((entry) => entry.present)).toEqual([
      false,
      false,
    ]);
    expect(report.entrypoints[1]?.path).toBeNull();
    expect(report.coverage.javascript).toBe("partial");
  });
  it("rejects archive traversal, truncated CRX headers and symlinks", async () => {
    const directory = await root();
    const zipPath = join(directory, "bad.zip");
    await writeFile(
      zipPath,
      await archive([
        ["manifest.json", manifest],
        ["../outside.js", "x"],
      ]),
    );
    expect((await inspect(zipPath)).ok).toBe(false);
    const crxPath = join(directory, "bad.crx");
    await writeFile(crxPath, "Cr24");
    expect((await inspect(crxPath)).ok).toBe(false);
    const linkPath = join(directory, "link");
    await symlink(resolve("tests/fixtures/chrome-extension"), linkPath);
    expect((await inspect(linkPath)).ok).toBe(false);
  });
  it("honors cancellation and validates runtime endpoints and IDs before connecting", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await inspect(
      resolve("tests/fixtures/chrome-extension"),
      controller.signal,
    );
    expect(result.ok).toBe(false);
    const service = createChromeExtensionService();
    expect(
      (
        await service.execute("list_chrome_extension_contexts", {
          cdp_endpoint: "https://example.com",
          extension_id: "abcdefghijklmnopabcdefghijklmnop",
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await service.execute("list_chrome_extension_contexts", {
          cdp_endpoint: "http://127.0.0.1:9222",
          extension_id: "wrong",
        })
      ).ok,
    ).toBe(false);
  });
});

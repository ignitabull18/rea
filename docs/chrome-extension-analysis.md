# Chrome extension analysis (local fork)

This local build adds package inspection and loaded-source snapshots for Chrome/Chromium extensions. It is a local customization, not a published upstream REA capability. It reuses REA's directory reader, ZIP library, Evidence contracts and CDP transport. No additional extension, commercial provider or analysis service is required.

## Scope and acceptance

The requested outcome is to let the installed REA CLI and Codex MCP inspect Chrome extensions. The public interfaces under verification are the CLI commands and matching MCP tools. Acceptance covers unpacked MV2/MV3 packages, ZIP/CRX2/CRX3 framing, manifest declarations, resource resolution, exact API source coordinates, malformed inputs, cancellation, real Chromium worker/popup source snapshots, exact extension-ID binding, and debugger cleanup.

The implementation does not install arbitrary extensions, evaluate target code, wake or stop workers, extract storage or credentials, circumvent protection, download store content, or alter website-source ownership rules. It is not an upstream submission. Maintainer review would be needed before integrating a new provider into official REA releases.

## Static package inspection

```bash
rea inspect-chrome-extension /absolute/path/to/extension --json
rea inspect-chrome-extension /absolute/path/to/extension.crx --json
```

MCP: `inspect_chrome_extension` with `path`.

Inputs are an unpacked directory or a ZIP, CRX2 or CRX3 file. Results contain the original carrier digest (or a sorted directory-content digest), the manifest including permissions/CSP/unknown fields, declared worker/content/popup/options/devtools/side-panel resources with missing-file findings, every file's size and SHA-256, and literal `chrome.*`/`browser.*` references with one-based lines and zero-based columns.

The reader does not run code or extract members to disk. CRX framing is decoded, **not cryptographically authenticated**. API references are syntax, not execution or permission-grant evidence. Dynamic properties, aliases and shadowed globals remain ambiguous. For deeper JavaScript analysis use supplied unpacked files with REA's existing JavaScript tools. Private server logic is outside package coverage.

Resource bounds: 128 MiB carrier, 64 MiB expanded package, 10,000 entries, 1 MiB manifest, 2 MiB per parsed JS/HTML file, 32 MiB complete report. Oversized JavaScript retains its digest and explicit partial parsing coverage. Other resource failures return typed errors. Traversal, symlinks, encrypted members and duplicate file paths are rejected.

## Already-running extension contexts

Start an operator-owned Chrome-family browser with a separate profile and a loopback debugging endpoint. Load only an extension you intend to run. REA does not launch the browser or install extensions for these commands.

```bash
rea list-chrome-extension-contexts http://127.0.0.1:9222 EXTENSION_ID --json
rea inspect-chrome-extension-context http://127.0.0.1:9222 EXTENSION_ID TARGET_ID --json
```

MCP tools:

- `list_chrome_extension_contexts`: `cdp_endpoint`, `extension_id`.
- `inspect_chrome_extension_context`: the same fields plus the exact discovered `target_id`.

Discovery returns currently exposed extension page/background-page/service-worker targets. Dormant workers and closed popups can be absent; empty discovery is not proof an extension is uninstalled. Inspection verifies ownership, attaches Debugger, snapshots already-loaded extension-origin scripts, rechecks identity and disables/detaches its own connection. Anonymous, other-origin and WASM scripts are excluded and counted. It never calls `Runtime.evaluate` or reads storage.

The snapshot has a 20-second deadline, 16 MiB source budget and 10,000-script budget, followed by independently bounded cleanup. Debugger attachment can change worker lifetime/timing. Source snapshots do not prove functions executed or messages/network requests occurred. Website content-script isolated worlds are outside live coverage; packaged content-script files are available statically.

## Existing tools researched

- [CRX Viewer](https://github.com/Rob--W/crxviewer): browser/web CRX and ZIP viewer with search and beautification; MPL-2.0.
- [crxray](https://github.com/collinboler/crxray): CLI for obtaining unpacked Chrome/Edge packages from store links. Researched, not installed, audited or used to download arbitrary extensions here.
- [Chrome extension debugging](https://developer.chrome.com/docs/extensions/get-started/tutorial/debug): official worker and content-script debugging workflow.
- [Chromium CRX3 format](https://chromium.googlesource.com/chromium/src/+/main/components/crx_file/crx3.proto): framing specification. No CRX Viewer implementation was copied into this fork.

## Verification and maintenance

The self-contained fixture under `tests/fixtures/chrome-extension` is loaded in a temporary Chromium profile. Real acceptance checks discover its worker via CLI, read worker/popup sources through stdio MCP, reject a different extension ID, inspect bounded empty discovery, and confirm popup-to-worker messaging after debugger cleanup. No personal profile or third-party extension is used.

Restart/reconnect Codex to acquire the new tool catalog. CLI commands work immediately. Registry updates can replace the custom build; preserve its tarball and local source commit before updating through npm later.

Run the reproducible acceptance lane with an existing extension-capable Chromium executable:

```bash
REA_BROWSER_EXECUTABLE=/absolute/path/to/chromium npm run verify:chrome-extension
```

Set `REA_ENTRYPOINT` to a packaged `scripts/rea.mjs` path to repeat the same CLI/MCP verification against an installed tarball. Reports go under `.cache/chrome-extension-verification` by default, or the output directory passed to the script.

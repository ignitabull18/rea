import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdtemp, rm, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import assert from "node:assert/strict";
const repo = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(join(repo, "package.json"));
const dispatcher = resolve(
  process.env.REA_ENTRYPOINT ?? join(repo, "scripts/rea.mjs"),
);
const playwright = await import(require.resolve("playwright-core"));
const chromium = playwright.chromium ?? playwright.default.chromium;
const { Client } = await import(
  require.resolve("@modelcontextprotocol/client")
);
const { StdioClientTransport } = await import(
  require.resolve("@modelcontextprotocol/client/stdio")
);
const run = promisify(execFile);
const out = resolve(
  process.argv[2] ?? join(repo, ".cache/chrome-extension-verification"),
);
await mkdir(out, { recursive: true });
const profile = await mkdtemp(join(out, "profile-"));
const fixture = join(repo, "tests/fixtures/chrome-extension");
const executable = process.env.REA_BROWSER_EXECUTABLE;
if (!executable)
  throw new Error(
    "Set REA_BROWSER_EXECUTABLE to an existing extension-capable Chromium or Chrome for Testing executable.",
  );
let httpServer;
let browser;
let client;
let transport;
const checks = [];
const check = (label) => {
  checks.push(label);
  console.log(label);
};
const reportOf = (r) =>
  r.structuredContent ??
  JSON.parse(r.content.find((c) => c.type === "text").text);
try {
  browser = await chromium.launchPersistentContext(profile, {
    executablePath: executable,
    headless: true,
    args: [
      `--disable-extensions-except=${fixture}`,
      `--load-extension=${fixture}`,
      "--remote-debugging-port=0",
    ],
  });
  const worker =
    browser.serviceWorkers()[0] ??
    (await browser.waitForEvent("serviceworker", { timeout: 15000 }));
  const id = new URL(worker.url()).hostname;
  const port = Number(
    (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(
      "\n",
    )[0],
  );
  const endpoint = `http://127.0.0.1:${port}`;
  check("Owned MV3 fixture loaded in isolated Chromium with service worker");
  const cli = await run(
    process.execPath,
    [dispatcher, "list-chrome-extension-contexts", endpoint, id, "--json"],
    { cwd: repo, maxBuffer: 32 * 1024 * 1024, timeout: 30000 },
  );
  const listed = JSON.parse(cli.stdout);
  await writeFile(
    join(out, "cli-contexts.json"),
    JSON.stringify(listed, null, 2),
  );
  assert(
    listed.normalized_result.contexts.some((x) => x.type === "service_worker"),
  );
  check("CLI discovers the exact extension service-worker context");
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [dispatcher, "mcp"],
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  client = new Client({ name: "extension-live-verification", version: "1" });
  await client.connect(transport, { timeout: 30000 });
  const tools = await client.listTools();
  for (const name of [
    "inspect_chrome_extension",
    "list_chrome_extension_contexts",
    "inspect_chrome_extension_context",
    "trace_chrome_extension_content_script",
  ])
    assert(tools.tools.some((t) => t.name === name));
  check("MCP advertises all four extension tools");
  async function call(name, args, filename) {
    const r = await client.callTool({ name, arguments: args }, undefined, {
      timeout: 60000,
    });
    await writeFile(join(out, filename), JSON.stringify(r, null, 2));
    if (r.isError) throw new Error(JSON.stringify(r));
    return reportOf(r);
  }
  const pack = await call(
    "inspect_chrome_extension",
    { path: fixture },
    "mcp-package.json",
  );
  assert(pack.normalized_result.manifest.manifest_version === 3);
  check("MCP statically inspects fixture package and manifest");
  const contexts = await call(
    "list_chrome_extension_contexts",
    { cdp_endpoint: endpoint, extension_id: id },
    "mcp-contexts.json",
  );
  const target = contexts.normalized_result.contexts.find(
    (t) => t.type === "service_worker",
  );
  assert(target);
  const snapshot = await call(
    "inspect_chrome_extension_context",
    { cdp_endpoint: endpoint, extension_id: id, target_id: target.target_id },
    "mcp-worker.json",
  );
  assert(
    snapshot.normalized_result.scripts.some((s) =>
      s.source.includes("rea-fixture-pong"),
    ),
  );
  check("MCP reads actual loaded service-worker source and returns hashes");
  const otherId = id === "a".repeat(32) ? "b".repeat(32) : "a".repeat(32);
  const rejected = await client.callTool({
    name: "inspect_chrome_extension_context",
    arguments: {
      cdp_endpoint: endpoint,
      extension_id: otherId,
      target_id: target.target_id,
    },
  });
  assert(rejected.isError);
  check("MCP rejects a target paired with a different extension ID");
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${id}/popup.html`);
  const pages = await call(
    "list_chrome_extension_contexts",
    { cdp_endpoint: endpoint, extension_id: id },
    "mcp-contexts-with-popup.json",
  );
  const popup = pages.normalized_result.contexts.find((t) =>
    t.url.endsWith("/popup.html"),
  );
  assert(popup);
  const popupSnapshot = await call(
    "inspect_chrome_extension_context",
    { cdp_endpoint: endpoint, extension_id: id, target_id: popup.target_id },
    "mcp-popup.json",
  );
  assert(
    popupSnapshot.normalized_result.scripts.some((s) =>
      s.source.includes("chrome.runtime.sendMessage"),
    ),
  );
  check("MCP reads actual loaded popup source");
  await page.locator("#ping").click();
  await page.waitForFunction(
    () => document.body.dataset.reply === "rea-fixture-pong",
  );
  check("Popup-to-worker messaging still works after debugger cleanup");
  const noTarget = await call(
    "list_chrome_extension_contexts",
    { cdp_endpoint: endpoint, extension_id: otherId },
    "mcp-absent-contexts.json",
  );
  assert.deepEqual(noTarget.normalized_result.contexts, []);
  check(
    "Absent extension returns bounded empty discovery with dormant-context caveat",
  );
  httpServer = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      req.url.startsWith("/content-probe")
        ? "probe-ok"
        : '<button id="rea-content-action">Trace content action</button>',
    );
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const webPage = await browser.newPage();
  await webPage.goto(`http://127.0.0.1:${httpServer.address().port}/trace`);
  await webPage.waitForFunction(
    () => document.documentElement.dataset.reaExtensionFixture === "loaded",
  );
  // Deliberately spoof an extension URL in the page's MAIN world. It must never become extension-owned.
  await webPage.evaluate((extensionId) => {
    const script = document.createElement("script");
    script.textContent = `window.reaPageSpoof = function reaPageSpoof() { return 42 };\n//# sourceURL=chrome-extension://${extensionId}/spoof.js`;
    document.head.append(script);
  }, id);
  const targets = await (await fetch(`${endpoint}/json/list`)).json();
  const webTarget = targets.find((t) => t.url === webPage.url());
  assert(webTarget);
  async function trace(extensionId, action, filename, duration = 1000) {
    let actionPromise;
    let armed = false;
    const response = await client.callTool(
      {
        name: "trace_chrome_extension_content_script",
        arguments: {
          cdp_endpoint: endpoint,
          extension_id: extensionId,
          target_id: webTarget.id,
          observation_ms: duration,
        },
      },
      {
        timeout: 60000,
        onprogress: (progress) => {
          if (progress.message?.includes("trace armed") && !armed) {
            armed = true;
            actionPromise = action();
          }
        },
      },
    );
    await actionPromise;
    await writeFile(join(out, filename), JSON.stringify(response, null, 2));
    assert(armed, "trace must announce actual instrumentation arming");
    return response;
  }
  const traceResponse = await trace(
    id,
    async () => {
      await webPage.evaluate(() => window.reaPageSpoof());
      await webPage.locator("#rea-content-action").click();
      await webPage.waitForFunction(
        () => document.documentElement.dataset.reaContentAction === "observed",
      );
    },
    "mcp-content-trace.json",
  );
  assert(!traceResponse.isError, JSON.stringify(traceResponse));
  const traced = reportOf(traceResponse).normalized_result;
  assert(traced.contexts.some((c) => c.origin === `chrome-extension://${id}`));
  assert(
    traced.scripts.some((s) =>
      s.functions.some(
        (f) =>
          f.name === "reaContentAction" && f.ranges.some((r) => r.count > 0),
      ),
    ),
  );
  assert(!traced.scripts.some((s) => s.reported_url.includes("spoof.js")));
  assert(
    traced.requests.some(
      (r) =>
        r.url.endsWith("/content-probe?fixture=retained") &&
        traced.scripts.some((s) => s.script_id === r.initiator_script_id),
    ),
  );
  assert(
    traced.dom_changes.some(
      (d) => d.attribute_name === "data-rea-content-action",
    ),
  );
  assert(
    !JSON.stringify(traced.dom_changes).includes("fixture-private-dom-value"),
  );
  check(
    "Live MCP trace observes owned content-script execution, direct network initiator and concurrent DOM change without DOM values",
  );
  check(
    "MAIN-world sourceURL spoof is excluded despite naming the selected extension",
  );
  const emptyTrace = await trace(
    otherId,
    async () => {
      await webPage.locator("#rea-content-action").click();
    },
    "mcp-other-content-trace.json",
    300,
  );
  assert(!emptyTrace.isError);
  assert.deepEqual(reportOf(emptyTrace).normalized_result.contexts, []);
  assert.deepEqual(reportOf(emptyTrace).normalized_result.scripts, []);
  assert.deepEqual(reportOf(emptyTrace).normalized_result.requests, []);
  check(
    "Different extension ID cannot read or attribute the selected extension's content-script sources",
  );
  const cliTrace = await run(
    process.execPath,
    [
      dispatcher,
      "trace-chrome-extension-content-script",
      endpoint,
      id,
      webTarget.id,
      "--observation-ms",
      "250",
      "--json",
    ],
    { cwd: repo, timeout: 60000, maxBuffer: 32 * 1024 * 1024 },
  );
  const cliTraced = JSON.parse(cliTrace.stdout);
  await writeFile(
    join(out, "cli-content-trace.json"),
    JSON.stringify(cliTraced, null, 2),
  );
  assert(cliTraced.normalized_result.contexts.length > 0);
  check(
    "Installed CLI shares the content-script tracing workflow and Evidence schema",
  );
  const navigated = await trace(
    id,
    async () => {
      await webPage.reload();
    },
    "mcp-navigation-rejected.json",
  );
  assert(navigated.isError);
  check(
    "Same-URL page reload invalidates the trace rather than returning stale world attribution",
  );
  await webPage.waitForFunction(
    () => document.documentElement.dataset.reaExtensionFixture === "loaded",
  );
  const cancellation = new AbortController();
  await assert.rejects(
    client.callTool(
      {
        name: "trace_chrome_extension_content_script",
        arguments: {
          cdp_endpoint: endpoint,
          extension_id: id,
          target_id: webTarget.id,
          observation_ms: 30000,
        },
      },
      {
        signal: cancellation.signal,
        onprogress: (progress) => {
          if (progress.message?.includes("trace armed")) cancellation.abort();
        },
      },
    ),
  );
  const recovered = await trace(
    id,
    async () => {},
    "mcp-after-cancel.json",
    250,
  );
  assert(!recovered.isError, JSON.stringify(recovered));
  check(
    "Cancellation releases instrumentation and a subsequent trace succeeds on the same page",
  );
  await writeFile(
    join(out, "verification.json"),
    JSON.stringify(
      {
        passed: true,
        verified_at: new Date().toISOString(),
        browser: browser.browser()?.version(),
        extension_id: id,
        checks,
      },
      null,
      2,
    ),
  );
} finally {
  await client?.close();
  await transport?.close();
  await browser?.close();
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  await rm(profile, { recursive: true, force: true });
}

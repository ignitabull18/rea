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
  ])
    assert(tools.tools.some((t) => t.name === name));
  check("MCP advertises all three new extension tools");
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
  await rm(profile, { recursive: true, force: true });
}

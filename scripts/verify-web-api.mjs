import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
const repo = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(join(repo, "package.json"));
const pw = await import(require.resolve("playwright-core"));
const { chromium } = pw.default ?? pw;
const { Client } = await import(
  require.resolve("@modelcontextprotocol/client")
);
const { StdioClientTransport } = await import(
  require.resolve("@modelcontextprotocol/client/stdio")
);
const dispatcher = resolve(
  process.env.REA_ENTRYPOINT ?? join(repo, "scripts/rea.mjs"),
);
const out = resolve(
  process.argv[2] ?? join(repo, ".cache/web-api-verification"),
);
await mkdir(out, { recursive: true });
const profile = await mkdtemp(join(out, "profile-"));
const executable = process.env.REA_BROWSER_EXECUTABLE;
if (!executable)
  throw Error(
    "Set REA_BROWSER_EXECUTABLE to existing Chromium/Chrome for Testing",
  );
const checks = [];
const check = (label) => {
  checks.push(label);
  console.log(label);
};
const report = (r) =>
  r.structuredContent ??
  JSON.parse(r.content.find((c) => c.type === "text").text);
const calls = [];
const http = createServer(async (req, res) => {
  if (req.url.startsWith("/api/")) {
    calls.push(req.url);
    if (!req.headers.cookie?.includes("rea-session=fixture-session")) {
      res.statusCode = 403;
      res.end("no session");
      return;
    }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/redirect") {
      res.writeHead(302, { Location: "/api/data?redirect=1" });
      res.end();
      return;
    }
    if (req.url === "/api/stream") {
      res.writeHead(200);
      res.write('{"pending":');
      return;
    }
    if (req.url === "/api/large") {
      res.end(JSON.stringify({ large: "x".repeat(8192) }));
      return;
    }
    if (req.url === "/api/filter") {
      let body = "";
      for await (const chunk of req) body += chunk;
      res.end(JSON.stringify({ filters: JSON.parse(body), total: 137 }));
      return;
    }
    res.end(
      JSON.stringify({
        visible: "ready",
        extra: { serverOnly: "browser-api-extra", total: 137 },
        literalSecret: "fixture-sensitive-literal",
      }),
    );
    return;
  }
  res.setHeader("Content-Type", "text/html");
  res.setHeader(
    "Set-Cookie",
    "rea-session=fixture-session; HttpOnly; SameSite=Lax; Path=/",
  );
  res.end(
    `<button id="load">Load</button><div id="state"></div><script>document.querySelector('#load').onclick=async()=>{await fetch('/api/data');await fetch('/api/filter',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({market:'CA',detail:'full'})});await fetch('/api/redirect');document.querySelector('#state').textContent='ready';};</script>`,
  );
});
const foreign = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.end("foreign-never-retained");
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));
await new Promise((r) => foreign.listen(0, "127.0.0.1", r));
let browser, client, transport;
try {
  browser = await chromium.launchPersistentContext(profile, {
    executablePath: executable,
    headless: true,
    args: ["--remote-debugging-port=0"],
  });
  const page = await browser.newPage();
  const url = `http://127.0.0.1:${http.address().port}/`;
  await page.goto(url);
  const port = (
    await readFile(join(profile, "DevToolsActivePort"), "utf8")
  ).split("\n")[0];
  const endpoint = `http://127.0.0.1:${port}`;
  const targets = await (await fetch(endpoint + "/json/list")).json();
  const target = targets.find((t) => t.url === url);
  assert(target);
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [dispatcher, "mcp"],
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  client = new Client({ name: "web-api-verification", version: "1" });
  await client.connect(transport);
  assert(
    (await client.listTools()).tools.some((t) => t.name === "observe_web_api"),
  );
  async function capture(action, options = {}, filename = "capture.json") {
    let actionPromise,
      armed = false;
    const response = await client.callTool(
      {
        name: "observe_web_api",
        arguments: {
          cdp_endpoint: endpoint,
          target_id: target.id,
          observation_ms: 700,
          ...options,
        },
      },
      {
        timeout: 60000,
        onprogress: (p) => {
          if (p.message?.includes("API capture armed") && !armed) {
            armed = true;
            actionPromise = action();
          }
        },
      },
    );
    await actionPromise;
    await writeFile(join(out, filename), JSON.stringify(response, null, 2));
    assert(armed, "capture must announce actual arming");
    return response;
  }
  const captured = await capture(
    async () => {
      await page.locator("#load").click();
      await page.waitForFunction(
        () => document.querySelector("#state").textContent === "ready",
      );
    },
    {
      include_request_body: true,
      sensitive_values: ["fixture-sensitive-literal"],
    },
  );
  assert(!captured.isError, JSON.stringify(captured));
  const data = report(captured);
  assert.equal(data.authority, "external-service");
  const rows = data.normalized_result.transactions;
  assert.equal(rows.length, 4);
  assert(rows.every((r) => r.status === 200 || r.status === 302));
  const first = rows.find((r) => r.url.endsWith("/api/data"));
  assert.equal(first.response_body.state, "captured");
  assert.equal(first.response_body.encoding, "utf8");
  assert(first.response_body.content.includes("browser-api-extra"));
  assert(!first.response_body.content.includes("fixture-sensitive-literal"));
  assert.equal(first.response_body.redacted, true);
  assert.equal(
    rows.find((r) => r.url.endsWith("/api/filter")).request_body.state,
    "captured",
  );
  assert(
    rows
      .find((r) => r.url.endsWith("/api/filter"))
      .request_body.content.includes('"market":"CA"'),
  );
  assert.equal(
    rows.find((r) => r.url.endsWith("/api/redirect")).response_body.reason,
    "redirect",
  );
  assert(
    rows.find((r) => r.url.endsWith("?redirect=1"))
      .redirect_from_transaction_id !== null,
  );
  assert(!JSON.stringify(data).includes("fixture-session"));
  assert(!JSON.stringify(data).includes("fixture-sensitive-literal"));
  assert.equal(calls.length, 4, "body reads must never replay requests");
  assert.equal(page.url(), url);
  assert(
    (await browser.cookies()).some(
      (c) => c.name === "rea-session" && c.httpOnly,
    ),
  );
  check(
    "MCP reads actual authenticated API values and optional POST data, with declared-secret redaction and intact cookies",
  );
  check(
    "Redirect hops retain distinct transaction identities and body reads send zero follow-up HTTP requests",
  );
  const large = await capture(
    () => page.evaluate(() => fetch("/api/large").then((r) => r.text())),
    { url_contains: "/api/large", max_body_bytes: 128 },
    "large.json",
  );
  assert(!large.isError);
  assert.equal(
    report(large).normalized_result.transactions[0].response_body.state,
    "unavailable",
  );
  assert.equal(report(large).normalized_result.coverage.state, "partial");
  check(
    "Oversized/unretained response bodies remain explicitly unavailable with partial coverage",
  );
  const foreignResult = await capture(
    () =>
      page.evaluate(
        (url) => fetch(url).then((r) => r.text()),
        `http://127.0.0.1:${foreign.address().port}/foreign`,
      ),
    {},
    "foreign.json",
  );
  assert(!foreignResult.isError);
  assert.deepEqual(report(foreignResult).normalized_result.transactions, []);
  assert(
    report(foreignResult).normalized_result.coverage.excluded_requests > 0,
  );
  check("Other-origin requests are excluded unless explicitly selected");
  const unfinished = await capture(
    () => page.evaluate(() => fetch("/api/stream").then(() => {})),
    { url_contains: "/api/stream" },
    "unfinished.json",
  );
  assert(!unfinished.isError);
  assert.equal(
    report(unfinished).normalized_result.transactions[0].response_body.reason,
    "unfinished",
  );
  check(
    "In-flight streaming response is marked unfinished without waiting for it or replaying it",
  );
  const limited = await capture(
    () => page.locator("#load").click(),
    { max_requests: 1 },
    "limited.json",
  );
  assert(!limited.isError);
  assert.equal(report(limited).normalized_result.transactions.length, 1);
  assert(
    report(limited).normalized_result.coverage.request_limit_omissions > 0,
  );
  check("Request count budget reports omissions without hiding incompleteness");
  const ws = (await (await fetch(endpoint + "/json/version")).json())
    .webSocketDebuggerUrl;
  const wsCapture = await capture(
    () => page.evaluate(() => fetch("/api/data").then((r) => r.json())),
    { cdp_endpoint: ws, url_contains: "/api/data" },
    "websocket-endpoint.json",
  );
  assert(!wsCapture.isError, JSON.stringify(wsCapture));
  assert.equal(
    report(wsCapture).normalized_result.transactions[0].response_body.state,
    "captured",
  );
  check(
    "Browser WebSocket endpoint uses the same exact-target capture and cleanup lifecycle",
  );
  let cliAction;
  const cli = spawn(
    process.execPath,
    [
      dispatcher,
      "observe-web-api",
      endpoint,
      target.id,
      "--observation-ms",
      "700",
      "--url-contains",
      "/api/data",
      "--json",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "";
  cli.stdout.on("data", (d) => (stdout += d));
  cli.stderr.on("data", (d) => {
    stderr += d;
    if (stderr.includes("API capture armed") && !cliAction)
      cliAction = page.evaluate(() => fetch("/api/data").then((r) => r.json()));
  });
  assert.equal(
    await new Promise((r, j) => {
      cli.on("error", j);
      cli.on("close", r);
    }),
    0,
    stderr,
  );
  await cliAction;
  const cliReport = JSON.parse(stdout);
  await writeFile(join(out, "cli.json"), JSON.stringify(cliReport, null, 2));
  assert.equal(
    cliReport.normalized_result.transactions[0].response_body.state,
    "captured",
  );
  assert.equal(
    cliReport.normalized_result.transactions[0].request_body.reason,
    "not_requested",
  );
  check(
    "CLI capture exposes armed progress and returns the same actual API-body evidence",
  );
  const reload = await capture(() => page.reload(), {}, "reload-rejected.json");
  assert(reload.isError);
  check("Same-URL reload invalidates capture identity");
  const abort = new AbortController();
  await assert.rejects(
    client.callTool(
      {
        name: "observe_web_api",
        arguments: {
          cdp_endpoint: endpoint,
          target_id: target.id,
          observation_ms: 30000,
        },
      },
      {
        signal: abort.signal,
        onprogress: (p) => {
          if (p.message?.includes("API capture armed")) abort.abort();
        },
      },
    ),
  );
  const recovered = await capture(
    () => page.evaluate(() => fetch("/api/data").then((r) => r.json())),
    {},
    "after-cancel.json",
  );
  assert(!recovered.isError);
  check(
    "Cancellation releases observation and a fresh capture succeeds on the same page",
  );
  await writeFile(
    join(out, "verification.json"),
    JSON.stringify(
      {
        passed: true,
        verified_at: new Date().toISOString(),
        browser: browser.browser()?.version(),
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
  http.closeAllConnections();
  foreign.closeAllConnections();
  await Promise.all([
    new Promise((r) => http.close(r)),
    new Promise((r) => foreign.close(r)),
  ]);
  await rm(profile, { recursive: true, force: true });
}

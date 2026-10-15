# API response capture in an existing browser

Use `observe_web_api` to read actual Fetch/XHR response data while operating an already-open webpage. This is the passive counterpart to browser DevTools Network: attach to the selected tab, wait for arming, then perform the action that makes the page request data.

```bash
rea list-browser-targets http://127.0.0.1:9222 --json
rea observe-web-api http://127.0.0.1:9222 PAGE_TARGET_ID \
  --observation-ms 10000 --url-contains /api/ --json
```

The CLI prints **API capture armed** on stderr and returns Evidence on stdout. MCP uses `observe_web_api` with `cdp_endpoint`, `target_id`, optional `observation_ms`, and literal `url_contains`; subscribe to progress before triggering a separate browser action. HTTP discovery and browser WebSocket endpoints are supported.

The default origin scope is the selected page's current origin. Add `allowed_origins` (CLI `--allowed-origins`) for explicitly selected cross-origin API hosts, including the page origin itself. API paths and hosts differ by website and workflow; `/api/` is only an example, not an Amazon-specific endpoint pattern.

Results preserve exact request IDs and separate redirect transactions, request method/URL, response status/MIME/cache/worker metadata, and actual response bodies. UTF-8 bodies, including JSON values, are readable text; binary bodies use base64. Every retained body has a byte count and SHA-256. Select `include_request_body: true` (CLI `--include-request-body`) to retain CDP-exposed POST data as well. Absence of exposed postData does not prove absence of uploaded or multipart data.

REA does not log in, navigate, click, inject JavaScript, pause/edit requests or replay URLs. The page uses its existing browser cookies and session normally. Headers, cookies and authorization values are not retained by this tool. Ordinary response data and URL query values are retained. Optional `sensitive_values` (CLI `--sensitive-values`) excludes caller-declared literal UTF-8 text from bodies and URLs; binary bodies are omitted when that redaction is requested. Digests describe retained bytes after redaction. It does not guess secrets from field names or decode arbitrary alternative secret encodings.

Body reads use `Network.getResponseBody` for the exact observed request ID only after `Network.loadingFinished`. There is no follow-up HTTP request if Chrome lacks a body. The result then says `body_not_retained`; it does not pretend to have recovered the response. Responses still in flight at cutoff say `unfinished`; redirect response bodies are unavailable. These are browser-decoded bytes, not compressed wire bytes.

Only new main-frame Fetch/XHR requests in the armed window and selected origins/filter are covered. Earlier requests, iframe/OOPIF requests, worker-only traffic, WebSockets and browser-internal calls remain outside coverage. A selected page response may be served by a service worker; that producer flag is preserved. Reload/navigation or transport loss invalidates the capture. The original browser/tab stays open and REA disables its own Network/Page domains and detaches its connection.

Defaults: 5 seconds (250–30,000 ms), 100 requests (maximum 1,000), 256 KiB per body (maximum 2 MiB), 2 MiB total body bytes (maximum 8 MiB). The total budget covers retained request and response bodies. A 2 MiB metadata budget, 10,000 network-event limit and 32 MiB report limit protect retained state. At most four response-body reads run concurrently. Over-budget bodies and request omissions are explicit and make coverage partial. Oversized protocol messages still follow the shared CDP transport limit. Already-admitted reads drain under the shared 20-second completion deadline; cleanup uses its independent five-second deadline. Cleanup failures preserve the original error.

For an Amazon workflow, this can reveal response data actually delivered to your authorized signed-in page, including fields the visible UI does not render. It cannot guarantee those fields exist, recover data Amazon did not send, or turn an internal browser endpoint into supported SP-API/Ads API coverage. No Amazon account or live Amazon endpoint is exercised by the local fixture verification.

Existing alternatives remain useful:

- `capture_browser_scenario` with `capture.network.response_body: true` for declared automated actions; preserve its documented Playwright follow-up-load/body-provenance limitation.
- `inspect_web_page` with JSON body shapes for value-free structure.
- `inspect_web_network_capture` for saved HAR, mitmproxy, SAZ and supported qlog captures.

Verification: `REA_BROWSER_EXECUTABLE=/absolute/path/to/chromium npm run verify:web-api`. Set `REA_ENTRYPOINT` to a packaged `scripts/rea.mjs` to test the installed package. The lane uses an owned local fixture, a temporary profile and a cookie-authenticated endpoint; it checks body values, redaction, redirect identity, zero replay, byte/request limits, origin exclusion, unfinished streams, HTTP/WebSocket endpoints, CLI/MCP parity, same-URL reload and cancellation/recovery.

Protocol references: [Chrome Network panel](https://developer.chrome.com/docs/devtools/network/reference) and [CDP Network](https://chromedevtools.github.io/devtools-protocol/tot/Network/). Pausing/modifying traffic is a separate [CDP Fetch](https://chromedevtools.github.io/devtools-protocol/tot/Fetch/) capability and is outside this tool.

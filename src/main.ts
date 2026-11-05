import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

type RequestTab = "headers" | "body" | "auth" | "transport";
type ResponseTab = "preview" | "raw" | "headers";
interface HeaderRow { name: string; value: string; }
interface CurlRequest {
  method: string;
  url: string;
  headers: HeaderRow[];
  body?: string;
  followRedirects: boolean;
  compressed: boolean;
  insecure: boolean;
  ipv4: boolean;
  ipv6: boolean;
  timeout?: number;
  connectTimeout?: number;
  maxRedirects?: number;
  userAgent?: string;
  referer?: string;
  proxy?: string;
  username?: string;
  password?: string;
  cookies?: string;
  caCertificate?: string;
  clientCertificate?: string;
  privateKey?: string;
}
interface NetworkTiming {
  dnsMs: number;
  connectMs: number;
  tlsMs: number;
  ttfbMs: number;
  downloadMs: number;
  totalMs: number;
}

interface CurlResponse {
  status: number;
  headers: string;
  body: string;
  durationMs: number;
  effectiveUrl: string;
  remoteIp: string;
  remotePort: string;
  sizeDownload: number;
  sizeUpload: number;
  contentType: string;
  timing?: NetworkTiming;
  stderr: string;
  exitCode?: number;
}

type ResourceType = "fetch" | "doc" | "css" | "js" | "img" | "media" | "font" | "ws" | "other";

interface CapturedRequest {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  pathname: string;
  hostname: string;
  searchParams: Record<string, string>;
  headers: HeaderRow[];
  body?: string;
  initiator: "Request Lab" | "Diagnostics" | "Transfer" | "Agent" | "Manual" | "Import";
  resourceType: ResourceType;
  status: number;
  statusText: string;
  responseHeaders: HeaderRow[];
  rawResponseHeaders: string;
  responseBody: string;
  contentType: string;
  sizeBytes: number;
  durationMs: number;
  timing?: NetworkTiming;
  remoteIp: string;
  remotePort: string;
  curlRequest: CurlRequest;
}

interface DiscoveredEndpoint {
  id: string;
  method: string;
  host: string;
  pattern: string;
  callCount: number;
  statusDistribution: Record<number, number>;
  avgLatencyMs: number;
  queryParamInventory: Set<string>;
  requestContentTypes: Set<string>;
  responseContentTypes: Set<string>;
  schemaFields: Record<string, string>;
  sampleRequests: CapturedRequest[];
}
interface DnsLookupResponse { hostname: string; addresses: string[]; ipv4: string[]; ipv6: string[]; durationMs: number; }
interface AgentMessage { role: "user" | "assistant"; content: string; }
interface AgentChatResponse { message: string; model: string; usage?: unknown; }
interface TlsInspectionResponse { host: string; port: number; reachable: boolean; protocol: string; cipher: string; certificateSubject: string; certificateIssuer: string; certificateExpiry: string; san: string; verification: string; alpn: string; durationMs: number; detail: string; }
interface PingResponse { host: string; reachable: boolean; durationMs: number; detail: string; }
interface TcpCheckResponse { host: string; port: number; reachable: boolean; durationMs: number; detail: string; }
interface TracerouteResponse { host: string; hops: string[]; durationMs: number; detail: string; }
interface NetworkInfoResponse { interfaces: string; routes: string; dnsConfig: string; }
interface PcapImportResponse { path: string; format: string; sizeBytes: number; packetCount: number; preview: string[]; detail: string; }
interface WorkspaceInfo { name: string; path: string; requestCount: number; }
interface FileInfo { path: string; length: string; completedLength: string; }
interface DownloadItem { gid: string; status: string; totalLength: string; completedLength: string; downloadSpeed: string; files: FileInfo[]; errorMessage?: string; }
interface AppSettings { host: string; port: number; download_dir: string; max_concurrent_downloads: string; max_overall_download_limit: string; max_overall_upload_limit: string; }

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => document.querySelector(selector) as T;
const $$ = (selector: string) => document.querySelectorAll(selector);
let requestTab: RequestTab = "headers";
let responseTab: ResponseTab = "preview";
let headers: HeaderRow[] = [{ name: "", value: "" }];
let history: CurlRequest[] = [];
let downloads: DownloadItem[] = [];
let downloadTimer: ReturnType<typeof setInterval> | null = null;
let agentMessages: AgentMessage[] = [];

// Network Inspector State
let capturedRequests: CapturedRequest[] = [];
let selectedRequestId: string | null = null;
let isRecording = true;
let preserveLog = true;
let activeTypeFilter = "all";
let textFilterQuery = "";
let activeNetworkView: "requests" | "discovery" = "requests";
let activeDrawerTab: "headers" | "payload" | "preview" | "response" | "timing" | "cookies" | "initiator" = "headers";
let redactionActive = true;
let pendingReplayRequest: CapturedRequest | null = null;
let rawHeadersView = false;
let rawPayloadView = false;

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char] || char));
}

function setStatus(value: string) {
  $("#status-text").textContent = value;
}

function showTool(tool: string) {
  $$(".tool-tab").forEach((tab) => tab.classList.toggle("active", (tab as HTMLElement).dataset.tool === tool));
  $$(".tool-view").forEach((view) => view.classList.toggle("active", view.id === `tool-${tool}`));
  $("#workspace-title").textContent = ({ request: "Request Lab", network: "Network Inspector", diagnostics: "Diagnostics", downloads: "Transfers", history: "History", agent: "Agent" } as Record<string, string>)[tool] || "Network Workbench";
  if (tool === "downloads") {
    startDownloadPolling();
  }
}

function prettyBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function addHistory(request: CurlRequest) {
  history = [request, ...history].slice(0, 30);
  renderHistory();
}

function renderHeaderRows() {
  $("#header-rows").innerHTML = headers
    .map(
      (header, index) =>
        `<div class="header-row"><input data-header-name="${index}" value="${escapeHtml(header.name)}" placeholder="Header name" /><input data-header-value="${index}" value="${escapeHtml(header.value)}" placeholder="Value" /><button type="button" class="icon-btn remove-header" data-index="${index}" aria-label="Remove header">×</button></div>`
    )
    .join("");
  $("#header-count").textContent = String(headers.filter((header) => header.name.trim()).length);
  $("#header-rows").querySelectorAll<HTMLInputElement>("[data-header-name]").forEach((input) =>
    input.addEventListener("input", () => {
      headers[Number(input.dataset.headerName)].name = input.value;
      $("#header-count").textContent = String(headers.filter((header) => header.name.trim()).length);
    })
  );
  $("#header-rows").querySelectorAll<HTMLInputElement>("[data-header-value]").forEach((input) =>
    input.addEventListener("input", () => {
      headers[Number(input.dataset.headerValue)].value = input.value;
    })
  );
  $("#header-rows").querySelectorAll<HTMLButtonElement>(".remove-header").forEach((button) =>
    button.addEventListener("click", () => {
      headers.splice(Number(button.dataset.index), 1);
      if (!headers.length) headers.push({ name: "", value: "" });
      renderHeaderRows();
    })
  );
}

function setRequestTab(tab: RequestTab) {
  requestTab = tab;
  $$(".request-tab").forEach((button) => button.classList.toggle("active", (button as HTMLElement).dataset.requestTab === tab));
  $$(".request-section").forEach((section) => section.classList.toggle("active", section.id === `request-${tab}`));
}

function setResponseTab(tab: ResponseTab) {
  responseTab = tab;
  $$(".response-tab").forEach((button) => button.classList.toggle("active", (button as HTMLElement).dataset.responseTab === tab));
  (["preview", "raw", "headers"] as ResponseTab[]).forEach((pane) => $(`#response-${pane}`).classList.toggle("hidden", pane !== tab));
}

function responseContentType(rawHeaders: string): string {
  const matches = [...rawHeaders.matchAll(/^content-type:\s*([^;\r\n]+)/gim)];
  const lastMatch = matches[matches.length - 1];
  return lastMatch?.[1].trim().toLowerCase() || "";
}

function isHtmlResponse(response: CurlResponse): boolean {
  const contentType = responseContentType(response.headers);
  return contentType === "text/html" || contentType === "application/xhtml+xml" || /^\s*(?:<!doctype\s+html\b|<html(?:\s|>)|<head(?:\s|>)|<body(?:\s|>))/i.test(response.body);
}

function renderResponsePreview(response: CurlResponse) {
  const preview = $("#response-preview");
  preview.replaceChildren();
  if (isHtmlResponse(response)) {
    const iframe = document.createElement("iframe");
    iframe.title = "Rendered HTML response";
    iframe.setAttribute("sandbox", "");
    iframe.srcdoc = response.body;
    preview.append(iframe);
    return;
  }
  const code = document.createElement("pre");
  code.className = "response-code response-preview-text";
  code.textContent = prettyBody(response.body);
  preview.append(code);
}

function requestFromForm(): CurlRequest {
  const value = (id: string) => $<HTMLInputElement>(id).value.trim();
  const body = $<HTMLTextAreaElement>("#request-body-input").value;
  const bearer = value("#request-bearer");
  const reqHeaders = headers.filter((header) => header.name.trim());
  if (bearer && !reqHeaders.some((h) => h.name.toLowerCase() === "authorization")) {
    reqHeaders.push({ name: "Authorization", value: `Bearer ${bearer}` });
  }

  return {
    method: $<HTMLSelectElement>("#request-method").value,
    url: value("#request-url"),
    headers: reqHeaders,
    body: body || undefined,
    followRedirects: $<HTMLInputElement>("#opt-follow").checked,
    compressed: $<HTMLInputElement>("#opt-compressed").checked,
    insecure: $<HTMLInputElement>("#opt-insecure").checked,
    ipv4: $<HTMLInputElement>("#opt-ipv4").checked,
    ipv6: $<HTMLInputElement>("#opt-ipv6").checked,
    timeout: Number(value("#request-timeout")) || undefined,
    connectTimeout: Number(value("#request-connect-timeout")) || undefined,
    maxRedirects: Number(value("#request-max-redirects")) || undefined,
    userAgent: value("#request-user-agent") || undefined,
    referer: value("#request-referer") || undefined,
    proxy: value("#request-proxy") || undefined,
    username: value("#request-username") || undefined,
    password: value("#request-password") || undefined,
    cookies: $<HTMLInputElement>("#request-use-cookies").checked ? value("#request-cookies") : undefined,
    caCertificate: value("#request-ca") || undefined,
    clientCertificate: value("#request-cert") || undefined,
    privateKey: value("#request-key") || undefined,
  };
}

function buildCurlCommand(request: CurlRequest): string {
  const parts: string[] = ["curl"];
  if (request.method && request.method !== "GET") {
    parts.push(`-X ${request.method}`);
  }
  parts.push(`"${request.url}"`);
  for (const header of request.headers) {
    if (header.name.trim()) {
      parts.push(`-H "${header.name.trim()}: ${header.value.replace(/"/g, '\\"')}"`);
    }
  }
  if (request.body && request.method !== "GET" && request.method !== "HEAD") {
    parts.push(`--data '${request.body.replace(/'/g, "'\\''")}'`);
  }
  if (request.followRedirects) parts.push("-L");
  if (request.compressed) parts.push("--compressed");
  if (request.insecure) parts.push("-k");
  if (request.ipv4) parts.push("-4");
  if (request.ipv6) parts.push("-6");
  if (request.timeout) parts.push(`-m ${request.timeout}`);
  if (request.connectTimeout) parts.push(`--connect-timeout ${request.connectTimeout}`);
  if (request.maxRedirects) parts.push(`--max-redirs ${request.maxRedirects}`);
  if (request.userAgent) parts.push(`-A "${request.userAgent.replace(/"/g, '\\"')}"`);
  if (request.referer) parts.push(`-e "${request.referer.replace(/"/g, '\\"')}"`);
  if (request.proxy) parts.push(`-x "${request.proxy.replace(/"/g, '\\"')}"`);
  if (request.username || request.password) {
    parts.push(`-u "${(request.username || "").replace(/"/g, '\\"')}:${(request.password || "").replace(/"/g, '\\"')}"`);
  }
  if (request.cookies) parts.push(`-b "${request.cookies.replace(/"/g, '\\"')}"`);
  if (request.caCertificate) parts.push(`--cacert "${request.caCertificate.replace(/"/g, '\\"')}"`);
  if (request.clientCertificate) parts.push(`--cert "${request.clientCertificate.replace(/"/g, '\\"')}"`);
  if (request.privateKey) parts.push(`--key "${request.privateKey.replace(/"/g, '\\"')}"`);
  return parts.join(" ");
}

function copyCurlCommand() {
  const request = requestFromForm();
  if (!request.url) {
    setStatus("Enter a request URL first to copy cURL command");
    return;
  }
  const cmd = buildCurlCommand(request);
  void navigator.clipboard.writeText(cmd).then(() => setStatus("cURL command copied to clipboard"));
}

async function sendRequest(event?: Event) {
  event?.preventDefault();
  const request = requestFromForm();
  if (!request.url) return;
  setStatus("Running curl request…");
  $("#response-empty").classList.add("hidden");
  $("#response-result").classList.add("hidden");
  try {
    const response = await invoke<CurlResponse>("run_curl", { request });
    $("#response-result").classList.remove("hidden");
    $("#response-status").textContent = response.status ? `${response.status}` : `exit ${response.exitCode ?? "?"}`;
    $("#response-status").className = `status-pill ${response.status >= 200 && response.status < 400 ? "good" : "bad"}`;
    $("#response-time").textContent = `${response.durationMs} ms`;
    renderResponsePreview(response);
    $("#response-raw").textContent = response.body;
    $("#response-headers").textContent = response.headers || "No response headers";
    $("#metric-url").textContent = response.effectiveUrl;
    $("#metric-status").textContent = String(response.status || "—");
    $("#metric-latency").textContent = `${response.durationMs} ms`;
    $("#metric-exit").textContent = String(response.exitCode ?? "—");
    setResponseTab("preview");
    setStatus(response.stderr ? `Completed with curl output: ${response.stderr}` : "Request complete");
    addHistory(request);
    if (isRecording) {
      captureNetworkRequest(request, response, "Request Lab");
    }
  } catch (error) {
    $("#response-empty").classList.remove("hidden");
    setStatus(`curl failed: ${error}`);
  }
}

// ── Network Inspector & API Endpoint Discovery Engine ──

function parseHeaderString(raw: string): HeaderRow[] {
  const result: HeaderRow[] = [];
  if (!raw) return result;
  for (const line of raw.split(/\r?\n/)) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const name = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      if (name) result.push({ name, value });
    }
  }
  return result;
}

function inferResourceType(contentType: string, urlStr: string, method: string): ResourceType {
  const ct = (contentType || "").toLowerCase();
  const urlLower = (urlStr || "").toLowerCase();
  if (ct.includes("text/html") || ct.includes("application/xhtml+xml")) return "doc";
  if (ct.includes("text/css") || urlLower.endsWith(".css")) return "css";
  if (ct.includes("javascript") || urlLower.endsWith(".js") || urlLower.endsWith(".mjs")) return "js";
  if (ct.startsWith("image/") || /\.(png|jpe?g|gif|svg|webp|ico|bmp)(\?.*)?$/i.test(urlLower)) return "img";
  if (ct.startsWith("video/") || ct.startsWith("audio/") || /\.(mp4|webm|mp3|ogg|wav)(\?.*)?$/i.test(urlLower)) return "media";
  if (ct.includes("font") || /\.(woff2?|ttf|otf|eot)(\?.*)?$/i.test(urlLower)) return "font";
  if (urlLower.startsWith("ws://") || urlLower.startsWith("wss://")) return "ws";
  if (ct.includes("json") || ct.includes("xml") || ct.includes("form") || (method && method !== "GET")) return "fetch";
  return "other";
}

function getStatusText(status: number): string {
  const map: Record<number, string> = {
    200: "OK", 201: "Created", 202: "Accepted", 204: "No Content",
    301: "Moved Permanently", 302: "Found", 304: "Not Modified", 307: "Temporary Redirect", 308: "Permanent Redirect",
    400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
    409: "Conflict", 422: "Unprocessable Entity", 429: "Too Many Requests",
    500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout"
  };
  return map[status] || (status >= 200 && status < 300 ? "OK" : status >= 400 ? "Error" : "");
}

function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "authorization" || lower === "cookie" || lower === "set-cookie" ||
         lower === "x-api-key" || lower === "proxy-authorization" || lower === "api-key";
}

function formatHeaderDisplay(name: string, value: string): string {
  if (redactionActive && isSensitiveHeader(name)) {
    return `<span class="token-redacted">•••••••• [REDACTED]</span>`;
  }
  return escapeHtml(value);
}

function captureNetworkRequest(
  request: CurlRequest,
  response: CurlResponse,
  initiator: CapturedRequest["initiator"]
): CapturedRequest {
  let pathname = request.url;
  let hostname = "";
  const searchParams: Record<string, string> = {};
  try {
    const parsed = new URL(request.url);
    pathname = parsed.pathname || "/";
    hostname = parsed.hostname;
    parsed.searchParams.forEach((val, key) => { searchParams[key] = val; });
  } catch {
    const parts = request.url.split("/");
    hostname = parts[2] || "";
    pathname = "/" + parts.slice(3).join("/").split("?")[0];
  }

  const responseHeaders = parseHeaderString(response.headers);
  const ct = response.contentType || responseContentType(response.headers);
  const resourceType = inferResourceType(ct, request.url, request.method);
  const sizeBytes = response.sizeDownload || new TextEncoder().encode(response.body).length;

  const captured: CapturedRequest = {
    id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    method: request.method || "GET",
    url: request.url,
    pathname,
    hostname,
    searchParams,
    headers: [...request.headers],
    body: request.body,
    initiator,
    resourceType,
    status: response.status || 0,
    statusText: getStatusText(response.status),
    responseHeaders,
    rawResponseHeaders: response.headers,
    responseBody: response.body,
    contentType: ct,
    sizeBytes,
    durationMs: Number(response.durationMs) || 0,
    timing: response.timing,
    remoteIp: response.remoteIp || "",
    remotePort: response.remotePort || "",
    curlRequest: request,
  };

  capturedRequests.push(captured);
  if (capturedRequests.length > 500) {
    capturedRequests = capturedRequests.slice(-500);
  }

  updateNetworkView();
  return captured;
}

function getFilteredRequests(): CapturedRequest[] {
  return capturedRequests.filter((req) => {
    if (activeTypeFilter !== "all" && req.resourceType !== activeTypeFilter) {
      return false;
    }
    if (!textFilterQuery) return true;
    const q = textFilterQuery.toLowerCase().trim();

    if (q.startsWith("status:")) {
      const code = q.slice(7).trim();
      if (code.endsWith("xx")) {
        return String(req.status).startsWith(code[0]);
      }
      return String(req.status) === code;
    }
    if (q.startsWith("method:")) {
      return req.method.toUpperCase() === q.slice(7).trim().toUpperCase();
    }
    if (q === "is:error") {
      return req.status >= 400 || req.status === 0;
    }

    return (
      req.url.toLowerCase().includes(q) ||
      req.pathname.toLowerCase().includes(q) ||
      req.hostname.toLowerCase().includes(q) ||
      req.method.toLowerCase().includes(q) ||
      String(req.status).includes(q)
    );
  });
}

function updateNetworkView() {
  const filtered = getFilteredRequests();
  const totalTransferred = filtered.reduce((acc, r) => acc + r.sizeBytes, 0);
  const totalTime = filtered.reduce((acc, r) => acc + r.durationMs, 0);

  const statCount = $("#net-stat-count");
  if (statCount) statCount.textContent = `${filtered.length} requests${filtered.length !== capturedRequests.length ? ` (filtered from ${capturedRequests.length})` : ""}`;
  const statSize = $("#net-stat-size");
  if (statSize) statSize.textContent = `${formatBytes(totalTransferred)} transferred`;
  const statTime = $("#net-stat-time");
  if (statTime) statTime.textContent = `${totalTime} ms total time`;
  const statFilter = $("#net-stat-filter");
  if (statFilter) statFilter.textContent = textFilterQuery ? `Filter: "${textFilterQuery}"` : "";

  renderNetworkTable(filtered);
  if (activeNetworkView === "discovery") {
    renderEndpointDiscovery();
  }
}

function renderNetworkTable(filtered: CapturedRequest[]) {
  const tbody = $("#net-table-body");
  if (!tbody) return;

  if (!filtered.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="9">${capturedRequests.length ? "No requests match the current filter." : "No network activity recorded. Send a request in Request Lab or import a HAR file."}</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered
    .map((req) => {
      const isSelected = req.id === selectedRequestId;
      const statusClass = req.status >= 500 ? "status-5xx" : req.status >= 400 ? "status-4xx" : req.status >= 300 ? "status-3xx" : "status-2xx";
      const rowClass = `${isSelected ? "selected" : ""} ${req.status >= 400 || req.status === 0 ? "row-error" : ""}`.trim();

      // Render mini waterfall
      let waterfallHtml = "";
      if (req.timing && req.timing.totalMs > 0) {
        const total = req.timing.totalMs;
        const pDns = Math.max(0, (req.timing.dnsMs / total) * 100);
        const pConn = Math.max(0, (req.timing.connectMs / total) * 100);
        const pTls = Math.max(0, (req.timing.tlsMs / total) * 100);
        const pTtfb = Math.max(0, (req.timing.ttfbMs / total) * 100);
        const pDown = Math.max(0, (req.timing.downloadMs / total) * 100);
        waterfallHtml = `<div class="waterfall-mini" title="DNS: ${req.timing.dnsMs}ms, Connect: ${req.timing.connectMs}ms, TLS: ${req.timing.tlsMs}ms, TTFB: ${req.timing.ttfbMs}ms, Download: ${req.timing.downloadMs}ms">
          ${pDns > 0 ? `<span class="wf-seg wf-seg-dns" style="width:${pDns}%"></span>` : ""}
          ${pConn > 0 ? `<span class="wf-seg wf-seg-conn" style="width:${pConn}%"></span>` : ""}
          ${pTls > 0 ? `<span class="wf-seg wf-seg-tls" style="width:${pTls}%"></span>` : ""}
          ${pTtfb > 0 ? `<span class="wf-seg wf-seg-ttfb" style="width:${pTtfb}%"></span>` : ""}
          ${pDown > 0 ? `<span class="wf-seg wf-seg-down" style="width:${pDown}%"></span>` : ""}
        </div>`;
      } else {
        waterfallHtml = `<div class="waterfall-mini"><span class="wf-seg wf-seg-ttfb" style="width:100%"></span></div>`;
      }

      const nameDisplay = req.pathname + (Object.keys(req.searchParams).length ? "?" + new URLSearchParams(req.searchParams).toString() : "");

      return `<tr class="${rowClass}" data-req-id="${req.id}">
        <td class="col-status"><span class="status-badge ${statusClass}">${req.status || "—"}</span></td>
        <td class="col-method"><span class="method-badge method-${req.method}">${escapeHtml(req.method)}</span></td>
        <td class="col-name" title="${escapeHtml(req.url)}">${escapeHtml(nameDisplay)}</td>
        <td class="col-domain" title="${escapeHtml(req.hostname)}">${escapeHtml(req.hostname)}</td>
        <td class="col-type">${escapeHtml(req.resourceType)}</td>
        <td class="col-initiator">${escapeHtml(req.initiator)}</td>
        <td class="col-size">${formatBytes(req.sizeBytes)}</td>
        <td class="col-time">${req.durationMs} ms</td>
        <td class="col-waterfall">${waterfallHtml}</td>
      </tr>`;
    })
    .join("");

  tbody.querySelectorAll<HTMLTableRowElement>("tr[data-req-id]").forEach((row) => {
    row.addEventListener("click", () => {
      const id = row.dataset.reqId!;
      selectNetworkRequest(selectedRequestId === id ? null : id);
    });
  });
}

function selectNetworkRequest(id: string | null) {
  selectedRequestId = id;
  const drawer = $("#net-detail-drawer");
  if (!id) {
    drawer?.classList.add("hidden");
    $$("#net-table-body tr").forEach((r) => r.classList.remove("selected"));
    return;
  }

  const req = capturedRequests.find((r) => r.id === id);
  if (!req) return;

  drawer?.classList.remove("hidden");
  $$("#net-table-body tr").forEach((r) => {
    r.classList.toggle("selected", (r as HTMLElement).dataset.reqId === id);
  });

  const methodEl = $("#drawer-method");
  if (methodEl) {
    methodEl.textContent = req.method;
    methodEl.className = `method-badge method-${req.method}`;
  }
  const urlEl = $("#drawer-url");
  if (urlEl) {
    urlEl.textContent = req.pathname;
    urlEl.title = req.url;
  }

  const redBtn = $("#drawer-btn-redaction");
  if (redBtn) {
    redBtn.textContent = `Redaction: ${redactionActive ? "ON" : "OFF"}`;
    redBtn.className = `btn-flat btn-sm ${redactionActive ? "btn-primary" : ""}`;
  }

  renderDrawerTab(req);
}

function renderDrawerTab(req: CapturedRequest) {
  $$(".drawer-tab").forEach((tab) => {
    tab.classList.toggle("active", (tab as HTMLElement).dataset.drawerTab === activeDrawerTab);
  });
  $$(".drawer-section").forEach((sec) => {
    sec.classList.toggle("active", sec.id === `drawer-section-${activeDrawerTab}`);
  });

  switch (activeDrawerTab) {
    case "headers":
      renderHeadersTab(req);
      break;
    case "payload":
      renderPayloadTab(req);
      break;
    case "preview":
      renderPreviewTab(req);
      break;
    case "response":
      renderResponseTabPane(req);
      break;
    case "timing":
      renderTimingTab(req);
      break;
    case "cookies":
      renderCookiesTab(req);
      break;
    case "initiator":
      renderInitiatorTab(req);
      break;
  }
}

function renderHeadersTab(req: CapturedRequest) {
  const container = $("#drawer-section-headers");
  if (!container) return;

  const generalRows = [
    ["Request URL", escapeHtml(req.url)],
    ["Request Method", escapeHtml(req.method)],
    ["Status Code", `<span class="${req.status >= 400 ? "status-4xx" : "status-2xx"}">${req.status} ${escapeHtml(req.statusText)}</span>`],
    ["Remote Address", escapeHtml(req.remoteIp ? `${req.remoteIp}:${req.remotePort || "443"}` : "—")],
    ["Referrer Policy", "strict-origin-when-cross-origin"],
  ];

  const queryParams = Object.entries(req.searchParams);

  container.innerHTML = `
    <div class="kv-group">
      <div class="kv-group-title">General</div>
      <table class="kv-table">
        ${generalRows.map(([k, v]) => `<tr><td class="kv-key">${k}</td><td class="kv-val">${v}</td></tr>`).join("")}
      </table>
    </div>

    ${queryParams.length ? `
    <div class="kv-group">
      <div class="kv-group-title">Query String Parameters (${queryParams.length})</div>
      <table class="kv-table">
        ${queryParams.map(([k, v]) => `<tr><td class="kv-key">${escapeHtml(k)}</td><td class="kv-val">${escapeHtml(v)}</td></tr>`).join("")}
      </table>
    </div>` : ""}

    <div class="kv-group">
      <div class="kv-group-title">
        <span>Response Headers (${req.responseHeaders.length})</span>
        <button id="btn-toggle-raw-res-headers" class="btn-flat btn-sm">${rawHeadersView ? "Formatted" : "View source"}</button>
      </div>
      ${rawHeadersView
        ? `<pre class="response-code">${escapeHtml(req.rawResponseHeaders || "No response headers")}</pre>`
        : req.responseHeaders.length
          ? `<table class="kv-table">${req.responseHeaders.map((h) => `<tr><td class="kv-key">${escapeHtml(h.name)}</td><td class="kv-val">${formatHeaderDisplay(h.name, h.value)}</td></tr>`).join("")}</table>`
          : `<small style="color:var(--text-dim)">No response headers</small>`
      }
    </div>

    <div class="kv-group">
      <div class="kv-group-title">
        <span>Request Headers (${req.headers.length})</span>
        <button id="btn-toggle-raw-req-headers" class="btn-flat btn-sm">${rawHeadersView ? "Formatted" : "View source"}</button>
      </div>
      ${rawHeadersView
        ? `<pre class="response-code">${req.headers.map((h) => `${escapeHtml(h.name)}: ${formatHeaderDisplay(h.name, h.value)}`).join("\n") || "No request headers"}</pre>`
        : req.headers.length
          ? `<table class="kv-table">${req.headers.map((h) => `<tr><td class="kv-key">${escapeHtml(h.name)}</td><td class="kv-val">${formatHeaderDisplay(h.name, h.value)}</td></tr>`).join("")}</table>`
          : `<small style="color:var(--text-dim)">No request headers</small>`
      }
    </div>
  `;

  $("#btn-toggle-raw-res-headers")?.addEventListener("click", () => {
    rawHeadersView = !rawHeadersView;
    renderHeadersTab(req);
  });
  $("#btn-toggle-raw-req-headers")?.addEventListener("click", () => {
    rawHeadersView = !rawHeadersView;
    renderHeadersTab(req);
  });
}

function renderPayloadTab(req: CapturedRequest) {
  const container = $("#drawer-section-payload");
  if (!container) return;

  if (!req.body) {
    const queryParams = Object.entries(req.searchParams);
    if (queryParams.length) {
      container.innerHTML = `
        <div class="kv-group">
          <div class="kv-group-title">URL Query Parameters (${queryParams.length})</div>
          <table class="kv-table">
            ${queryParams.map(([k, v]) => `<tr><td class="kv-key">${escapeHtml(k)}</td><td class="kv-val">${escapeHtml(v)}</td></tr>`).join("")}
          </table>
        </div>`;
      return;
    }
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">⌁</div><p>No payload sent with this request.</p></div>`;
    return;
  }

  const byteLength = new TextEncoder().encode(req.body).length;

  container.innerHTML = `
    <div class="kv-group">
      <div class="kv-group-title">
        <span>Request Body (${formatBytes(byteLength)})</span>
        <button id="btn-toggle-raw-payload" class="btn-flat btn-sm">${rawPayloadView ? "Pretty" : "Raw"}</button>
      </div>
      <pre class="response-code">${escapeHtml(rawPayloadView ? req.body : prettyBody(req.body))}</pre>
    </div>
  `;

  $("#btn-toggle-raw-payload")?.addEventListener("click", () => {
    rawPayloadView = !rawPayloadView;
    renderPayloadTab(req);
  });
}

function renderPreviewTab(req: CapturedRequest) {
  const container = $("#drawer-section-preview");
  if (!container) return;

  container.replaceChildren();

  if (req.status >= 400 || req.status === 0) {
    const errorBanner = document.createElement("div");
    errorBanner.style.cssText = "padding: 8px 12px; margin-bottom: 12px; background: rgba(255,109,124,0.1); border-left: 3px solid var(--error-color); color: var(--error-color); font-family: var(--mono); font-size: 11px;";
    errorBanner.innerHTML = `<strong>HTTP ${req.status || "Connection Error"}:</strong> ${escapeHtml(req.statusText || "Request failed")}`;
    container.append(errorBanner);
  }

  const ct = req.contentType.toLowerCase();
  if (ct.includes("text/html") || ct.includes("application/xhtml+xml") || /^\s*(?:<!doctype\s+html\b|<html(?:\s|>))/i.test(req.responseBody)) {
    const iframe = document.createElement("iframe");
    iframe.title = "HTML Preview";
    iframe.setAttribute("sandbox", "");
    iframe.style.cssText = "width: 100%; height: 350px; border: 1px solid var(--border-color); border-radius: var(--radius); background: #fff;";
    iframe.srcdoc = req.responseBody;
    container.append(iframe);
    return;
  }

  if (ct.startsWith("image/")) {
    const img = document.createElement("img");
    img.src = req.url;
    img.alt = "Response Preview";
    img.style.cssText = "max-width: 100%; max-height: 350px; border-radius: var(--radius); border: 1px solid var(--border-color); object-fit: contain;";
    container.append(img);
    return;
  }

  const pre = document.createElement("pre");
  pre.className = "response-code";
  pre.textContent = prettyBody(req.responseBody);
  container.append(pre);
}

function renderResponseTabPane(req: CapturedRequest) {
  const container = $("#drawer-section-response");
  if (!container) return;

  container.innerHTML = `
    <div class="kv-group">
      <div class="kv-group-title">
        <span>Response Body (${formatBytes(req.sizeBytes)})</span>
        <button id="btn-copy-drawer-response" class="btn-flat btn-sm">Copy Response</button>
      </div>
      <pre id="drawer-response-text" class="response-code">${escapeHtml(req.responseBody || "Empty response body")}</pre>
    </div>
  `;

  $("#btn-copy-drawer-response")?.addEventListener("click", () => {
    void navigator.clipboard.writeText(req.responseBody).then(() => {
      const btn = $("#btn-copy-drawer-response");
      if (btn) {
        btn.textContent = "Copied!";
        setTimeout(() => { btn.textContent = "Copy Response"; }, 1500);
      }
    });
  });
}

function renderTimingTab(req: CapturedRequest) {
  const container = $("#drawer-section-timing");
  if (!container) return;

  const t = req.timing || {
    dnsMs: 0,
    connectMs: 0,
    tlsMs: 0,
    ttfbMs: req.durationMs,
    downloadMs: 0,
    totalMs: req.durationMs,
  };

  const total = Math.max(1, t.totalMs || req.durationMs);

  const phases = [
    { name: "DNS Lookup", ms: t.dnsMs, color: "#75d9dc" },
    { name: "Initial Connection", ms: t.connectMs, color: "#ff956d" },
    { name: "SSL / TLS Handshake", ms: t.tlsMs, color: "#a371f7" },
    { name: "Waiting (TTFB)", ms: t.ttfbMs, color: "#c7f25a" },
    { name: "Content Download", ms: t.downloadMs, color: "#58a6ff" },
  ];

  container.innerHTML = `
    <div class="kv-group">
      <div class="kv-group-title">Timing Breakdown (${total} ms total)</div>
      <div class="timing-chart">
        ${phases
          .map((p) => {
            const pct = Math.max(0, Math.min(100, (p.ms / total) * 100));
            return `<div class="timing-row">
              <div class="timing-name"><span class="timing-dot" style="background:${p.color}"></span>${p.name}</div>
              <div class="timing-bar-wrapper"><div class="timing-bar-fill" style="width:${pct}%; background:${p.color}"></div></div>
              <div class="timing-val">${p.ms} ms</div>
            </div>`;
          })
          .join("")}
      </div>
    </div>
  `;
}

function renderCookiesTab(req: CapturedRequest) {
  const container = $("#drawer-section-cookies");
  if (!container) return;

  // Request cookies
  const cookieHeader = req.headers.find((h) => h.name.toLowerCase() === "cookie")?.value || req.curlRequest.cookies || "";
  const requestCookies = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const idx = c.indexOf("=");
      return idx > 0 ? [c.slice(0, idx), c.slice(idx + 1)] : [c, ""];
    });

  // Response Set-Cookie headers
  const setCookieHeaders = req.responseHeaders.filter((h) => h.name.toLowerCase() === "set-cookie");

  container.innerHTML = `
    <div class="kv-group">
      <div class="kv-group-title">Request Cookies (${requestCookies.length})</div>
      ${requestCookies.length
        ? `<table class="kv-table">${requestCookies.map(([k, v]) => `<tr><td class="kv-key">${escapeHtml(k)}</td><td class="kv-val">${redactionActive ? `<span class="token-redacted">•••••••• [REDACTED]</span>` : escapeHtml(v)}</td></tr>`).join("")}</table>`
        : `<small style="color:var(--text-dim)">No request cookies sent</small>`
      }
    </div>

    <div class="kv-group">
      <div class="kv-group-title">Response Cookies (Set-Cookie: ${setCookieHeaders.length})</div>
      ${setCookieHeaders.length
        ? `<table class="kv-table">${setCookieHeaders.map((h) => `<tr><td class="kv-key">Set-Cookie</td><td class="kv-val">${redactionActive ? `<span class="token-redacted">•••••••• [REDACTED]</span>` : escapeHtml(h.value)}</td></tr>`).join("")}</table>`
        : `<small style="color:var(--text-dim)">No response cookies received</small>`
      }
    </div>
  `;
}

function renderInitiatorTab(req: CapturedRequest) {
  const container = $("#drawer-section-initiator");
  if (!container) return;

  const rows = [
    ["Trigger Initiator", escapeHtml(req.initiator)],
    ["Captured At", new Date(req.timestamp).toLocaleString()],
    ["Internal Request ID", escapeHtml(req.id)],
    ["Target URL", escapeHtml(req.url)],
    ["Remote Peer", escapeHtml(req.remoteIp ? `${req.remoteIp}:${req.remotePort}` : "Not connected")],
    ["Redirection Tracking", req.curlRequest.followRedirects ? "Follow redirects enabled" : "Disabled"],
    ["TLS Mode", req.curlRequest.insecure ? "Skip TLS verification" : "Standard system TLS verification"],
  ];

  container.innerHTML = `
    <div class="kv-group">
      <div class="kv-group-title">Execution Context</div>
      <table class="kv-table">
        ${rows.map(([k, v]) => `<tr><td class="kv-key">${k}</td><td class="kv-val">${v}</td></tr>`).join("")}
      </table>
    </div>
  `;
}

// ── API Endpoint Discovery & Clustering ──

function clusterEndpoints(): DiscoveredEndpoint[] {
  const map = new Map<string, DiscoveredEndpoint>();

  for (const req of capturedRequests) {
    const segments = req.pathname.split("/").filter(Boolean);
    const patternSegments: string[] = [];

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const prev = i > 0 ? segments[i - 1].toLowerCase() : "";

      if (/^\d+$/.test(seg)) {
        const noun = prev ? prev.replace(/s$/, "") : "id";
        patternSegments.push(`{${noun}Id}`);
      } else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) {
        patternSegments.push("{uuid}");
      } else if (/^[0-9a-f]{16,64}$/i.test(seg)) {
        patternSegments.push("{hash}");
      } else if (/^[a-zA-Z0-9_\-]{24,}$/.test(seg)) {
        patternSegments.push("{token}");
      } else {
        patternSegments.push(seg);
      }
    }

    const pattern = "/" + patternSegments.join("/");
    const key = `${req.method.toUpperCase()} ${req.hostname}${pattern}`;

    if (!map.has(key)) {
      map.set(key, {
        id: `ep_${Math.random().toString(36).slice(2, 7)}`,
        method: req.method.toUpperCase(),
        host: req.hostname,
        pattern,
        callCount: 0,
        statusDistribution: {},
        avgLatencyMs: 0,
        queryParamInventory: new Set(),
        requestContentTypes: new Set(),
        responseContentTypes: new Set(),
        schemaFields: {},
        sampleRequests: [],
      });
    }

    const ep = map.get(key)!;
    ep.callCount++;
    ep.statusDistribution[req.status] = (ep.statusDistribution[req.status] || 0) + 1;
    ep.avgLatencyMs = Math.round(
      (ep.avgLatencyMs * (ep.callCount - 1) + req.durationMs) / ep.callCount
    );

    Object.keys(req.searchParams).forEach((k) => ep.queryParamInventory.add(k));
    if (req.contentType) ep.responseContentTypes.add(req.contentType.split(";")[0]);
    const reqCt = req.headers.find((h) => h.name.toLowerCase() === "content-type")?.value;
    if (reqCt) ep.requestContentTypes.add(reqCt.split(";")[0]);

    if (req.responseBody) {
      try {
        const parsed = JSON.parse(req.responseBody);
        if (typeof parsed === "object" && parsed !== null) {
          const target = Array.isArray(parsed) ? parsed[0] : parsed;
          if (typeof target === "object" && target !== null) {
            for (const [k, v] of Object.entries(target)) {
              const type = Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
              ep.schemaFields[k] = type;
            }
          }
        }
      } catch {
        // Non-JSON response
      }
    }

    if (ep.sampleRequests.length < 5) {
      ep.sampleRequests.push(req);
    }
  }

  return Array.from(map.values());
}

function renderEndpointDiscovery() {
  const endpoints = clusterEndpoints();
  const totalCalls = endpoints.reduce((acc, ep) => acc + ep.callCount, 0);
  const avgLatency = endpoints.length
    ? Math.round(endpoints.reduce((acc, ep) => acc + ep.avgLatencyMs, 0) / endpoints.length)
    : 0;

  const countEl = $("#disc-count");
  if (countEl) countEl.textContent = String(endpoints.length);
  const callsEl = $("#disc-calls");
  if (callsEl) callsEl.textContent = String(totalCalls);
  const latEl = $("#disc-latency");
  if (latEl) latEl.textContent = `${avgLatency} ms`;

  const list = $("#discovery-list");
  if (!list) return;

  if (!endpoints.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">⌘</div><p>No endpoints discovered yet. Record traffic to cluster requests into API endpoints.</p></div>`;
    return;
  }

  list.innerHTML = endpoints
    .map((ep) => {
      const statusPills = Object.entries(ep.statusDistribution)
        .map(([code, count]) => {
          const c = Number(code);
          const colorClass = c >= 400 ? "status-4xx" : "status-2xx";
          return `<span class="status-badge ${colorClass}">${code} (${count})</span>`;
        })
        .join(" ");

      const qParams = Array.from(ep.queryParamInventory);
      const schemaEntries = Object.entries(ep.schemaFields);

      return `<div class="endpoint-card">
        <div class="endpoint-top">
          <div class="endpoint-pattern">
            <span class="method-badge method-${ep.method}">${ep.method}</span>
            <span>${escapeHtml(ep.pattern).replace(/\{([^}]+)\}/g, '<span class="endpoint-param-tag">{$1}</span>')}</span>
          </div>
          <span style="font-family:var(--mono); color:var(--text-secondary); font-size:11px;">${escapeHtml(ep.host)}</span>
        </div>
        <div class="endpoint-metrics">
          <span>Calls: <strong>${ep.callCount}</strong></span>
          <span>Status: ${statusPills}</span>
          <span>Avg Latency: <strong>${ep.avgLatencyMs} ms</strong></span>
          ${ep.responseContentTypes.size ? `<span>Type: ${Array.from(ep.responseContentTypes).join(", ")}</span>` : ""}
        </div>
        ${(qParams.length || schemaEntries.length) ? `
        <div class="endpoint-details">
          ${qParams.length ? `<div><strong>Query Parameters:</strong> ${qParams.map((p) => `<code style="color:var(--accent-color)">${escapeHtml(p)}</code>`).join(", ")}</div>` : ""}
          ${schemaEntries.length ? `<div><strong>Response Schema:</strong> ${schemaEntries.slice(0, 6).map(([k, t]) => `${escapeHtml(k)}: <em style="color:var(--text-dim)">${t}</em>`).join(", ")}</div>` : ""}
        </div>` : ""}
      </div>`;
    })
    .join("");
}

// ── HAR 1.2 & OpenAPI Export / Import ──

async function exportOpenApi() {
  const endpoints = clusterEndpoints();
  if (!endpoints.length) {
    setStatus("No discovered endpoints to export. Record some traffic first.");
    return;
  }

  const paths: Record<string, any> = {};
  for (const ep of endpoints) {
    if (!paths[ep.pattern]) paths[ep.pattern] = {};
    const methodLower = ep.method.toLowerCase();

    const pathParams = (ep.pattern.match(/\{([^}]+)\}/g) || []).map((p) => ({
      name: p.slice(1, -1),
      in: "path",
      required: true,
      schema: { type: "string" },
    }));

    const queryParams = Array.from(ep.queryParamInventory).map((q) => ({
      name: q,
      in: "query",
      required: false,
      schema: { type: "string" },
    }));

    const responses: Record<string, any> = {};
    for (const [code] of Object.entries(ep.statusDistribution)) {
      const schemaProperties: Record<string, any> = {};
      for (const [fName, fType] of Object.entries(ep.schemaFields)) {
        schemaProperties[fName] = { type: fType === "array" ? "array" : fType };
      }
      responses[code] = {
        description: getStatusText(Number(code)) || "Response",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: schemaProperties,
            },
          },
        },
      };
    }

    paths[ep.pattern][methodLower] = {
      summary: `${ep.method} ${ep.pattern}`,
      parameters: [...pathParams, ...queryParams],
      responses: Object.keys(responses).length ? responses : { "200": { description: "OK" } },
    };
  }

  const spec = {
    openapi: "3.0.0",
    info: {
      title: "Aria Discovered API Specification",
      version: "1.0.0",
      description: "Auto-discovered and clustered from real network traffic in Aria Network Workbench",
    },
    paths,
  };

  try {
    const selected = await save({
      defaultPath: "aria-openapi-spec.json",
      filters: [{ name: "OpenAPI Specification", extensions: ["json"] }],
    });
    if (!selected) return;
    await invoke("export_report", {
      path: selected,
      format: "json",
      title: "Aria OpenAPI Spec",
      payload: spec,
    });
    setStatus(`OpenAPI specification exported to ${selected}`);
  } catch (error) {
    setStatus(`OpenAPI export failed: ${error}`);
  }
}

async function exportHar() {
  if (!capturedRequests.length) {
    setStatus("No captured traffic to export. Send requests or record traffic first.");
    return;
  }

  const entries = capturedRequests.map((req) => {
    const sanitizeVal = (name: string, val: string) =>
      redactionActive && isSensitiveHeader(name) ? "[REDACTED]" : val;

    return {
      startedDateTime: new Date(req.timestamp).toISOString(),
      time: req.durationMs,
      request: {
        method: req.method,
        url: req.url,
        httpVersion: "HTTP/1.1",
        cookies: [],
        headers: req.headers.map((h) => ({ name: h.name, value: sanitizeVal(h.name, h.value) })),
        queryString: Object.entries(req.searchParams).map(([name, value]) => ({ name, value })),
        headersSize: -1,
        bodySize: req.body ? new TextEncoder().encode(req.body).length : 0,
        postData: req.body
          ? {
              mimeType: req.headers.find((h) => h.name.toLowerCase() === "content-type")?.value || "text/plain",
              text: req.body,
            }
          : undefined,
      },
      response: {
        status: req.status,
        statusText: req.statusText,
        httpVersion: "HTTP/1.1",
        cookies: [],
        headers: req.responseHeaders.map((h) => ({ name: h.name, value: sanitizeVal(h.name, h.value) })),
        content: {
          size: req.sizeBytes,
          mimeType: req.contentType,
          text: req.responseBody,
        },
        redirectURL: "",
        headersSize: -1,
        bodySize: req.sizeBytes,
      },
      cache: {},
      timings: req.timing
        ? {
            blocked: -1,
            dns: req.timing.dnsMs,
            connect: req.timing.connectMs,
            ssl: req.timing.tlsMs,
            send: 0,
            wait: req.timing.ttfbMs,
            receive: req.timing.downloadMs,
          }
        : {
            send: 0,
            wait: req.durationMs,
            receive: 0,
          },
      serverIPAddress: req.remoteIp || "127.0.0.1",
    };
  });

  const har = {
    log: {
      version: "1.2",
      creator: { name: "Aria Network Workbench", version: "0.1.0" },
      entries,
    },
  };

  try {
    const selected = await save({
      defaultPath: "aria-network-capture.har",
      filters: [{ name: "HTTP Archive", extensions: ["har", "json"] }],
    });
    if (!selected) return;
    await invoke("export_report", {
      path: selected,
      format: "json",
      title: "Aria HAR Capture",
      payload: har,
    });
    setStatus(`HAR capture exported to ${selected}`);
  } catch (error) {
    setStatus(`HAR export failed: ${error}`);
  }
}

async function importHar() {
  try {
    const selected = await open({
      multiple: false,
      filters: [{ name: "HTTP Archive", extensions: ["har", "json"] }],
    });
    if (!selected || typeof selected !== "string") return;

    setStatus(`Importing HAR from ${selected}…`);
    const content = await invoke<string>("read_text_file", { path: selected });
    const parsed = JSON.parse(content);
    const entries = parsed?.log?.entries;
    if (!Array.isArray(entries)) {
      setStatus("Invalid HAR file: missing log.entries array");
      return;
    }

    let importedCount = 0;
    for (const entry of entries) {
      const req = entry.request;
      const res = entry.response;
      if (!req || !req.url) continue;

      let pathname = req.url;
      let hostname = "";
      const searchParams: Record<string, string> = {};
      try {
        const u = new URL(req.url);
        pathname = u.pathname || "/";
        hostname = u.hostname;
        u.searchParams.forEach((v, k) => { searchParams[k] = v; });
      } catch {
        const parts = req.url.split("/");
        hostname = parts[2] || "";
        pathname = "/" + parts.slice(3).join("/").split("?")[0];
      }

      const reqHeaders: HeaderRow[] = Array.isArray(req.headers)
        ? req.headers.map((h: any) => ({ name: String(h.name || ""), value: String(h.value || "") }))
        : [];
      const resHeaders: HeaderRow[] = Array.isArray(res?.headers)
        ? res.headers.map((h: any) => ({ name: String(h.name || ""), value: String(h.value || "") }))
        : [];

      const rawHeaders = resHeaders.map((h) => `${h.name}: ${h.value}`).join("\r\n");
      const ct = res?.content?.mimeType || "";
      const resourceType = inferResourceType(ct, req.url, req.method || "GET");
      const durationMs = Math.round(Number(entry.time) || 0);

      const timings = entry.timings;
      const timing: NetworkTiming | undefined = timings
        ? {
            dnsMs: Math.max(0, Number(timings.dns) || 0),
            connectMs: Math.max(0, Number(timings.connect) || 0),
            tlsMs: Math.max(0, Number(timings.ssl) || 0),
            ttfbMs: Math.max(0, Number(timings.wait) || 0),
            downloadMs: Math.max(0, Number(timings.receive) || 0),
            totalMs: durationMs,
          }
        : undefined;

      const captured: CapturedRequest = {
        id: `har_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        timestamp: entry.startedDateTime ? new Date(entry.startedDateTime).getTime() : Date.now(),
        method: req.method || "GET",
        url: req.url,
        pathname,
        hostname,
        searchParams,
        headers: reqHeaders,
        body: req.postData?.text,
        initiator: "Import",
        resourceType,
        status: Number(res?.status) || 0,
        statusText: res?.statusText || getStatusText(Number(res?.status) || 0),
        responseHeaders: resHeaders,
        rawResponseHeaders: rawHeaders,
        responseBody: res?.content?.text || "",
        contentType: ct,
        sizeBytes: Number(res?.content?.size) || (res?.content?.text ? new TextEncoder().encode(res.content.text).length : 0),
        durationMs,
        timing,
        remoteIp: entry.serverIPAddress || "",
        remotePort: "",
        curlRequest: {
          method: req.method || "GET",
          url: req.url,
          headers: reqHeaders,
          body: req.postData?.text,
          followRedirects: true,
          compressed: false,
          insecure: false,
          ipv4: false,
          ipv6: false,
        },
      };

      capturedRequests.push(captured);
      importedCount++;
    }

    showTool("network");
    updateNetworkView();
    setStatus(`Successfully imported ${importedCount} requests from HAR`);
  } catch (error) {
    setStatus(`HAR import failed: ${error}`);
  }
}

function buildFetchSnippet(req: CapturedRequest): string {
  const options: Record<string, any> = {
    method: req.method,
    headers: {} as Record<string, string>,
  };
  for (const h of req.headers) {
    if (h.name.trim()) {
      options.headers[h.name] = redactionActive && isSensitiveHeader(h.name) ? "[REDACTED]" : h.value;
    }
  }
  if (req.body && req.method !== "GET" && req.method !== "HEAD") {
    options.body = req.body;
  }
  return `fetch("${req.url}", ${JSON.stringify(options, null, 2)});`;
}

function replayRequest(req: CapturedRequest) {
  const isNonIdempotent = ["POST", "PUT", "DELETE", "PATCH"].includes(req.method.toUpperCase());
  if (isNonIdempotent) {
    pendingReplayRequest = req;
    const methodSpan = $("#replay-confirm-method");
    if (methodSpan) methodSpan.textContent = req.method.toUpperCase();
    $<HTMLDialogElement>("#dialog-confirm-replay")?.showModal();
    return;
  }
  void executeReplay(req);
}

async function executeReplay(req: CapturedRequest) {
  setStatus(`Replaying ${req.method} ${req.url}…`);
  try {
    const response = await invoke<CurlResponse>("run_curl", { request: req.curlRequest });
    captureNetworkRequest(req.curlRequest, response, "Manual");
    loadRequest(req.curlRequest);
    setStatus(`Request replayed successfully (Status: ${response.status})`);
  } catch (error) {
    setStatus(`Replay failed: ${error}`);
  }
}

function toggleRecording() {
  isRecording = !isRecording;
  const btn = $("#net-btn-record");
  if (btn) {
    btn.classList.toggle("recording", isRecording);
    btn.title = isRecording ? "Recording active (click to pause)" : "Recording paused (click to resume)";
  }
  setStatus(isRecording ? "Network recording resumed" : "Network recording paused");
}

function clearCapturedRequests() {
  capturedRequests = [];
  selectedRequestId = null;
  selectNetworkRequest(null);
  updateNetworkView();
  setStatus("Captured network traffic cleared");
}

function renderHistory() {
  const list = $("#history-list");
  if (!history.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">◷</div><p>No request history yet</p></div>`;
    return;
  }
  list.innerHTML = history
    .map(
      (request, index) =>
        `<button class="history-item" data-history-index="${index}"><span class="method-label">${escapeHtml(request.method)}</span><span>${escapeHtml(request.url)}</span><small>${request.headers.length} headers${request.body ? " · body" : ""}</small></button>`
    )
    .join("");
  list.querySelectorAll<HTMLButtonElement>("[data-history-index]").forEach((button) =>
    button.addEventListener("click", () => loadRequest(history[Number(button.dataset.historyIndex)]))
  );
}

function renderAgentMessages() {
  const list = $("#agent-messages");
  list.innerHTML = agentMessages.length
    ? agentMessages.map((message) => `<div class="agent-message ${message.role}"><span>${message.role === "user" ? "YOU" : "AGENT"}</span><p>${escapeHtml(message.content)}</p></div>`).join("")
    : `<div class="empty-state"><div class="empty-icon">✦</div><p>Ask the agent to explain a response, summarize captures, or suggest an authorized next step.</p></div>`;
  list.scrollTop = list.scrollHeight;
}

function currentAgentContext(): string {
  const request = requestFromForm();
  const response = $("#response-raw").textContent || "";
  const workspace = document.querySelector(".tool-view.active")?.id.replace("tool-", "") || "request";
  return JSON.stringify({ workspace, request: { method: request.method, url: request.url, headers: request.headers }, response: response.slice(0, 12000), task: "Analyze the current Aria workspace and help with the user's latest request." });
}

async function sendAgentMessage(event: Event) {
  event.preventDefault();
  const input = $<HTMLTextAreaElement>("#agent-input");
  const content = input.value.trim();
  if (!content) return;
  const message: AgentMessage = { role: "user", content };
  agentMessages.push(message);
  renderAgentMessages();
  input.value = "";
  setStatus("Running agent…");
  try {
    const provider = $<HTMLSelectElement>("#agent-provider").value;
    const endpointField = $<HTMLInputElement>("#agent-endpoint");
    const endpoint = provider === "claude" ? "claude-agent-sdk" : endpointField.value.trim();
    const model = $<HTMLInputElement>("#agent-model").value.trim();
    const apiKey = $<HTMLInputElement>("#agent-api-key").value || undefined;
    const response = await invoke<AgentChatResponse>("agent_chat", {
      request: {
        endpoint,
        provider,
        apiKey,
        model,
        messages: agentMessages,
        context: $<HTMLInputElement>("#agent-include-context").checked ? currentAgentContext() : undefined,
      },
    });
    agentMessages.push({ role: "assistant", content: `[${provider} · ${response.model}]\n${response.message}` });
    renderAgentMessages();
    setStatus("Agent response received");
  } catch (error) {
    agentMessages.push({ role: "assistant", content: `Agent error: ${error}` });
    renderAgentMessages();
    setStatus("Agent request failed");
  }
}

function renderDiagnosticResult(target: string, content: string, error = false) {
  const result = $(target);
  result.classList.remove("hidden");
  result.classList.toggle("diagnostic-error", error);
  const copyBtn = content && !content.endsWith("…") ? `<button type="button" class="btn-flat diag-copy-btn">Copy</button>` : "";
  result.innerHTML = `${content}${copyBtn}`;
  const btn = result.querySelector<HTMLButtonElement>(".diag-copy-btn");
  if (btn) {
    btn.addEventListener("click", () => {
      const clone = result.cloneNode(true) as HTMLElement;
      clone.querySelector(".diag-copy-btn")?.remove();
      void navigator.clipboard.writeText(clone.innerText.trim()).then(() => {
        btn.textContent = "Copied!";
        setTimeout(() => { btn.textContent = "Copy"; }, 1500);
      });
    });
  }
}

async function runDnsLookup(event: Event) {
  event.preventDefault();
  const host = $<HTMLInputElement>("#dns-host").value.trim();
  if (!host) return;
  renderDiagnosticResult("#dns-result", "Resolving…");
  try {
    const response = await invoke<DnsLookupResponse>("dns_lookup", { hostname: host });
    renderDiagnosticResult(
      "#dns-result",
      `<strong>${escapeHtml(response.addresses.length ? `${response.addresses.length} address${response.addresses.length === 1 ? "" : "es"}` : "No addresses found")}</strong><span>${escapeHtml(response.addresses.join(" · ") || "—")}</span><small>${escapeHtml(response.durationMs)} ms · IPv4 ${response.ipv4.length} · IPv6 ${response.ipv6.length}</small>`
    );
    setStatus(`DNS lookup complete for ${response.hostname}`);
  } catch (error) {
    renderDiagnosticResult("#dns-result", escapeHtml(String(error)), true);
    setStatus("DNS lookup failed");
  }
}

async function runTlsInspection(event: Event) {
  event.preventDefault();
  const host = $<HTMLInputElement>("#tls-host").value.trim();
  const port = Number($<HTMLInputElement>("#tls-port").value) || 443;
  if (!host) return;
  renderDiagnosticResult("#tls-result", "Inspecting TLS…");
  try {
    const response = await invoke<TlsInspectionResponse>("tls_inspect", { host, port });
    renderDiagnosticResult(
      "#tls-result",
      `<strong>${response.reachable ? "Handshake reachable" : "Handshake failed"}</strong><span>${escapeHtml(response.protocol || "Protocol unavailable")} ${escapeHtml(response.cipher || "")}</span><small>Subject: ${escapeHtml(response.certificateSubject || "Not reported")}</small><small>Issuer: ${escapeHtml(response.certificateIssuer || "Not reported")}</small><small>Expires: ${escapeHtml(response.certificateExpiry || "Not reported")}</small><small>SAN: ${escapeHtml(response.san || "Not reported")}</small><small>Verification: ${escapeHtml(response.verification || "Not reported")} · ALPN: ${escapeHtml(response.alpn || "Not reported")}</small><small>${escapeHtml(response.durationMs)} ms · ${escapeHtml(response.detail)}</small>`,
      !response.reachable
    );
    setStatus(`TLS inspection complete for ${response.host}`);
  } catch (error) {
    renderDiagnosticResult("#tls-result", escapeHtml(String(error)), true);
    setStatus("TLS inspection failed");
  }
}

async function runPing(event: Event) {
  event.preventDefault();
  const host = $<HTMLInputElement>("#ping-host").value.trim();
  if (!host) return;
  renderDiagnosticResult("#ping-result", "Pinging…");
  try {
    const response = await invoke<PingResponse>("ping_host", { host });
    renderDiagnosticResult("#ping-result", `<strong>${response.reachable ? "Reachable" : "Unreachable"}</strong><small>${escapeHtml(response.durationMs)} ms · ${escapeHtml(response.detail)}</small>`, !response.reachable);
  } catch (error) {
    renderDiagnosticResult("#ping-result", escapeHtml(String(error)), true);
  }
}

async function runTcpCheck(event: Event) {
  event.preventDefault();
  const host = $<HTMLInputElement>("#tcp-host").value.trim();
  const port = Number($<HTMLInputElement>("#tcp-port").value);
  if (!host || !port) return;
  renderDiagnosticResult("#tcp-result", "Connecting…");
  try {
    const response = await invoke<TcpCheckResponse>("tcp_check", { host, port });
    renderDiagnosticResult("#tcp-result", `<strong>${response.reachable ? "Port reachable" : "Port unavailable"}</strong><small>${escapeHtml(response.durationMs)} ms · ${escapeHtml(response.detail)}</small>`, !response.reachable);
  } catch (error) {
    renderDiagnosticResult("#tcp-result", escapeHtml(String(error)), true);
  }
}

async function runTraceroute(event: Event) {
  event.preventDefault();
  const host = $<HTMLInputElement>("#trace-host").value.trim();
  if (!host) return;
  renderDiagnosticResult("#trace-result", "Tracing…");
  try {
    const response = await invoke<TracerouteResponse>("traceroute_host", { host });
    renderDiagnosticResult("#trace-result", `<strong>${escapeHtml(response.detail)}</strong>${response.hops.map((hop) => `<span>${escapeHtml(hop)}</span>`).join("")}<small>${escapeHtml(response.durationMs)} ms</small>`, false);
  } catch (error) {
    renderDiagnosticResult("#trace-result", escapeHtml(String(error)), true);
  }
}

async function loadNetworkInfo() {
  renderDiagnosticResult("#network-result", "Inspecting…");
  try {
    const response = await invoke<NetworkInfoResponse>("get_network_info");
    renderDiagnosticResult("#network-result", escapeHtml(`INTERFACES\n${response.interfaces}\n\nROUTES\n${response.routes}\n\nDNS\n${response.dnsConfig}`));
  } catch (error) {
    renderDiagnosticResult("#network-result", escapeHtml(String(error)), true);
  }
}

async function importPcap() {
  try {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Packet Capture", extensions: ["pcap", "pcapng", "cap"] }],
    });
    if (!selected || typeof selected !== "string") return;
    renderDiagnosticResult("#pcap-result", "Importing…");
    const response = await invoke<PcapImportResponse>("import_pcap", { path: selected });
    renderDiagnosticResult("#pcap-result", `<strong>${escapeHtml(response.format)} · ${escapeHtml(response.sizeBytes)} bytes</strong><small>${escapeHtml(response.detail)}</small>`);
  } catch (error) {
    renderDiagnosticResult("#pcap-result", escapeHtml(String(error)), true);
  }
}

function openSaveWorkspaceDialog() {
  const dialog = $<HTMLDialogElement>("#dialog-save-workspace");
  dialog.showModal();
}

function handleSaveWorkspace(event: Event) {
  event.preventDefault();
  const name = $<HTMLInputElement>("#save-workspace-name").value.trim();
  if (!name) return;
  $<HTMLDialogElement>("#dialog-save-workspace").close();
  void invoke<WorkspaceInfo>("save_workspace", { workspace: { version: 1, name, requests: history } })
    .then(() => setStatus(`Workspace ${name} saved`))
    .catch((error) => setStatus(`Workspace save failed: ${error}`));
}

async function openLoadWorkspaceDialog() {
  try {
    const workspaces = await invoke<WorkspaceInfo[]>("list_workspaces");
    const select = $<HTMLSelectElement>("#load-workspace-select");
    if (!workspaces.length) {
      select.innerHTML = `<option value="">No saved workspaces found</option>`;
    } else {
      select.innerHTML = workspaces.map((w) => `<option value="${escapeHtml(w.name)}">${escapeHtml(w.name)} (${w.requestCount} requests)</option>`).join("");
    }
    const dialog = $<HTMLDialogElement>("#dialog-load-workspace");
    dialog.showModal();
  } catch (error) {
    setStatus(`Failed to list workspaces: ${error}`);
  }
}

function handleLoadWorkspace(event: Event) {
  event.preventDefault();
  const name = $<HTMLSelectElement>("#load-workspace-select").value;
  if (!name) return;
  $<HTMLDialogElement>("#dialog-load-workspace").close();
  void invoke<{ name: string; requests: CurlRequest[] }>("load_workspace", { name })
    .then((workspace) => {
      history = workspace.requests;
      renderHistory();
      setStatus(`Workspace ${workspace.name} loaded`);
    })
    .catch((error) => setStatus(`Workspace load failed: ${error}`));
}

async function exportReport() {
  try {
    const selected = await save({
      defaultPath: "aria-report.json",
      filters: [
        { name: "JSON", extensions: ["json"] },
        { name: "Markdown", extensions: ["md"] },
        { name: "HTML", extensions: ["html"] },
      ],
    });
    if (!selected) return;
    const format = selected.toLowerCase().endsWith(".html") ? "html" : selected.toLowerCase().endsWith(".md") ? "md" : "json";
    await invoke("export_report", { path: selected, format, title: "Aria Network Report", payload: { generatedBy: "Aria", requests: history } });
    setStatus(`Report exported to ${selected}`);
  } catch (error) {
    setStatus(`Report export failed: ${error}`);
  }
}

async function openSettingsDialog() {
  try {
    const settings = await invoke<AppSettings>("load_settings");
    $<HTMLInputElement>("#settings-host").value = settings.host || "localhost";
    $<HTMLInputElement>("#settings-port").value = String(settings.port || 6800);
    $<HTMLInputElement>("#settings-download-dir").value = settings.download_dir || "";
    $<HTMLInputElement>("#settings-max-concurrent").value = settings.max_concurrent_downloads || "3";
    $<HTMLInputElement>("#settings-max-download-limit").value = settings.max_overall_download_limit || "0";
    $<HTMLDialogElement>("#dialog-settings").showModal();
  } catch (error) {
    setStatus(`Failed to load settings: ${error}`);
  }
}

async function browseDownloadDir() {
  try {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      $<HTMLInputElement>("#settings-download-dir").value = selected;
    }
  } catch (error) {
    setStatus(`Failed to select directory: ${error}`);
  }
}

function handleSaveSettings(event: Event) {
  event.preventDefault();
  const settings: AppSettings = {
    host: $<HTMLInputElement>("#settings-host").value.trim() || "localhost",
    port: Number($<HTMLInputElement>("#settings-port").value) || 6800,
    download_dir: $<HTMLInputElement>("#settings-download-dir").value.trim(),
    max_concurrent_downloads: $<HTMLInputElement>("#settings-max-concurrent").value.trim() || "3",
    max_overall_download_limit: $<HTMLInputElement>("#settings-max-download-limit").value.trim() || "0",
    max_overall_upload_limit: "0",
  };
  $<HTMLDialogElement>("#dialog-settings").close();
  void invoke("save_settings", { settings })
    .then(() => setStatus("Workbench settings saved"))
    .catch((error) => setStatus(`Failed to save settings: ${error}`));
}

function openTransferDialog() {
  const dialog = $<HTMLDialogElement>("#dialog-transfer");
  $<HTMLInputElement>("#transfer-input-url").value = "";
  dialog.showModal();
}

async function handleAddTransfer(event: Event) {
  event.preventDefault();
  const url = $<HTMLInputElement>("#transfer-input-url").value.trim();
  const engine = $<HTMLSelectElement>("#transfer-engine-select").value;
  if (!url) return;
  $<HTMLDialogElement>("#dialog-transfer").close();
  try {
    const options = {};
    if (engine === "aria2") {
      await invoke("add_uri", { uris: [url], options });
    } else {
      await invoke("add_curl", { url, options });
    }
    showTool("downloads");
    await refreshDownloads();
    setStatus(`Transfer added via ${engine}`);
  } catch (error) {
    setStatus(`Transfer failed: ${error}`);
  }
}

function loadRequest(request: CurlRequest) {
  $<HTMLSelectElement>("#request-method").value = request.method;
  $<HTMLInputElement>("#request-url").value = request.url;
  headers = request.headers.length ? request.headers : [{ name: "", value: "" }];
  renderHeaderRows();
  $<HTMLTextAreaElement>("#request-body-input").value = request.body || "";
  $<HTMLInputElement>("#opt-follow").checked = request.followRedirects;
  $<HTMLInputElement>("#opt-compressed").checked = request.compressed;
  $<HTMLInputElement>("#opt-insecure").checked = request.insecure;
  $<HTMLInputElement>("#opt-ipv4").checked = request.ipv4;
  $<HTMLInputElement>("#opt-ipv6").checked = request.ipv6;
  $<HTMLInputElement>("#request-timeout").value = String(request.timeout || 30);
  $<HTMLInputElement>("#request-connect-timeout").value = String(request.connectTimeout || 10);
  $<HTMLInputElement>("#request-max-redirects").value = String(request.maxRedirects || 20);
  $<HTMLInputElement>("#request-user-agent").value = request.userAgent || "";
  $<HTMLInputElement>("#request-referer").value = request.referer || "";
  $<HTMLInputElement>("#request-proxy").value = request.proxy || "";
  $<HTMLInputElement>("#request-username").value = request.username || "";
  $<HTMLInputElement>("#request-password").value = request.password || "";
  $<HTMLInputElement>("#request-cookies").value = request.cookies || "";
  const auth = request.headers.find((h) => h.name.toLowerCase() === "authorization" && h.value.toLowerCase().startsWith("bearer "));
  $<HTMLInputElement>("#request-bearer").value = auth ? auth.value.slice(7).trim() : "";
  $<HTMLInputElement>("#request-ca").value = request.caCertificate || "";
  $<HTMLInputElement>("#request-cert").value = request.clientCertificate || "";
  $<HTMLInputElement>("#request-key").value = request.privateKey || "";
  showTool("request");
  setStatus("Request loaded from history");
}

function renderDownloads() {
  const list = $("#downloads-list");
  if (!downloads.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">↓</div><p>No active transfers</p></div>`;
    return;
  }
  list.innerHTML = downloads
    .map((item) => {
      const total = Number(item.totalLength) || 0;
      const completed = Number(item.completedLength) || 0;
      const pct = total ? Math.min(100, (completed / total) * 100) : 0;
      const name = item.files?.[0]?.path?.split(/[\\/]/).pop() || item.gid;
      return `<div class="transfer-row"><div class="transfer-top"><span class="transfer-status">${escapeHtml(item.status)}</span><strong>${escapeHtml(name)}</strong><span class="transfer-gid">${escapeHtml(item.gid)}</span><button class="icon-btn" data-transfer-delete="${escapeHtml(item.gid)}">×</button></div><div class="transfer-progress"><i style="width:${pct}%"></i></div><div class="transfer-meta"><span>${completed ? `${formatBytes(completed)} / ${formatBytes(total)}` : "Waiting for metadata"}</span><span>${escapeHtml(item.errorMessage || "")}</span></div></div>`;
    })
    .join("");
  list.querySelectorAll<HTMLButtonElement>("[data-transfer-delete]").forEach((button) =>
    button.addEventListener("click", async () => {
      const gid = button.dataset.transferDelete!;
      if (window.confirm("Permanently delete this transfer and its files?")) {
        await invoke("remove_download", { gid, deleteFiles: true });
        await refreshDownloads();
      }
    })
  );
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

async function refreshDownloads() {
  try {
    downloads = await invoke<DownloadItem[]>("get_downloads");
    renderDownloads();
  } catch (error) {
    setStatus(`Transfers unavailable: ${error}`);
  }
}

function startDownloadPolling() {
  if (downloadTimer) return;
  void refreshDownloads();
  downloadTimer = setInterval(() => void refreshDownloads(), 1500);
}

function handleNetworkKeyDown(event: KeyboardEvent) {
  if (document.querySelector(".tool-view.active")?.id !== "tool-network") return;
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;

  const filtered = getFilteredRequests();
  if (!filtered.length) return;

  const currentIndex = filtered.findIndex((r) => r.id === selectedRequestId);

  if (event.key === "ArrowDown") {
    event.preventDefault();
    const nextIndex = currentIndex < filtered.length - 1 ? currentIndex + 1 : 0;
    selectNetworkRequest(filtered[nextIndex].id);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    const prevIndex = currentIndex > 0 ? currentIndex - 1 : filtered.length - 1;
    selectNetworkRequest(filtered[prevIndex].id);
  } else if (event.key === "Escape") {
    selectNetworkRequest(null);
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "e") {
    event.preventDefault();
    toggleRecording();
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
    event.preventDefault();
    clearCapturedRequests();
  }
}

function init() {
  renderHeaderRows();
  $$(".tool-tab").forEach((tab) => tab.addEventListener("click", () => showTool((tab as HTMLElement).dataset.tool!)));
  $$("[data-open-request]").forEach((button) => button.addEventListener("click", () => showTool("request")));
  $("#dns-form").addEventListener("submit", runDnsLookup);
  $("#tls-form").addEventListener("submit", runTlsInspection);
  $("#ping-form").addEventListener("submit", runPing);
  $("#tcp-form").addEventListener("submit", runTcpCheck);
  $("#trace-form").addEventListener("submit", runTraceroute);
  $("#btn-network-info").addEventListener("click", loadNetworkInfo);
  $("#btn-import-pcap").addEventListener("click", importPcap);
  $("#btn-copy-curl").addEventListener("click", copyCurlCommand);

  // Network Inspector Tool bar & controls
  $("#net-btn-record")?.addEventListener("click", toggleRecording);
  $("#net-btn-clear")?.addEventListener("click", clearCapturedRequests);
  $("#net-opt-preserve")?.addEventListener("change", (e) => {
    preserveLog = (e.target as HTMLInputElement).checked;
  });

  const filterInput = $<HTMLInputElement>("#net-filter-input");
  const filterClear = $("#net-filter-clear");
  filterInput?.addEventListener("input", () => {
    textFilterQuery = filterInput.value;
    filterClear?.classList.toggle("hidden", !textFilterQuery);
    updateNetworkView();
  });
  filterClear?.addEventListener("click", () => {
    filterInput.value = "";
    textFilterQuery = "";
    filterClear.classList.add("hidden");
    updateNetworkView();
  });

  $$(".filter-chips .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      $$(".filter-chips .chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      activeTypeFilter = (chip as HTMLElement).dataset.type || "all";
      updateNetworkView();
    });
  });

  $("#net-btn-view-requests")?.addEventListener("click", () => {
    activeNetworkView = "requests";
    $("#net-btn-view-requests")?.classList.add("active");
    $("#net-btn-view-discovery")?.classList.remove("active");
    $("#net-view-table")?.classList.remove("net-view-hidden");
    $("#net-view-table")?.classList.add("net-view-active");
    $("#net-view-discovery")?.classList.add("net-view-hidden");
    $("#net-view-discovery")?.classList.remove("net-view-active");
  });

  $("#net-btn-view-discovery")?.addEventListener("click", () => {
    activeNetworkView = "discovery";
    $("#net-btn-view-discovery")?.classList.add("active");
    $("#net-btn-view-requests")?.classList.remove("active");
    $("#net-view-discovery")?.classList.remove("net-view-hidden");
    $("#net-view-discovery")?.classList.add("net-view-active");
    $("#net-view-table")?.classList.add("net-view-hidden");
    $("#net-view-table")?.classList.remove("net-view-active");
    renderEndpointDiscovery();
  });

  $("#net-btn-export-har")?.addEventListener("click", exportHar);
  $("#net-btn-import-har")?.addEventListener("click", importHar);
  $("#disc-btn-export-openapi")?.addEventListener("click", exportOpenApi);

  // Drawer event bindings
  $$(".drawer-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      activeDrawerTab = (tab as HTMLElement).dataset.drawerTab as typeof activeDrawerTab;
      if (selectedRequestId) {
        const req = capturedRequests.find((r) => r.id === selectedRequestId);
        if (req) renderDrawerTab(req);
      }
    });
  });

  $("#drawer-btn-close")?.addEventListener("click", () => selectNetworkRequest(null));

  $("#drawer-btn-redaction")?.addEventListener("click", () => {
    redactionActive = !redactionActive;
    if (selectedRequestId) {
      const req = capturedRequests.find((r) => r.id === selectedRequestId);
      if (req) selectNetworkRequest(req.id);
    }
  });

  $("#drawer-btn-curl")?.addEventListener("click", () => {
    if (!selectedRequestId) return;
    const req = capturedRequests.find((r) => r.id === selectedRequestId);
    if (!req) return;
    const cmd = buildCurlCommand(req.curlRequest);
    void navigator.clipboard.writeText(cmd).then(() => setStatus("Request copied as cURL"));
  });

  $("#drawer-btn-fetch")?.addEventListener("click", () => {
    if (!selectedRequestId) return;
    const req = capturedRequests.find((r) => r.id === selectedRequestId);
    if (!req) return;
    const snippet = buildFetchSnippet(req);
    void navigator.clipboard.writeText(snippet).then(() => setStatus("Request copied as fetch() snippet"));
  });

  $("#drawer-btn-replay")?.addEventListener("click", () => {
    if (!selectedRequestId) return;
    const req = capturedRequests.find((r) => r.id === selectedRequestId);
    if (req) replayRequest(req);
  });

  $("#form-confirm-replay")?.addEventListener("submit", (e) => {
    e.preventDefault();
    $<HTMLDialogElement>("#dialog-confirm-replay")?.close();
    if (pendingReplayRequest) {
      void executeReplay(pendingReplayRequest);
      pendingReplayRequest = null;
    }
  });

  document.addEventListener("keydown", handleNetworkKeyDown);

  // Dialog wire-up
  $$("dialog.adw-dialog").forEach((dlg) => {
    const dialog = dlg as HTMLDialogElement;
    dialog.querySelectorAll(".dialog-close, .dialog-cancel").forEach((btn) => btn.addEventListener("click", () => dialog.close()));
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog.close();
    });
  });

  $("#btn-save-workspace").addEventListener("click", openSaveWorkspaceDialog);
  $("#form-save-workspace").addEventListener("submit", handleSaveWorkspace);
  $("#btn-load-workspace").addEventListener("click", openLoadWorkspaceDialog);
  $("#form-load-workspace").addEventListener("submit", handleLoadWorkspace);
  $("#btn-export-report").addEventListener("click", exportReport);
  $("#btn-settings").addEventListener("click", openSettingsDialog);
  $("#btn-browse-download-dir").addEventListener("click", browseDownloadDir);
  $("#form-settings").addEventListener("submit", handleSaveSettings);
  $("#btn-add-download").addEventListener("click", openTransferDialog);
  $("#form-transfer").addEventListener("submit", handleAddTransfer);

  $("#request-form").addEventListener("submit", sendRequest);
  $("#agent-form").addEventListener("submit", sendAgentMessage);
  $("#btn-new-request").addEventListener("click", () => {
    loadRequest({ method: "GET", url: "", headers: [{ name: "", value: "" }], followRedirects: true, compressed: false, insecure: false, ipv4: false, ipv6: false });
  });
  $("#btn-add-header").addEventListener("click", () => {
    headers.push({ name: "", value: "" });
    renderHeaderRows();
  });
  $$(".request-tab").forEach((button) => button.addEventListener("click", () => setRequestTab((button as HTMLElement).dataset.requestTab as RequestTab)));
  $$(".response-tab").forEach((button) => button.addEventListener("click", () => setResponseTab((button as HTMLElement).dataset.responseTab as ResponseTab)));
  showTool("request");
}

document.addEventListener("DOMContentLoaded", init);

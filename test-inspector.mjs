import assert from "node:assert";

// 1. Path segment clustering test
function clusterPath(pathname) {
  const segments = pathname.split("/").filter(Boolean);
  const patternSegments = [];
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
  return "/" + patternSegments.join("/");
}

assert.strictEqual(clusterPath("/api/v1/users/12345"), "/api/v1/users/{userId}");
assert.strictEqual(clusterPath("/api/v1/users/550e8400-e29b-41d4-a716-446655440000/posts/42"), "/api/v1/users/{uuid}/posts/{postId}");
assert.strictEqual(clusterPath("/files/c3ab8ff13720e8ad9047dd39466b3c89"), "/files/{hash}");

// 2. Sensitive header redaction test
function isSensitiveHeader(name) {
  const lower = name.toLowerCase();
  return lower === "authorization" || lower === "cookie" || lower === "set-cookie" ||
         lower === "x-api-key" || lower === "proxy-authorization" || lower === "api-key";
}

assert.strictEqual(isSensitiveHeader("Authorization"), true);
assert.strictEqual(isSensitiveHeader("Cookie"), true);
assert.strictEqual(isSensitiveHeader("Set-Cookie"), true);
assert.strictEqual(isSensitiveHeader("Content-Type"), false);

// 3. Resource type inference test
function inferResourceType(contentType, urlStr, method) {
  const ct = (contentType || "").toLowerCase();
  const urlLower = (urlStr || "").toLowerCase();
  if (ct.includes("text/html")) return "doc";
  if (ct.includes("text/css") || urlLower.endsWith(".css")) return "css";
  if (ct.includes("javascript") || urlLower.endsWith(".js")) return "js";
  if (ct.startsWith("image/") || /\.(png|jpg|svg)(\?.*)?$/i.test(urlLower)) return "img";
  if (ct.includes("json") || (method && method !== "GET")) return "fetch";
  return "other";
}

assert.strictEqual(inferResourceType("application/json", "https://api.test/data", "GET"), "fetch");
assert.strictEqual(inferResourceType("text/html; charset=utf-8", "https://test.com/", "GET"), "doc");
assert.strictEqual(inferResourceType("image/png", "https://test.com/logo.png", "GET"), "img");

console.log("All inspector unit asserts passed successfully.");

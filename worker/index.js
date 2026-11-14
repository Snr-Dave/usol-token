"use strict";

const RPC_PATH = "/api/rpc";
const RPC_METHODS = new Set(["getBalance", "getTokenAccountsByOwner"]);
const RPC_BODY_LIMIT = 4096;
const DEFAULT_TIMEOUT_MS = 15000;
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const STATIC_ROUTES = new Set([
  "/",
  "/index.html",
  "/project-information",
  "/support",
  "/styles.css",
  "/theme.css",
  "/wallet-core.js",
  "/wallet-discovery.js",
  "/token.js",
  "/nav.js",
  "/wallet-home.js",
  "/theme.js",
  "/assets/brand/usol-logo.png"
]);

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

function rpcError(status, message) {
  return jsonResponse(status, {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32000, message }
  });
}

function rpcEndpoint(env) {
  const configured = String(env.SOLANA_RPC_URL || "").trim();
  if (configured) return configured;

  const apiKey = String(env.HELIUS_API_KEY || "").trim();
  if (apiKey) {
    return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
  }

  return "https://api.mainnet-beta.solana.com";
}

async function readLimitedBody(request) {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > RPC_BODY_LIMIT) {
    throw new Error("BODY_TOO_LARGE");
  }

  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      size += value.byteLength;
      if (size > RPC_BODY_LIMIT) {
        await reader.cancel();
        throw new Error("BODY_TOO_LARGE");
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(body);
}

function validateRpcRequest(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "Expected a single JSON-RPC request object.";
  }

  if (payload.jsonrpc !== "2.0" || typeof payload.method !== "string") {
    return "Expected a JSON-RPC 2.0 request.";
  }

  if (!RPC_METHODS.has(payload.method)) {
    return "This endpoint serves read-only balance requests only.";
  }

  if (!Array.isArray(payload.params) || payload.params.length === 0) {
    return "Missing RPC parameters.";
  }

  if (
    typeof payload.params[0] !== "string" ||
    !BASE58_ADDRESS.test(payload.params[0])
  ) {
    return "Expected a Solana public address as the first parameter.";
  }

  return null;
}

async function handleRpc(request, env) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed\n", {
      status: 405,
      headers: {
        allow: "POST",
        "content-type": "text/plain; charset=utf-8"
      }
    });
  }

  let payload;

  try {
    payload = JSON.parse(await readLimitedBody(request));
  } catch (error) {
    const tooLarge = error && error.message === "BODY_TOO_LARGE";
    return rpcError(
      tooLarge ? 413 : 400,
      tooLarge ? "Request body is too large." : "Expected a JSON request body."
    );
  }

  const problem = validateRpcRequest(payload);
  if (problem) return rpcError(400, problem);

  const timeoutValue = Number(env.USOL_RPC_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(timeoutValue) && timeoutValue > 0
      ? Math.min(timeoutValue, 30000)
      : DEFAULT_TIMEOUT_MS;

  let upstream;

  try {
    upstream = await fetch(rpcEndpoint(env), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id === undefined ? null : payload.id,
        method: payload.method,
        params: payload.params
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    if (error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      return rpcError(504, "Solana Mainnet RPC timed out. Try again.");
    }

    return rpcError(502, "Solana Mainnet RPC is unreachable. Try again.");
  }

  if (!upstream.ok) {
    return rpcError(
      502,
      `Solana Mainnet RPC returned HTTP ${upstream.status}.`
    );
  }

  let result;

  try {
    result = await upstream.json();
  } catch (_) {
    return rpcError(502, "Solana Mainnet RPC returned an unreadable response.");
  }

  if (result && result.error) {
    const message =
      typeof result.error.message === "string" && result.error.message.trim()
        ? result.error.message.trim().slice(0, 300)
        : "Solana Mainnet RPC returned an error.";

    return rpcError(200, message);
  }

  return jsonResponse(200, {
    jsonrpc: "2.0",
    id: payload.id === undefined ? null : payload.id,
    result: result ? result.result : null
  });
}

async function serveStatic(request, env, pathname) {
  const assetPath =
    pathname === "/" ? "/index.html" :
    pathname === "/project-information" ? "/project-information.html" :
    pathname === "/support" ? "/support.html" :
    pathname;

  const assetUrl = new URL(assetPath, request.url);
  const assetRequest = new Request(assetUrl, request);

  let response;

  try {
    response = await env.ASSETS.fetch(assetRequest);
  } catch (_) {
    return new Response("Could not read the application files.\n", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }

  if (response.status === 404) {
    return new Response("Not Found\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }

  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");

  return new Response(request.method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === RPC_PATH) {
      return handleRpc(request, env);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed\n", {
        status: 405,
        headers: { allow: "GET, HEAD" }
      });
    }

    if (!STATIC_ROUTES.has(pathname)) {
      return new Response("Not Found\n", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }

    return serveStatic(request, env, pathname);
  }
};

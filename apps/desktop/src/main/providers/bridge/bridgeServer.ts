/**
 * Local HTTP server that impersonates an Anthropic `/v1/messages` endpoint.
 *
 * The Claude binary is pointed at this server via `ANTHROPIC_BASE_URL`. It
 * receives Anthropic-formatted POST bodies, translates each to OpenAI's
 * `/v1/chat/completions` format, forwards to the real upstream, and streams
 * the OpenAI SSE response back re-translated into Anthropic SSE.
 *
 * ## Lifecycle
 *
 * Created lazily per upstream config and owned by {@link BridgeRegistry}
 * (which reference-counts so multiple sessions on the same config share one
 * server). `close()` stops listening and frees the port; outstanding requests
 * are left to finish or time out on their own (the registry only closes on
 * config release or app shutdown).
 *
 * ## Why a fresh port per server
 *
 * `listen(0)` lets the OS hand back a free ephemeral port, so we never clash
 * with anything the user is running, and never need a config knob.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { log } from "@main/lib/logger.js";
import { anthropicToOpenAI } from "./requestTranslator.js";
import { OpenAiToAnthropicSse } from "./responseTranslator.js";
import type {
  AnthropicRequest,
  AnthropicSseEvent,
  OpenAIChunk,
  OpenAIRequest,
  UpstreamConfig,
} from "./types.js";

/** A handle to a running bridge server. */
export interface BridgeHandle {
  /** The local URL the Claude binary should use as ANTHROPIC_BASE_URL. */
  readonly localUrl: string;
  /** An opaque token the binary sends back; the server accepts any value —
   *  this exists only so the env-var contract (`ANTHROPIC_AUTH_TOKEN`) is
   *  satisfied. The real upstream credential is held inside the server. */
  readonly routeToken: string;
  /** Stop listening. Idempotent. */
  close(): void;
}

/** Whether an upstream base URL looks like an Azure OpenAI deployment.
 *  Azure uses a different path shape and the `api-key` header (not Bearer). */
function looksLikeAzure(baseUrl: string): boolean {
  return /azure\.com/i.test(baseUrl);
}

/** Read and JSON-parse an incoming request body, with a size guard. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const LIMIT = 32 * 1024 * 1024; // 32 MB guard against runaway bodies
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > LIMIT) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("error", reject);
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

/** Build the upstream request headers (auth differs between OpenAI & Azure). */
function upstreamHeaders(upstream: UpstreamConfig, jsonBody: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "Content-Length": Buffer.byteLength(jsonBody).toString(),
  };
  if (looksLikeAzure(upstream.baseUrl)) {
    // Azure OpenAI: `api-key` header, and api-version comes as a query param
    // (added in buildUpstreamUrl).
    headers["api-key"] = upstream.authToken;
  } else {
    // Standard OpenAI / OpenAI-compatible: Bearer token. Both authMode values
    // (auth_token / api_key) map to Bearer here — the distinction only mattered
    // for the Anthropic env vars; on the OpenAI wire it's always Bearer.
    headers["Authorization"] = `Bearer ${upstream.authToken}`;
  }
  return headers;
}

/** Build the full upstream URL, normalizing the path and adding Azure's
 *  api-version query param when applicable. */
function buildUpstreamUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (looksLikeAzure(baseUrl)) {
    // Azure deployments are addressed as {base}/openai/deployments/{deployment}
    // and require `?api-version=`. We assume the user's baseUrl already points
    // at a chat completions path (or the deployment root); we just ensure the
    // version is present and the path ends in /chat/completions.
    const sep = trimmed.includes("?") ? "&" : "?";
    const withVersion = trimmed.includes("api-version=")
      ? trimmed
      : `${trimmed}${sep}api-version=2024-10-21`;
    return withVersion.replace(/\/?$/, "/chat/completions");
  }
  // OpenAI-compatible: ensure it ends at /v1/chat/completions. If the user
  // already included the full path, leave it; if they stopped at /v1, append
  // the rest; otherwise add the whole /v1/chat/completions suffix.
  if (/\/v1\/chat\/completions\/?$/i.test(trimmed)) {
    return trimmed.replace(/\/+$/, "");
  }
  if (/\/v1\/?$/i.test(trimmed)) {
    return `${trimmed.replace(/\/+$/, "")}/chat/completions`;
  }
  return `${trimmed}/v1/chat/completions`;
}

/** Write one Anthropic SSE event to the response, framed as
 *  `event: <type>\ndata: <json>\n\n`. */
function writeSseEvent(res: ServerResponse, ev: AnthropicSseEvent): void {
  res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
}

/** Send a minimal Anthropic-shaped error back to the binary. We use a 400 with
 *  an `error` JSON body so the SDK surfaces a readable message. */
function sendError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    // Mid-stream — best we can do is a message_delta stop; just end.
    res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      type: "error",
      error: { type: "bridge_error", message },
    }),
  );
}

/** Handle a single `/v1/messages` POST: translate → forward → stream back. */
async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: UpstreamConfig,
): Promise<void> {
  let body: AnthropicRequest;
  try {
    const parsed = (await readJsonBody(req)) as AnthropicRequest;
    body = parsed;
  } catch (err) {
    sendError(res, 400, `invalid request body: ${(err as Error).message}`);
    return;
  }

  const openaiReq: OpenAIRequest = anthropicToOpenAI(body);
  // Always stream upstream and re-frame on our side — even non-streaming
  // Anthropic requests can be served from a streaming OpenAI response (we'd
  // just collect the deltas). For the POC we forward stream as-is.
  openaiReq.stream = true;

  const upstreamUrl = buildUpstreamUrl(upstream.baseUrl);
  const jsonBody = JSON.stringify(openaiReq);
  const ac = new AbortController();
  if (upstream.timeoutMs) {
    setTimeout(() => ac.abort(), upstream.timeoutMs).unref();
  }
  // If the client disconnects, abort the upstream fetch.
  req.on("close", () => ac.abort());

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders(upstream, jsonBody),
      body: jsonBody,
      signal: ac.signal,
    });
  } catch (err) {
    const msg = (err as Error).message || String(err);
    log.error(`bridge: upstream fetch failed: ${msg}`);
    sendError(res, 502, `upstream unreachable: ${msg}`);
    return;
  }

  if (!upstreamRes.ok || !upstreamRes.body) {
    // Surface the upstream error text so the user sees auth/model failures.
    const errText = await upstreamRes.text().catch(() => "");
    log.warn(`bridge: upstream ${upstreamRes.status}: ${errText.slice(0, 500)}`);
    sendError(res, upstreamRes.status || 502, errText.slice(0, 1000) || `upstream ${upstreamRes.status}`);
    return;
  }

  // Stream headers — Anthropic SSE.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const translator = new OpenAiToAnthropicSse();
  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });

      // OpenAI SSE frames are separated by blank lines. Process whole frames,
      // keeping any partial tail in the buffer for the next chunk.
      let sep: number;
      while ((sep = sseBuffer.indexOf("\n\n")) >= 0) {
        const frame = sseBuffer.slice(0, sep);
        sseBuffer = sseBuffer.slice(sep + 2);
        // Each frame is one or more `data: ...` lines. OpenAI sends a single
        // data line per frame; we parse anything that starts with "data:".
        const dataLines = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart());
        const dataStr = dataLines.join("\n");
        if (!dataStr || dataStr === "[DONE]") {
          // [DONE] is the terminator — close out below after the loop.
          continue;
        }
        let chunk: OpenAIChunk;
        try {
          chunk = JSON.parse(dataStr) as OpenAIChunk;
        } catch {
          // Malformed frame — skip rather than kill the whole stream.
          continue;
        }
        for (const ev of translator.feed(chunk)) {
          writeSseEvent(res, ev);
        }
      }
    }
    // Stream ended. Close any open block + emit message_delta/message_stop.
    // We don't know a precise stop_reason from a bare stream end; the final
    // chunk's finish_reason would have been fed already if present.
    for (const ev of translator.finish(undefined)) {
      writeSseEvent(res, ev);
    }
  } catch (err) {
    log.error(`bridge: stream read failed: ${(err as Error).message}`);
  } finally {
    res.end();
  }
}

/** Start a bridge server bound to a random local port. Resolves once listening. */
export async function startBridge(upstream: UpstreamConfig): Promise<BridgeHandle> {
  const server: Server = createServer((req, res) => {
    // The Claude binary POSTs to {baseUrl}/v1/messages. Accept either
    // /v1/messages or a bare /messages for robustness.
    //
    // IMPORTANT: strip the query string before matching. The binary appends
    // `?beta=true` to the path when ANTHROPIC_MODEL is a non-first-party name
    // (it negotiates the anthropic-beta capability via query instead of a
    // header on third-party routes). A bare `endsWith("/v1/messages")` fails
    // to match `/v1/messages?beta=true`, so the request fell through to the
    // 404 branch and the binary interpreted that 404 as "selected model may
    // not exist" - which is exactly the failure users saw with OpenAI-format
    // gateways (e.g. MiniMax-M3). Matching on the path alone fixes it.
    const rawUrl = req.url ?? "";
    const path = rawUrl.split("?", 2)[0];
    if (req.method === "POST" && (path.endsWith("/v1/messages") || path.endsWith("/messages"))) {
      handleMessages(req, res, upstream).catch((err) => {
        log.error(`bridge: handler threw: ${(err as Error).message}`);
        sendError(res, 500, "internal bridge error");
      });
      return;
    }
    // Anything else (health probes, GET) → 404. The binary only POSTs messages.
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { message: "not found" } }));
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("failed to bind bridge server"));
    });
  });

  const routeToken = randomBytes(12).toString("hex");
  log.info(`bridge: listening on 127.0.0.1:${port} → ${upstream.baseUrl}`);

  return {
    localUrl: `http://127.0.0.1:${port}`,
    routeToken,
    close: () => {
      server.close(() => log.info(`bridge: closed 127.0.0.1:${port}`));
    },
  };
}

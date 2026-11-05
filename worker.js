/**
 * DuckAI Chat Studio — Cloudflare Worker relay (no Python needed)
 * ---------------------------------------------------------------
 * Deploy this single file as a Cloudflare Worker (free plan is enough):
 *
 *   1. dash.cloudflare.com → Workers & Pages → Create → Worker
 *   2. paste this file, Deploy
 *   3. copy the worker URL, e.g. https://duckai-relay.you.workers.dev
 *   4. put that URL in config.js (`relay: "..."`) or in the site's settings
 *
 * Routes:
 *   GET  /api/health  -> {"ok":true} if Duck.ai is reachable
 *   POST /api/chat    -> Server-Sent Events stream, same shape as app.py
 *
 * Protocol: GET  https://duckduckgo.com/duckchat/v1/status   (x-vqd-accept: 1)
 *           -> response header x-vqd-4
 *           POST https://duckduckgo.com/duckchat/v1/chat     (x-vqd-4, JSON body)
 *           -> text/event-stream: data: {"message":"..."} … data: [DONE]
 */

const DDG = "https://duckduckgo.com";
const STATUS_URL = DDG + "/duckchat/v1/status";
const CHAT_URL = DDG + "/duckchat/v1/chat";
const DEFAULT_MODEL = "gpt-4o-mini";

const MODELS = new Set([
  "gpt-4o-mini",
  "claude-3-haiku-20240307",
  "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  "mistralai/Mistral-Small-24B-Instruct-2501",
  "o3-mini"
]);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Expose-Headers": "*",
  "Access-Control-Max-Age": "86400"
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

function sse(payload) {
  return "data: " + JSON.stringify(payload) + "\n\n";
}

async function getToken() {
  const r = await fetch(STATUS_URL, {
    headers: { "x-vqd-accept": "1", "User-Agent": UA, Accept: "*/*" }
  });
  return r.headers.get("x-vqd-4") || "";
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === "/api/health") {
      try {
        const token = await getToken();
        return token ? json({ ok: true }) : json({ ok: false, error: "blocked", detail: "no x-vqd-4 token" });
      } catch (e) {
        return json({ ok: false, error: "blocked", detail: String(e) });
      }
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: "Invalid JSON body." }, 400);
      }

      const model = MODELS.has(body.model) ? body.model : DEFAULT_MODEL;
      const messages = Array.isArray(body.messages)
        ? body.messages
            .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
            .slice(-40)
            .map(m => ({ role: m.role, content: m.content }))
        : [];

      if (!messages.length) return json({ error: "messages must be a non-empty list." }, 400);

      try {
        const token = await getToken();
        if (!token) throw new Error("Duck.ai did not return an x-vqd-4 token.");

        const upstream = await fetch(CHAT_URL, {
          method: "POST",
          headers: {
            "x-vqd-4": token,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            "User-Agent": UA,
            Origin: DDG,
            Referer: DDG + "/"
          },
          body: JSON.stringify({ model, messages })
        });

        if (!upstream.ok || !upstream.body) {
          const detail =
            upstream.status === 418
              ? "Duck.ai rejected the request (HTTP 418 — anti-bot challenge)."
              : upstream.status === 429
                ? "Duck.ai rate limit reached (HTTP 429)."
                : "Duck.ai chat failed with HTTP " + upstream.status + ".";
          return new Response(sse({ error: detail }) + "data: [DONE]\n\n", {
            headers: { ...CORS, "Content-Type": "text/event-stream; charset=utf-8" }
          });
        }

        return new Response(upstream.body, {
          headers: {
            ...CORS,
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform"
          }
        });
      } catch (e) {
        return new Response(sse({ error: "Relay error: " + String(e) }) + "data: [DONE]\n\n", {
          headers: { ...CORS, "Content-Type": "text/event-stream; charset=utf-8" }
        });
      }
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response("DuckAI relay is running. Open your GitHub Pages site to use it.", {
        headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    return json({ error: "Not found" }, 404);
  }
};

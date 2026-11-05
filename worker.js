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
const DEFAULT_MODEL = "gpt-6-luna";

const MODELS = new Set([
  "gpt-6-luna",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "claude-haiku-4-5",
  "mistral-small-2603"
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

    if (url.pathname === "/api/duckchat" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: "Invalid JSON body." }, 400);
      }

      const model = MODELS.has(body.model) ? body.model : DEFAULT_MODEL;
      const msgs = [];
      if (Array.isArray(body.history)) {
        for (const h of body.history) {
          if (h && typeof h === "object" && (h.role === "user" || h.role === "assistant") && typeof h.content === "string" && h.content.trim()) {
            msgs.push({ role: h.role, content: h.content });
          } else if (typeof h === "string" && h.trim()) {
            msgs.push({ role: msgs.length % 2 === 0 ? "user" : "assistant", content: h });
          }
        }
      }
      if (typeof body.prompt === "string" && body.prompt.trim()) {
        msgs.push({ role: "user", content: body.prompt });
      }
      if (!msgs.length) return json({ error: "prompt is required" }, 400);

      const enc = new TextEncoder();
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const send = (obj) => writer.write(enc.encode("data: " + JSON.stringify(obj) + "\n\n"));

      (async () => {
        try {
          await send({ kind: "status", value: "در حال فکر کردن…" });
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
            body: JSON.stringify({
              model,
              messages: msgs.map(m => ({ role: m.role, content: [{ type: "text", text: m.content }] })),
              canUseTools: false,
              reasoningEffort: "none",
              canShowGreeting: false
            })
          });
          if (!upstream.ok || !upstream.body) {
            throw new Error(
              upstream.status === 418
                ? "Duck.ai rejected the request (HTTP 418 — challenge required)."
                : upstream.status === 429
                  ? "Duck.ai rate limit reached (HTTP 429)."
                  : "Duck.ai chat failed with HTTP " + upstream.status + "."
            );
          }
          const reader = upstream.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const parts = buf.split("\n\n");
            buf = parts.pop();
            for (const part of parts) {
              const line = part.split("\n").find(l => l.startsWith("data:"));
              if (!line) continue;
              const data = line.slice(5).trim();
              if (!data || data === "[DONE]") continue;
              try {
                const obj = JSON.parse(data);
                if (obj.message) await send({ kind: "message", value: obj.message });
              } catch (e) { /* skip */ }
            }
          }
        } catch (e) {
          await send({ kind: "error", value: String(e.message || e) });
        } finally {
          await send({ kind: "done" });
          await writer.close();
        }
      })();

      return new Response(readable, {
        headers: {
          ...CORS,
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform"
        }
      });
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
          body: JSON.stringify({ model, messages: messages.map(m => ({ role: m.role, content: [{ type: "text", text: m.content }] })), canUseTools: false, reasoningEffort: "none", canShowGreeting: false })
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

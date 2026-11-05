/* ===========================================================================
   DuckAI Chat Studio — runtime config
   ---------------------------------------------------------------------------
   Edit this file after deploying; no build step needed.

   relay: address of a small server that talks to Duck.ai on your behalf.
          Leave "" to use the same domain (app.py locally), and the page will
          fall back to calling Duck.ai directly from the browser.

          Examples:
            "https://duckai-relay.your-name.workers.dev"   (Cloudflare Worker, worker.js)
            "https://my-relay.onrender.com"                (app.py on any host)
   =========================================================================== */
window.DUCKAI_CONFIG = {
  relay: ""
};

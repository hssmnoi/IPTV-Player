// Cloudflare Worker — HLS Proxy
// Deploy: https://dash.cloudflare.com
// Worker name: shy-haze-2452
// Live URL: https://shy-haze-2452.natajrak-p.workers.dev/
//
// Usage:
//   https://shy-haze-2452.natajrak-p.workers.dev/?url={encoded_url}&referer={encoded_referer}
//
// Example (kurokamii / akuma-player):
//   https://shy-haze-2452.natajrak-p.workers.dev/?url=https%3A%2F%2Ffiles.akuma-player.xyz%2Fview%2F{uuid}&referer=https%3A%2F%2Fakuma-player.xyz
//
// Features:
//   - CORS bypass (fetch server-side จาก CF edge)
//   - m3u8 URL rewrite: absolute / protocol-relative (//) / relative path (/)
//   - Binary passthrough สำหรับ TS segments
//   - รองรับ Referer + Origin header spoofing

export default {
  async fetch(request) {
    const { searchParams } = new URL(request.url);
    const targetUrl = searchParams.get("url");
    const referer   = searchParams.get("referer") || "";

    if (!targetUrl) {
      return new Response("Missing ?url=", { status: 400 });
    }

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      "Referer": referer,
      "Accept": "*/*",
    };
    if (referer) {
      try { headers["Origin"] = new URL(referer).origin; } catch (_) {}
    }

    let resp = await fetch(targetUrl, { headers, redirect: "follow" });
    const contentType = resp.headers.get("content-type") || "";
    const isHls = contentType.includes("mpegurl")
               || contentType.includes("text/plain")
               || /\.(m3u8|txt)($|\?)/.test(targetUrl)
               || /file2|quality2/.test(targetUrl);

    const workerOrigin = new URL(request.url).origin;

    if (isHls) {
      let body = await resp.text();
      const targetParsed = new URL(targetUrl);
      const baseOrigin   = targetParsed.origin; // e.g. https://files.akuma-player.xyz

      // rewrite line-by-line (รองรับ absolute / protocol-relative / relative path)
      body = body.split("\n").map(line => {
        const t = line.trim();
        if (!t || t.startsWith("#")) return line;

        let abs;
        if (/^https?:\/\//.test(t))  abs = t;
        else if (t.startsWith("//")) abs = "https:" + t;
        else if (t.startsWith("/"))  abs = baseOrigin + t;
        else return line;

        const enc = encodeURIComponent(abs);
        const ref = encodeURIComponent(referer);
        return `${workerOrigin}/?url=${enc}&referer=${ref}`;
      }).join("\n");

      return new Response(body, {
        headers: {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache",
        },
      });
    }

    // binary pass-through (TS segments)
    return new Response(resp.body, {
      status: resp.status,
      headers: {
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
      },
    });
  },
};

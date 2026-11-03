/**
 * Steer Show Tracker Worker — mcmurphykids.canyoncattleconsulting.com
 *
 * /api/steers     -> shared save (D1 database bound as DB, secret PIN)
 * everything else -> the tracker page (index.html, bundled into this Worker)
 *
 * Repo layout (all at the top level): index.html, index.js, wrangler.jsonc
 */
import PAGE from "./index.html";

const MAX_BYTES = 900_000;

const steersApi = {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Family-Pin",
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors },
      });

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);
    if (!url.pathname.replace(/\/+$/, "").endsWith("/api/steers")) {
      return json({ error: "not found" }, 404);
    }
    if (!env.DB) return json({ error: "D1 database not bound as DB" }, 500);

    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS store (id TEXT PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL)"
    ).run();

    const current = async () => {
      const row = await env.DB.prepare("SELECT version, data FROM store WHERE id = 'main'").first();
      return row
        ? { version: row.version, data: JSON.parse(row.data) }
        : { version: 0, data: { steers: [], weights: [], trims: [], vet: [] } };
    };

    if (request.method === "GET") return json(await current());

    if (request.method === "PUT") {
      if (env.PIN && request.headers.get("X-Family-Pin") !== String(env.PIN)) {
        return json({ error: "PIN required" }, 401);
      }
      const text = await request.text();
      if (text.length > MAX_BYTES) return json({ error: "too large" }, 413);

      let body;
      try { body = JSON.parse(text); } catch { return json({ error: "bad JSON" }, 400); }
      const { baseVersion, data } = body || {};
      if (typeof baseVersion !== "number" || !data ||
          !Array.isArray(data.steers) || !Array.isArray(data.weights) ||
          (data.trims !== undefined && !Array.isArray(data.trims)) ||
          (data.vet !== undefined && !Array.isArray(data.vet))) {
        return json({ error: "bad data" }, 400);
      }
      const payload = JSON.stringify({ steers: data.steers, weights: data.weights, trims: data.trims || [], vet: data.vet || [] });

      let changes = 0;
      if (baseVersion === 0) {
        const r = await env.DB.prepare(
          "INSERT OR IGNORE INTO store (id, version, data) VALUES ('main', 1, ?)"
        ).bind(payload).run();
        changes = r.meta.changes;
      } else {
        // only save if nobody else has saved since this device last loaded
        const r = await env.DB.prepare(
          "UPDATE store SET version = version + 1, data = ? WHERE id = 'main' AND version = ?"
        ).bind(payload, baseVersion).run();
        changes = r.meta.changes;
      }
      if (!changes) return json(await current(), 409);
      return json({ version: baseVersion + 1 });
    }

    return json({ error: "method not allowed" }, 405);
  },
};

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    if (path === "/api/steers") return steersApi.fetch(request, env);
    return new Response(PAGE, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
    });
  },
};

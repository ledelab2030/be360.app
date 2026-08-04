/**
 * vita-proxy — Cloudflare Worker
 *
 * Dos rutas, ambas restringidas por CORS a be360.app:
 *   POST /        → proxy a la API de Anthropic (Messages API). Igual que antes.
 *   POST /log     → NUEVO (HITL capture-only). Recibe {mode, dx, ts} desde
 *                   vita-demo-srb-3/index.html y lo reenvía al Apps Script que
 *                   escribe la fila en el Sheet de revisión de Peter. La API key
 *                   de Anthropic nunca se usa en /log.
 *
 * Secrets esperados (wrangler secret put <nombre>):
 *   ANTHROPIC_API_KEY   — ya existía, sin cambios.
 *   SHEET_WEBHOOK_URL    — URL del Apps Script Web App (ver worker/apps-script-sheet-writer.gs.txt).
 *   SHEET_WEBHOOK_SECRET — string compartido; el Apps Script lo valida antes de escribir.
 *
 * Ver también: CLAUDE.md §5 (arquitectura HITL) y §8 (deploy con `wrangler deploy`).
 */

const ALLOWED_ORIGIN = "https://be360.app";

function corsHeaders(origin) {
  const allow = origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

async function handleAnthropicProxy(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "JSON inválido" }, 400, origin);
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  return json(data, res.status, origin);
}

async function handleLog(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: "JSON inválido" }, 400, origin);
  }

  const { mode, dx, ts } = body || {};
  if (!dx || typeof dx !== "object") {
    return json({ ok: false, error: "dx faltante" }, 400, origin);
  }

  // Blindaje server-side: aunque el prompt ya instruye a Vita a dejar
  // "microcambio" vacío, el Worker nunca deja pasar un microcambio no-vacío
  // hacia el Sheet — así el capture-only no depende solo del modelo.
  const safeDx = { ...dx, microcambio: "" };

  if (!env.SHEET_WEBHOOK_URL) {
    // Falla explícita en vez de silenciosa: si falta configurar el secret,
    // el frontend debe mostrar error, no fingir que se guardó.
    return json({ ok: false, error: "SHEET_WEBHOOK_URL no configurado" }, 500, origin);
  }

  const sheetRes = await fetch(env.SHEET_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret: env.SHEET_WEBHOOK_SECRET || "",
      mode: mode || "",
      dx: safeDx,
      ts: ts || new Date().toISOString(),
      origin: request.headers.get("Origin") || "",
    }),
  });

  if (!sheetRes.ok) {
    return json({ ok: false, error: "No se pudo escribir en el Sheet" }, 502, origin);
  }

  return json({ ok: true }, 200, origin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (origin !== ALLOWED_ORIGIN) {
      // Nota (deuda técnica heredada, ver CLAUDE.md §9): esto bloquea el
      // origen del navegador pero no frena peticiones sin header Origin
      // (p. ej. curl). Rate limit / verificación más dura sigue pendiente.
      return json({ error: "Origen no permitido" }, 403, origin);
    }

    if (request.method !== "POST") {
      return json({ error: "Método no permitido" }, 405, origin);
    }

    if (url.pathname === "/log") {
      return handleLog(request, env, origin);
    }
    return handleAnthropicProxy(request, env, origin);
  },
};

// ============================================================
// Vita · Cloudflare Worker (proxy seguro a la API de Claude)
// ------------------------------------------------------------
// La API key NUNCA va en el frontend. Vive aquí como "secreto"
// de Cloudflare (Settings → Variables → Add secret):
//     Nombre:  ANTHROPIC_API_KEY
//     Valor:   sk-ant-...   (tu key de Anthropic)
//
// CORS restringido: solo be360.app puede usar este Worker.
//
// NUEVO (HITL capture-only, ago 2026): ruta /log — recibe el
// diagnóstico capturado y lo reenvía a un Sheet de revisión vía Apps
// Script. Dos productos, dos schemas, DOS Sheets distintos — se enrutan
// por el campo "producto" del body ("srb3" | "formulario"):
//     producto:"srb3"        (o ausente, compat. con lo ya desplegado)
//                             → env.SHEET_WEBHOOK_URL / SHEET_WEBHOOK_SECRET
//     producto:"formulario"  (vita-demo-formulario, sprint)
//                             → env.SHEET_WEBHOOK_URL_FORMULARIO / SHEET_WEBHOOK_SECRET_FORMULARIO
// Ver worker/apps-script-sheet-writer.gs.txt para instalar cada Sheet.
//
// NUEVO (panel de Peter + plan del padre, ago 2026) — solo producto
// "formulario" (el Sheet de srb3 no tiene estas columnas):
//   POST /guardar-borrador  — guarda el borrador (Parte A/B del Prompt
//                              Maestro) en la fila identificada por "ts",
//                              genera un id_plan aleatorio.
//   GET  /plan?id=...       — lectura PÚBLICA (sin CORS de origen, la abre
//                              el padre desde WhatsApp) del plan, SOLO si
//                              decision="aprobado" en esa fila. Nunca
//                              expone un borrador sin aprobar.
// Usan el mismo env.SHEET_WEBHOOK_URL_FORMULARIO / SHEET_WEBHOOK_SECRET_FORMULARIO.
//
// Todo lo demás de este archivo es EXACTO al código en producción
// (verificado vía Cloudflare API el 5 ago 2026) — no se tocó nada
// del proxy a Anthropic, incluida la deuda técnica conocida (no
// bloquea peticiones sin header Origin).
// ============================================================

const ALLOWED_ORIGIN = "https://be360.app";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // /plan es de lectura pública (el padre lo abre desde WhatsApp, no
    // desde be360.app) — sin restricción de Origin, CORS abierto a todos.
    if (url.pathname === "/plan") {
      return handlePlan(url, env);
    }

    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    };

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: cors });
    }

    // Bloquea orígenes que no sean be360.app
    const origin = request.headers.get("Origin");
    if (origin && origin !== ALLOWED_ORIGIN) {
      return new Response(JSON.stringify({ error: "Forbidden origin" }), {
        status: 403,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // NUEVO: ruta de logging para HITL capture-only.
    if (url.pathname === "/log") {
      return handleLog(request, env, cors);
    }

    // NUEVO: guardar el borrador generado (Prompt Maestro) en la fila del Sheet.
    if (url.pathname === "/guardar-borrador") {
      return handleGuardarBorrador(request, env, cors);
    }

    try {
      const body = await request.json();

      const upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: body.model || "claude-sonnet-4-6",
          max_tokens: body.max_tokens || 1000,
          system: body.system,
          messages: body.messages,
        }),
      });

      const data = await upstream.text();
      return new Response(data, {
        status: upstream.status,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), {
        status: 500,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
  },
};

// HITL capture-only: nunca deja pasar un "microcambio" no vacío hacia el
// Sheet, aunque el prompt del demo fallara — blindaje server-side.
async function handleLog(request, env, cors) {
  const jsonHeaders = { ...cors, "Content-Type": "application/json" };
  try {
    const body = await request.json();
    const { mode, dx, ts, producto } = body || {};

    if (!dx || typeof dx !== "object") {
      return new Response(JSON.stringify({ ok: false, error: "dx faltante" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    const esFormulario = producto === "formulario";
    const webhookUrl = esFormulario ? env.SHEET_WEBHOOK_URL_FORMULARIO : env.SHEET_WEBHOOK_URL;
    const webhookSecret = esFormulario ? env.SHEET_WEBHOOK_SECRET_FORMULARIO : env.SHEET_WEBHOOK_SECRET;

    if (!webhookUrl) {
      return new Response(JSON.stringify({ ok: false, error: (esFormulario ? "SHEET_WEBHOOK_URL_FORMULARIO" : "SHEET_WEBHOOK_URL") + " no configurado" }), {
        status: 500,
        headers: jsonHeaders,
      });
    }

    // Blindaje solo tiene sentido para el schema viejo (srb3), que sí tenía
    // "microcambio". vita-demo-formulario nunca lo tuvo — no hace falta.
    const safeDx = esFormulario ? dx : { ...dx, microcambio: "" };

    const sheetRes = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: webhookSecret || "",
        mode: mode || "",
        dx: safeDx,
        ts: ts || new Date().toISOString(),
      }),
    });

    // OJO: Apps Script (ContentService) SIEMPRE responde HTTP 200, así el
    // secret esté mal o falte el dx — sheetRes.ok por sí solo NO detecta
    // esos casos. Hay que parsear el cuerpo y revisar su "ok" real.
    const sheetText = await sheetRes.text();
    let sheetData = null;
    try { sheetData = JSON.parse(sheetText); } catch (e) { /* respuesta no-JSON (ej. HTML de error de Google) */ }

    if (!sheetRes.ok || !sheetData || sheetData.ok !== true) {
      return new Response(JSON.stringify({
        ok: false,
        error: "No se pudo escribir en el Sheet",
        detalle: sheetData ? sheetData.error : sheetText.slice(0, 300),
      }), {
        status: 502,
        headers: jsonHeaders,
      });
    }
    return new Response(JSON.stringify({ ok: true, lastRow: sheetData.lastRow }), { status: 200, headers: jsonHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}

// Guarda el borrador (Parte A/B) generado por el Prompt Maestro en la fila
// del Sheet identificada por su "ts" original. Solo producto formulario —
// el Sheet de srb3 no tiene columnas id_plan/plan_json/decision/borrador_texto.
async function handleGuardarBorrador(request, env, cors) {
  const jsonHeaders = { ...cors, "Content-Type": "application/json" };
  try {
    const body = await request.json();
    const { ts, mensaje, plan } = body || {};

    if (!ts) {
      return new Response(JSON.stringify({ ok: false, error: "ts faltante" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }
    if (!env.SHEET_WEBHOOK_URL_FORMULARIO) {
      return new Response(JSON.stringify({ ok: false, error: "SHEET_WEBHOOK_URL_FORMULARIO no configurado" }), {
        status: 500,
        headers: jsonHeaders,
      });
    }

    const sheetRes = await fetch(env.SHEET_WEBHOOK_URL_FORMULARIO, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: env.SHEET_WEBHOOK_SECRET_FORMULARIO || "",
        action: "guardar_borrador",
        ts,
        mensaje: mensaje || "",
        plan: plan || {},
      }),
    });

    const sheetText = await sheetRes.text();
    let sheetData = null;
    try { sheetData = JSON.parse(sheetText); } catch (e) {}

    if (!sheetRes.ok || !sheetData || sheetData.ok !== true) {
      return new Response(JSON.stringify({
        ok: false,
        error: "No se pudo guardar el borrador",
        detalle: sheetData ? sheetData.error : sheetText.slice(0, 300),
      }), { status: 502, headers: jsonHeaders });
    }
    return new Response(JSON.stringify({ ok: true, idPlan: sheetData.idPlan }), { status: 200, headers: jsonHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}

// Lectura PÚBLICA del plan aprobado — la abre el padre desde un link de
// WhatsApp, no desde be360.app, así que no restringimos por Origin. Solo
// devuelve algo si decision="aprobado" en el Sheet — nunca expone un
// borrador pendiente de revisión.
async function handlePlan(url, env) {
  const openCors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };
  const jsonHeaders = { ...openCors, "Content-Type": "application/json" };

  const id = url.searchParams.get("id");
  if (!id) {
    return new Response(JSON.stringify({ ok: false, error: "id faltante" }), { status: 400, headers: jsonHeaders });
  }
  if (!env.SHEET_WEBHOOK_URL_FORMULARIO) {
    return new Response(JSON.stringify({ ok: false, error: "SHEET_WEBHOOK_URL_FORMULARIO no configurado" }), { status: 500, headers: jsonHeaders });
  }

  try {
    const sheetRes = await fetch(env.SHEET_WEBHOOK_URL_FORMULARIO + "?id=" + encodeURIComponent(id), { method: "GET" });
    const sheetText = await sheetRes.text();
    let sheetData = null;
    try { sheetData = JSON.parse(sheetText); } catch (e) {}

    if (!sheetRes.ok || !sheetData || sheetData.ok !== true) {
      return new Response(JSON.stringify({ ok: false, error: "no disponible" }), { status: 404, headers: jsonHeaders });
    }
    return new Response(JSON.stringify(sheetData), { status: 200, headers: jsonHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: jsonHeaders });
  }
}

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
// NUEVO (8 ago 2026): panel/index.html (panel de revisión de Peter). Las
// rutas /panel/* de este Worker NO necesitan ningún secret nuevo de
// Cloudflare — solo reenvían el cuerpo de la petición (incluido
// "panelSecret") tal cual a Apps Script, que es quien de verdad valida el
// PIN contra su propia variable PANEL_SECRET (ver
// worker/apps-script-formulario-v2.gs.txt). Lo único que importa: el PIN
// que Peter escribe la primera vez que entra al panel debe ser IGUAL al
// PANEL_SECRET que pusiste en el Apps Script.
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
//                              el padre desde el link que le llega por
//                              correo) del plan, SOLO si
//                              decision="aprobado" en esa fila. Nunca
//                              expone un borrador sin aprobar.
// Usan el mismo env.SHEET_WEBHOOK_URL_FORMULARIO / SHEET_WEBHOOK_SECRET_FORMULARIO.
//
// NUEVO (generación automática del borrador, 7 ago 2026) — solo producto
// "formulario". Apenas /log guarda la fila capturada, se dispara EN
// SEGUNDO PLANO (ctx.waitUntil, el padre no espera) una llamada a Claude
// con el Prompt Maestro embebido (SRB_DRAFT_PROMPT) para generar el
// borrador, y se guarda solo automáticamente vía la misma acción
// "guardar_borrador" del Apps Script — ya no hace falta que un
// desarrollador lo corra a mano. Si algo falla (JSON mal formado, etc.),
// la fila se queda en "pendiente" tal cual antes — no rompe nada, solo no
// se adelanta el trabajo.
//
// NUEVO (chat de seguimiento, 7 ago 2026) — el botón "Escribirle a Vita" en
// plan/index.html ya no abre WhatsApp a un número monitoreado a mano: abre un
// chat real (mismo patrón que vita-demo-formulario) con la voz de
// acompañamiento de Vita. Usa el endpoint raíz "/" de siempre para el chat.
// Cuando el padre dice algo que requiere escalar a Peter (urgencia clínica,
// duda sobre el plan, pide hablar con una persona), el modelo lo marca y el
// frontend llama a:
//   POST /escalar — reenvía un correo al equipo con el mensaje del padre y
//                    el motivo. Reusa el mismo Sheet/Apps Script (acción
//                    "notificar_escalamiento") — sin esto, una señal de
//                    riesgo real quedaría flotando sin que nadie la vea.
//
// NUEVO (8 ago 2026): la deuda técnica de "no bloquea peticiones sin header
// Origin" quedó cerrada — ver el chequeo de origen más abajo. Sigue faltando
// rate limiting real (límite de peticiones por IP/tiempo), eso sí requiere
// estado (Cloudflare KV o similar) y no está construido todavía.
//
// NUEVO (8 ago 2026, decisión de Leonardo): se deja de pedir WhatsApp al
// padre/madre en la captura — evita depender de WhatsApp como canal
// (controles, restricciones y costos de la API de Meta) mientras no haga
// falta. En su lugar se pide correo, y la entrega del plan aprobado
// (onAprobado en el Apps Script) pasa de "armar un link de WhatsApp para
// que alguien del equipo lo mande a mano" a mandar el correo con el link
// del plan DIRECTO al padre/madre, automáticamente. Este Worker no cambia
// nada aquí (el campo va opaco dentro de "dx") — el cambio real está en
// vita-demo-formulario/index.html y worker/apps-script-formulario-v2.gs.txt.
// ============================================================

const ALLOWED_ORIGIN = "https://be360.app";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // /plan es de lectura pública (el padre lo abre desde el link que le
    // llega por correo, no desde be360.app) — sin restricción de Origin,
    // CORS abierto a todos.
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

    // Bloquea orígenes que no sean be360.app. FIX 8 ago 2026 (cerraba la
    // deuda técnica heredada): antes solo bloqueaba si el header Origin
    // estaba presente y era distinto — un curl sin ese header pasaba
    // derecho. Ahora exige el header exacto, así que curl/scripts directos
    // ya no pueden gastar créditos de Claude ni spamear /escalar. Un
    // navegador real SIEMPRE manda Origin en estas peticiones cross-origin
    // (be360.app -> vita-proxy.workers.dev), así que esto no afecta uso
    // legítimo.
    const origin = request.headers.get("Origin");
    if (origin !== ALLOWED_ORIGIN) {
      return new Response(JSON.stringify({ error: "Forbidden origin" }), {
        status: 403,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // NUEVO: ruta de logging para HITL capture-only.
    if (url.pathname === "/log") {
      return handleLog(request, env, cors, ctx);
    }

    // NUEVO: guardar el borrador generado (Prompt Maestro) en la fila del Sheet.
    if (url.pathname === "/guardar-borrador") {
      return handleGuardarBorrador(request, env, cors);
    }

    // NUEVO: escalar una señal del chat de seguimiento a un humano por correo.
    if (url.pathname === "/escalar") {
      return handleEscalar(request, env, cors);
    }

    // NUEVO (8 ago 2026): panel de revisión de Peter (panel/index.html) —
    // reemplaza editar la hoja de cálculo directo, que cualquiera con acceso
    // puede dañar sin querer (borrar una fila, mover una columna, escribir
    // "aprobado" donde no era). Estas 4 rutas usan PANEL_SECRET, un secreto
    // DISTINTO de SHEET_WEBHOOK_SECRET_FORMULARIO — el panel nunca ve el
    // secreto real que este Worker usa para escribir en el Sheet, solo el
    // PIN de Peter, que igual nunca sale del cuerpo de la petición (no se
    // expone en la URL ni en logs).
    if (url.pathname === "/panel/pendientes") return handlePanelAction(request, env, cors, "listar_pendientes");
    if (url.pathname === "/panel/historial") return handlePanelAction(request, env, cors, "listar_historial");
    if (url.pathname === "/panel/detalle") return handlePanelAction(request, env, cors, "detalle_plan");
    if (url.pathname === "/panel/guardar") return handlePanelAction(request, env, cors, "guardar_edicion_plan");
    if (url.pathname === "/panel/aprobar") return handlePanelAction(request, env, cors, "aprobar_plan");
    if (url.pathname === "/panel/descartar") return handlePanelAction(request, env, cors, "descartar_pendiente");

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
async function handleLog(request, env, cors, ctx) {
  const jsonHeaders = { ...cors, "Content-Type": "application/json" };
  try {
    const body = await request.json();
    const { mode, dx, ts, producto } = body || {};
    const tsFinal = ts || new Date().toISOString();

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
        ts: tsFinal,
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
    // Dispara la generación automática del borrador EN SEGUNDO PLANO — el
    // padre ya recibió su "ok:true" y sigue con lo suyo, no espera a Claude.
    if (esFormulario && ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(generarBorradorAutomatico(dx, tsFinal, env));
    }

    return new Response(JSON.stringify({ ok: true, lastRow: sheetData.lastRow }), { status: 200, headers: jsonHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}

// ============================================================
// PROMPT MAESTRO embebido — versión condensada de
// design-sprint/src/prompts/srb_draft_generator.txt (repo del sprint),
// adaptada para responder JSON estricto (no texto libre con "Parte A/B"),
// para poder guardarse sola sin intervención humana. Si algún día se edita
// el Prompt Maestro del sprint, replicar el cambio aquí también.
// ============================================================
const SRB_DRAFT_PROMPT = `Eres el generador de borradores de plan de hábitos de be360, a partir del
Formulario de Hábitos que llenó un padre/madre sobre su hijo/a (2 a 20 años). Tu borrador NO
llega directo a la familia — lo revisa Peter Álvarez (autoridad clínica) antes de aprobarlo.

FUENTE ÚNICA — reglas duras, nunca las cruces:
- PROHIBIDO SIEMPRE: ayuno intermitente o ventanas de ingesta restrictivas, restricción agresiva
  de carbohidratos, dietas cetogénicas/carnívoras, déficit calórico agresivo. "No comer de noche"
  se enmarca como higiene de sueño/hígado — NUNCA como ayuno, nunca uses esa palabra.
- PESO: nunca es un objetivo salvo que el padre lo plantee explícitamente o venga de un
  diagnóstico médico ya recibido. Nunca hables de "dieta" ni imagen corporal.
- ALIMENTACIÓN: carbohidratos complejos SIN TRIGO (yuca, papa, ahuyama, ñame, plátano) — arroz
  permitido (excepción cultural). Trigo y lácteo de herbívoro (leche/queso/yogur de vaca o
  cabra — NUNCA las bebidas vegetales tipo "leche" de almendra/avena/soya, esas NO son lácteo):
  se REDUCEN, nunca se eliminan de golpe salvo que el formulario reporte una intolerancia o
  indicación puntual.
- HIDRATACIÓN: si hace falta sugerirlo, suero casero SIEMPRE empezando en 2 g/L — nunca sugieras
  una concentración mayor directamente.
- SUEÑO, PANTALLAS Y MOVIMIENTO: siempre seguros de recomendar si el formulario muestra la señal.
- Si el formulario muestra señales de posible trastorno de conducta alimentaria, salud mental
  grave o algo médico agudo: NO des un paso concreto en esa área — en su lugar, ese hábito debe
  decir que el equipo lo va a conversar directamente, sin detalle clínico.
- Nunca inventes nada fuera de esto. Elige 2 a 4 hábitos, los de mayor impacto — no una lista
  exhaustiva de todo lo capturado.

TONO del mensaje (voz de Vita, estilo WhatsApp): tuteo, cero emojis, cálido, sin culpa, dirigido
SIEMPRE al padre/madre (nunca al niño/a). Abre reconociendo algo que ya hacen bien. Cierra
invitando a elegir por dónde empezar — nunca lo presentes como orden fija. Nunca menciones IA,
tecnología, "ayuno", "dieta" ni imagen corporal.

Recibirás el formulario capturado en JSON. RESPONDE ÚNICAMENTE con este JSON — sin texto antes ni
después, sin bloque de código markdown, sin explicación:
{"mensaje":"<el mensaje completo dirigido al padre: intro cálida + 2-3 frases de contexto + 'TE
DEJO EL MAPA' + los mismos hábitos enumerados dentro del texto + cierre invitando a elegir>",
"habitos":[{"titulo":"<3 a 5 palabras>","texto":"<1 a 2 frases, accionable, en el mismo tono>"}]}
Entre 2 y 4 objetos en "habitos". El campo "mensaje" y la lista "habitos" deben ser consistentes
entre sí — son la misma información en dos formatos (uno para el texto corrido, otro para mostrar
como checklist en una página aparte).`;

// Genera el borrador automáticamente (Claude + Prompt Maestro embebido) y lo
// guarda solo, vía la misma acción "guardar_borrador" del Apps Script. Corre
// en segundo plano (ctx.waitUntil) — si falla por lo que sea, no revienta
// nada: la fila simplemente se queda en "pendiente" para revisión manual,
// igual que se comportaba el sistema antes de esta automatización.
async function generarBorradorAutomatico(dx, ts, env) {
  try {
    if (!env.SHEET_WEBHOOK_URL_FORMULARIO) return;

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        system: SRB_DRAFT_PROMPT,
        messages: [{ role: "user", content: "Formulario capturado (JSON):\n" + JSON.stringify(dx) }],
      }),
    });

    const data = await upstream.json();
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");

    let parsed = null;
    try { parsed = JSON.parse(text); }
    catch (e) {
      const m = text.match(/\{[\s\S]*\}/); // por si el modelo mete texto extra alrededor
      if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) {} }
    }
    if (!parsed || !parsed.mensaje) return; // no se pudo generar limpio — se queda "pendiente"

    await fetch(env.SHEET_WEBHOOK_URL_FORMULARIO, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: env.SHEET_WEBHOOK_SECRET_FORMULARIO || "",
        action: "guardar_borrador",
        ts,
        mensaje: parsed.mensaje,
        plan: { habitos: Array.isArray(parsed.habitos) ? parsed.habitos : [] },
      }),
    });
  } catch (e) {
    // Silencioso a propósito: un fallo aquí no debe afectar al padre (ya
    // recibió su confirmación) ni tumbar el Worker. Queda "pendiente".
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

// Lectura PÚBLICA del plan aprobado — la abre el padre desde un link que
// le llega por correo, no desde be360.app, así que no restringimos por
// Origin. Solo devuelve algo si decision="aprobado" en el Sheet — nunca
// expone un borrador pendiente de revisión.
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

// Reenvía una señal del chat de seguimiento (urgencia, duda sobre el plan,
// pide hablar con una persona) a un correo real del equipo, vía el mismo
// Apps Script (acción "notificar_escalamiento"). Sin esto, el chat podría
// "decir" que lo va a escalar sin que nadie del equipo se entere de verdad.
async function handleEscalar(request, env, cors) {
  const jsonHeaders = { ...cors, "Content-Type": "application/json" };
  try {
    const body = await request.json();
    const { idPlan, nombreNino, motivo, mensajePadre } = body || {};

    if (!env.SHEET_WEBHOOK_URL_FORMULARIO) {
      return new Response(JSON.stringify({ ok: false, error: "SHEET_WEBHOOK_URL_FORMULARIO no configurado" }), { status: 500, headers: jsonHeaders });
    }

    const sheetRes = await fetch(env.SHEET_WEBHOOK_URL_FORMULARIO, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: env.SHEET_WEBHOOK_SECRET_FORMULARIO || "",
        action: "notificar_escalamiento",
        idPlan: idPlan || "",
        nombreNino: nombreNino || "",
        motivo: motivo || "sin especificar",
        mensajePadre: mensajePadre || "",
      }),
    });

    const sheetText = await sheetRes.text();
    let sheetData = null;
    try { sheetData = JSON.parse(sheetText); } catch (e) {}

    if (!sheetRes.ok || !sheetData || sheetData.ok !== true) {
      return new Response(JSON.stringify({ ok: false, error: "no se pudo notificar" }), { status: 502, headers: jsonHeaders });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: jsonHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: jsonHeaders });
  }
}

// Reenvía cualquier acción del panel de Peter al Apps Script, agregando el
// nombre de la acción — el cuerpo (panelSecret, idPlan, plan, mensaje, etc.)
// ya viene armado desde panel/index.html, este Worker solo lo pasa. El
// secreto real del Sheet (SHEET_WEBHOOK_SECRET_FORMULARIO) nunca sale de
// aquí — Apps Script valida el panelSecret por su cuenta, con su propia
// variable PANEL_SECRET, separada de la que usa el resto del sistema.
async function handlePanelAction(request, env, cors, accion) {
  const jsonHeaders = { ...cors, "Content-Type": "application/json" };
  try {
    const body = await request.json();

    if (!env.SHEET_WEBHOOK_URL_FORMULARIO) {
      return new Response(JSON.stringify({ ok: false, error: "SHEET_WEBHOOK_URL_FORMULARIO no configurado" }), { status: 500, headers: jsonHeaders });
    }

    const sheetRes = await fetch(env.SHEET_WEBHOOK_URL_FORMULARIO, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, action: accion }),
    });

    const sheetText = await sheetRes.text();
    let sheetData;
    try { sheetData = JSON.parse(sheetText); } catch (e) { sheetData = { ok: false, error: "respuesta inválida de Apps Script" }; }

    const status = sheetData.ok === false ? (sheetData.error === "panelSecret inválido" ? 401 : 400) : 200;
    return new Response(JSON.stringify(sheetData), { status, headers: jsonHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: jsonHeaders });
  }
}

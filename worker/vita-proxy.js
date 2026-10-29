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
// Origin" quedó cerrada — ver el chequeo de origen más abajo.
//
// NUEVO (9 ago 2026): rate limiting real, por IP. Primer intento con KV
// (binding RATE_LIMIT_KV) — probado en vivo con hasta 73 peticiones seguidas
// y NUNCA se disparó el límite. Causa raíz: KV es "eventually consistent" a
// propósito (está pensado para lecturas frecuentes con pocas escrituras, no
// para contadores que cambian en cada petición) — un get() justo después del
// put() de otra petición puede no ver el valor nuevo todavía. No era un bug
// del código, era la herramienta equivocada para este trabajo.
// Reemplazado por un Durable Object (clase RateLimiter, más abajo): cada IP
// tiene su propia instancia, y Cloudflare garantiza que las peticiones a esa
// MISMA instancia se procesan una por una (sin condiciones de carrera) — ahí
// sí un contador de verdad. Requiere declarar la clase como
// "durable_objects.bindings" + una entrada en "migrations" en wrangler.toml
// (ver ese archivo). Ventana fija de 60s, límite de 30 peticiones/IP/min —
// generoso para una familia usando el chat de verdad, corta un loop/curl.
// DISEÑO A PRUEBA DE FALLOS: si el binding no existe o el Durable Object
// falla por lo que sea, el chequeo se salta en vez de romper el Worker.
// El namespace de KV "vita_rate_limit" queda huérfano (ya no se usa) — se
// puede borrar desde el dashboard si se quiere, no hace daño dejarlo.
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
//
// NUEVO (10 ago 2026): verificación de elegibilidad por colegio (pedido de
// Leonardo). be360 solo está habilitado para ciertos colegios, y el control
// es por hijo/a, no por familia. Se verifica DESPUÉS de capturar (no
// bloquea el inicio de la conversación): apenas el borrador queda listo,
// Apps Script le manda al padre un correo con un link a verificar/, que
// llama a esta ruta con el código. Reusa handlePanelAction tal cual (mismo
// patrón de passthrough genérico) — no necesita ningún secret nuevo de
// Cloudflare, la protección real (código válido + conocer el idPlan) vive
// en Apps Script. Si no se verifica en 72 horas, Apps Script purga el caso
// solo (purgarNoVerificadosProgramado) y aprobarPlan ya rechaza aprobar
// cualquier caso sin verificar, así que la recomendación queda retenida.
// ============================================================

const ALLOWED_ORIGIN = "https://be360.app";
const LIMITE_POR_MINUTO = 30; // por IP — generoso para una familia usando el chat de verdad, corta un loop/curl

// Durable Object: una instancia por IP (env.RATE_LIMITER.idFromName(ip)).
// Cloudflare garantiza que las peticiones a la MISMA instancia se procesan
// una por una — por eso este contador sí es confiable, a diferencia del
// intento anterior con KV (ver nota arriba). this.state.storage es
// consistente dentro de esta única instancia, no hay condición de carrera
// entre el get y el put de dos peticiones distintas porque nunca corren en
// paralelo para la misma IP.
export class RateLimiter {
  constructor(state, env) {
    this.state = state;
  }
  async fetch(request) {
    const ahora = Date.now();
    const ventana = Math.floor(ahora / 60000); // minuto actual (cambia cada 60s)
    let data = await this.state.storage.get("data");
    if (!data || data.ventana !== ventana) data = { ventana, count: 0 }; // nueva ventana → reinicia
    data.count++;
    await this.state.storage.put("data", data);
    return new Response(JSON.stringify({ limitado: data.count > LIMITE_POR_MINUTO }), {
      headers: { "Content-Type": "application/json" },
    });
  }
}

// Genera el borrador en una ALARMA de Durable Object, no en ctx.waitUntil
// (21 oct 2026). Razón medida: ctx.waitUntil se cancela ~30s después de que el
// Worker responde, y el prompt pediátrico v4 tarda ~70s en generar. La alarma
// de un Durable Object no tiene ese tope, así que la generación termina.
//
// El trabajo se guarda en el storage del DO antes de programar la alarma: si
// la alarma falla, Cloudflare la reintenta sola y el trabajo sigue ahí. El DO
// se direcciona por el "ts" de la fila, así que cada captura tiene su propia
// instancia y dos padres que envían al mismo tiempo no se pisan.
export class GeneradorBorradores {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const trabajo = await request.json();
    await this.state.storage.put("trabajo", trabajo);
    await this.state.storage.setAlarm(Date.now() + 1000);
    return new Response(JSON.stringify({ ok: true, encolado: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  async alarm() {
    const trabajo = await this.state.storage.get("trabajo");
    if (!trabajo) return;
    // Se borra ANTES de generar: si la generación falla, no queremos que la
    // alarma se reintente en bucle llamando a Claude una y otra vez. La fila
    // se queda "pendiente" y se puede regenerar a mano, igual que antes.
    await this.state.storage.delete("trabajo");
    // "modo: regenerar" (28 oct 2026) es la regeneración manual de un caso
    // existente desde equipo/ — ver /panel/regenerar y
    // regenerarBorradorExistente(). Mismo Durable Object, mismo motivo (la
    // generación tarda ~70s, no cabe en ctx.waitUntil), pero guarda por
    // idPlan en vez de ts.
    if (trabajo.modo === "regenerar") {
      await regenerarBorradorExistente(trabajo.idPlan, trabajo.dx, this.env);
    } else {
      await generarBorradorAutomatico(trabajo.dx, trabajo.ts, this.env);
    }
  }
}

// Devuelve true si hay que bloquear la petición, false si puede seguir.
// DISEÑO A PRUEBA DE FALLOS: si el binding no existe todavía, o el Durable
// Object falla por lo que sea, se salta el chequeo en vez de romper el
// Worker — nunca bloquea uso real por un problema de infraestructura.
async function checkRateLimit(request, env) {
  if (!env.RATE_LIMITER) return false; // binding no configurado todavía — no bloquea, solo no protege
  try {
    const ip = request.headers.get("CF-Connecting-IP") || "sin-ip";
    const id = env.RATE_LIMITER.idFromName(ip);
    const stub = env.RATE_LIMITER.get(id);
    const res = await stub.fetch("https://rate-limiter/check");
    const data = await res.json();
    return data.limitado === true;
  } catch (e) {
    return false; // si el Durable Object falla por lo que sea, no bloqueamos uso real por un problema de infraestructura
  }
}

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

    // Rate limiting (9 ago 2026, Durable Object) — después del chequeo de
    // Origin (no tiene sentido despertar un Durable Object para algo que ya
    // íbamos a rechazar) y antes de CUALQUIER ruta que cueste algo real
    // (Claude, Sheets, correos). Aplica parejo a todas — /plan queda afuera a
    // propósito, es lectura pública de un plan ya aprobado, no cuesta nada.
    if (await checkRateLimit(request, env)) {
      return new Response(JSON.stringify({ error: "Demasiadas peticiones seguidas — intenta de nuevo en un minuto" }), {
        status: 429,
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

    // NUEVO (27 oct 2026, pedido de Leonardo): guardar el chat COMPLETO de
    // seguimiento, no solo lo que se escala — para que Vita recuerde la
    // conversación entre sesiones (pestaña Vita de app/index.html) y para
    // mostrarla en Progreso. Mismo patrón que /escalar: SHARED_SECRET
    // (nunca PANEL_SECRET), porque lo dispara la app pública de la familia.
    if (url.pathname === "/chat") {
      return handleGuardarChat(request, env, cors);
    }

    // NUEVO (8 ago 2026): panel de revisión de Peter (panel/index.html) —
    // reemplaza editar la hoja de cálculo directo, que cualquiera con acceso
    // puede dañar sin querer (borrar una fila, mover una columna, escribir
    // "aprobado" donde no era). Estas rutas usan PANEL_SECRET, un secreto
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
    // NUEVO (27 oct 2026, pedido de Leonardo): borrar una novedad puntual
    // del chat de seguimiento sin tener que editar el Sheet a mano — mismo
    // principio que las rutas de arriba.
    if (url.pathname === "/panel/eliminar-novedad") return handlePanelAction(request, env, cors, "eliminar_novedad");
    // NUEVO (27 oct 2026, pedido de Leonardo): sección "Equipo" de
    // equipo/index.html — lista de solo lectura de quién tiene acceso.
    if (url.pathname === "/panel/equipo") return handlePanelAction(request, env, cors, "listar_equipo");
    // NUEVO (28 oct 2026, pedido de Leonardo): login real por persona en
    // equipo/index.html — prueba un PIN candidato y dice de quién es. Mismo
    // passthrough genérico; esta acción no lleva panelSecret en el cuerpo,
    // probar la credencial es su propio trabajo (ver login_equipo en Apps Script).
    if (url.pathname === "/panel/login") return handlePanelAction(request, env, cors, "login_equipo");
    // NUEVO (28 oct 2026, pedido de Leonardo): borra el chat completo de un
    // caso — limpieza de mensajes de prueba, nunca disparado por la familia.
    if (url.pathname === "/panel/limpiar-chat") return handlePanelAction(request, env, cors, "limpiar_chat");
    // NUEVO (28 oct 2026, pedido de Leonardo: regenerar casos reales con el
    // prompt corregido tras la revisión con Peter) — a diferencia de las
    // rutas de arriba, NO es un passthrough simple: dispara una generación
    // real (~70s), así que no cabe en una respuesta HTTP normal. Ver
    // handleRegenerar() más abajo.
    if (url.pathname === "/panel/regenerar") return handleRegenerar(request, env, cors);

    // NUEVO (10 ago 2026): verificación del código de colegio — ver nota grande arriba.
    if (url.pathname === "/verificar") return handlePanelAction(request, env, cors, "verificar_codigo");

    // NUEVO (14 ago 2026): panel de colegio (panel-colegio/index.html) — SOLO
    // agregados del colegio (nunca un caso individual), con su propio PIN por
    // colegio (PANEL_COLEGIO_SECRETS en Apps Script, distinto del PANEL_SECRET
    // de Peter). Mismo patrón de passthrough genérico que /panel/* y /verificar.
    if (url.pathname === "/panel-colegio/resumen") return handlePanelAction(request, env, cors, "resumen_colegio");

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
    const { mode, dx, ts, producto, camposSnapshot } = body || {};
    const tsFinal = ts || new Date().toISOString();

    if (!dx || typeof dx !== "object") {
      return new Response(JSON.stringify({ ok: false, error: "dx faltante" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    // "formulario_pediatrico_v2" (2 oct 2026) = vita-demo-formulario-v2/, el
    // enlace de validación aparte. Mismo Sheet y mismo schema que
    // "formulario" (producción real, vita-demo-formulario/) — desde el 27
    // oct 2026 ambos generan con el mismo prompt (ver SRB_DRAFT_PROMPT); el
    // valor de "producto" ya no cambia el camino de generación, solo sigue
    // distinguiendo de dónde vino la captura.
    const esFormulario = producto === "formulario" || producto === "formulario_pediatrico_v2";
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
        // Snapshot de los hints del formulario tal como estaban en el
        // momento de esta captura (2 oct 2026, pedido de Leonardo) — solo
        // tiene sentido para "formulario"/"formulario_pediatrico_v2"; el
        // schema viejo (srb3) no lo manda y Apps Script lo guarda vacío.
        camposSnapshot: esFormulario ? (camposSnapshot || null) : null,
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
    //
    // Hay DOS caminos, y la diferencia es el límite de tiempo (21 oct 2026,
    // actualizado 27 oct 2026): ctx.waitUntil() se cancela ~30s después de
    // que el Worker responde; el prompt pediátrico (fuente SRB verbatim +
    // verificación + reintento + grounding) tarda ~70s y NO cabe — medido.
    // Por eso se delega a un Durable Object con alarma, que no tiene ese
    // tope. Hasta el 27 oct esto solo aplicaba a "formulario_pediatrico_v2"
    // (el enlace de validación); desde que ese prompt se promovió a
    // producción (ver SRB_DRAFT_PROMPT), CUALQUIER formulario real tarda lo
    // mismo, así que ambos productos van por el Durable Object ahora —
    // dejar "formulario" en el camino viejo habría vuelto a reproducir la
    // falla silenciosa que ya se vio una vez: la fila se escribía en el
    // Sheet pero el borrador nunca se guardaba, y el caso quedaba invisible
    // en el panel de Peter para siempre.
    if (esFormulario) {
      if (env.GENERADOR_BORRADORES) {
        try {
          const id = env.GENERADOR_BORRADORES.idFromName(tsFinal);
          const stub = env.GENERADOR_BORRADORES.get(id);
          await stub.fetch("https://generador/encolar", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dx, ts: tsFinal }),
          });
        } catch (e) {
          // Si el Durable Object falla, se intenta por el camino viejo — puede
          // que no alcance a terminar, pero es mejor que no intentarlo.
          if (ctx && typeof ctx.waitUntil === "function") {
            ctx.waitUntil(generarBorradorAutomatico(dx, tsFinal, env));
          }
        }
      } else if (ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(generarBorradorAutomatico(dx, tsFinal, env));
      }
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
// PROMPT MAESTRO — histórico, RETIRADO el 27 oct 2026.
//
// Hasta el 27 oct 2026 este bloque definía SRB_DRAFT_PROMPT (v1.0-v1.4), el
// prompt simple de producción real — condensado de
// design-sprint/src/prompts/srb_draft_generator.txt — usado por
// vita-demo-formulario/ (producto "formulario"). Se retira y se promueve en
// su lugar el motor pediátrico que hasta hoy solo corría en el enlace de
// validación (ver "SRB PEDIÁTRICO — PROMOVIDO A PRODUCCIÓN" más abajo para
// el porqué y la historia completa de ESE prompt).
//
// Se conserva el changelog de versiones de este prompt retirado porque dos
// de sus cambios habían quedado "pendientes de ratificar formalmente en
// reglas_duras_srb.md" y esa firma sigue sin existir — retirar el prompt no
// resuelve ese pendiente, así que queda anotado acá qué pasó con cada uno:
//   v1.0 · 31 jul 2026            · origen: srb_draft_generator.txt v1
//                                    (carve-out pediátrico firmado 28 jul).
//   v1.1 · 16 sept 2026 · PR #71  · ESPECIFICIDAD (pedido de Peter) — voz/
//                                    comunicación, NO clínico.
//   v1.2 · 16 sept 2026 · PR #73  · lonchera comprada en el colegio (pedido
//                                    de Peter) — ⚠ ERA CLÍNICO, quedó
//                                    pendiente de ratificar formalmente en
//                                    reglas_duras_srb.md (ver addendum ahí).
//                                    Sigue viva y afinada en
//                                    ADAPTACIONES_PEDIATRICAS, regla "LONCHERA
//                                    — REGLA DE ORO" (26 oct 2026).
//   v1.3 · 2 oct 2026   · PR #78  · idioma latinoamericano estándar +
//                                    concisión (pedido de Peter en vivo) —
//                                    voz/comunicación, NO clínico.
//   v1.4 · 2 oct 2026   · PR #81  · quita el tope de 20 años (pedido de
//                                    Peter y Leonardo en vivo) — ⚠ ERA
//                                    CLÍNICO, quedó pendiente de ratificar
//                                    formalmente en reglas_duras_srb.md (ver
//                                    addendum ahí). El prompt que lo reemplaza
//                                    nunca introdujo un tope de edad, así que
//                                    no hay nada que quitar ahí.
// ============================================================

// Texto VERBATIM del SRB (sección 6.2, 6.4, 7, 7.1, 8 y 10.1 de SRB_v0_42).
// Vive en su propia constante —y no pegado dentro del prompt— porque lo usan
// DOS cosas: el prompt que genera el borrador y el verificador de grounding
// que lo revisa después. Si se duplicara, el verificador podría estar
// comparando contra una fuente distinta de la que se usó para escribir.
// Las adaptaciones que ANULAN la fuente donde el SRB habla para adultos.
// También en su propia constante, y por la misma razón que la fuente: las usan
// el prompt Y el verificador de grounding. Sin esto, el verificador solo veía
// el texto de adultos y marcaba como "sin respaldo" justo las decisiones que
// tomamos a propósito —los 2 g/L de sal en vez de 5-7, la ventana de 12h en vez
// de 4-6— o sea, ruido en CADA plan. Peter habría aprendido a ignorar el aviso
// en una semana (encontrado al probarlo con Samuel y Sofía, 21 oct 2026).
// Historial de ADAPTACIONES_PEDIATRICAS — por qué existe cada regla y cuándo
// se agregó o corrigió. Esto es para quien mantenga el código, NO para el
// modelo: el string de abajo (lo único que el modelo lee) tiene solo la
// regla, sin fechas ni nombres, para no gastar tokens ni atención en
// contexto que no cambia el comportamiento. Antes del 28 oct 2026 esta
// narrativa vivía dentro del string — se extrajo acá para acortarlo, sin
// cambiar el sentido de ninguna regla (ver CHANGELOG, entrada del 28 oct
// 2026 "Prompt más corto, mismo comportamiento").
//
// - Suero casero obligatorio, no "puede": 28 oct 2026, Peter en vivo contra un caso real.
// - "O agua" nunca como alternativa al suero/electrolitos: 28 oct 2026, Peter — se coló 3 veces en el mismo caso real (ritual de sueño, media tarde, después de cena).
// - Ventana de alimentación es MÁXIMO no mínimo: 26 oct 2026, Leonardo detectó que estaba al revés desde el 21 oct. El cálculo detallado vive en SRB_DRAFT_PROMPT, no se duplica acá.
// - Palabras prohibidas ayuno/autofagia: la frase de la fuente "el ayuno nocturno no es opcional" le ganó a esta regla en un plan real, 21 oct 2026 — de ahí que quede explícito que las adaptaciones mandan sobre la fuente cuando hay conflicto.
// - Movimiento sin condiciones inventadas: 28 oct 2026, Peter — el borrador inventó "si hay días en que el colegio queda cerca, seguir caminando suma", sin ningún dato detrás.
// - Verduras siempre rojo en crudo: 26 oct 2026, Peter, minuta "Regla de Ensaladas y Verduras" — la fuente no las mencionaba en la tabla INCLUIR/ELIMINAR.
// - Quesos, la excepción se estrecha a azul/roquefort: 26 oct 2026, Peter. El color (verde) no quedaba fijado y el sistema lo generaba en amarillo — corregido 27 oct 2026, Leonardo, comparando contra un caso real.
// - Trigo decide el color, no "pasta"/"pan" genérico: 28 oct 2026, Peter — el borrador de un caso real decía solo "pasta" sin especificar el origen.
// - Carbohidratos siempre acompañante: 26 oct 2026, Peter. Papa confirmada amarillo: 28 oct 2026, Peter, misma revisión.
// - Chatarra (helados, salchipapas) siempre rojo: 26 oct 2026, Peter.
// - Lonchera y meriendas, regla de oro: 26 oct 2026, Peter. El sistema generaba la opción con solo nueces, sin set completo — corregido 27 oct 2026, Leonardo, comparando contra el caso real que Peter aprobó el 26 oct.
// - Ritmo y sueño, mínimo 3 horas antes de dormir: 26 oct 2026, Peter, minuta "Horario de Cena y Sueño".
// - Medición concreta de la sal: 26 oct 2026, Peter, minuta "Instrucciones prácticas de medición".
// - Limón al gusto, sin cantidad fija: 26 oct 2026, Peter, minuta "Aclaración sobre el limón".
// - Proteína y grasa, nunca proteína sola: 28 oct 2026, Peter — el borrador de un caso real atribuía el mecanismo de la bilis a "proteína de calidad" sola; la FUENTE lo atribuye a la carne (proteína + grasa).
// - Variantes de una misma comida, elegir una sola: 28 oct 2026, Peter — el borrador de un caso real mezcló "huevo" y "batido de proteína" en una frase incoherente.
// - Ventana más corta el fin de semana: 28 oct 2026, Peter, misma revisión.
const ADAPTACIONES_PEDIATRICAS = `ADAPTACIONES PEDIÁTRICAS OBLIGATORIAS — estas reglas GANAN SIEMPRE sobre el texto de la fuente de
arriba cuando hay conflicto (el texto de arriba fue escrito para adultos):
- Suero casero: SIEMPRE empieza en 2 g de sal por litro (nunca los 5-7g que dice la fuente para
  adultos). DEBE tomarse en vez del agua potable tratada durante el día, cada vez que se tenga sed —
  nunca digas que "puede" tomarse, es obligatorio.
- HIDRATACIÓN: NUNCA "O AGUA" COMO ALTERNATIVA. Cuando el texto ofrece algo para tomar entre comidas
  o antes de dormir, la única opción es suero casero o agua CON electrolitos — "agua" sola como
  alternativa está PROHIBIDO ("suero o agua", "electrolitos o agua"). Si el momento no es para suero,
  la alternativa sigue siendo agua con electrolitos, nunca agua sin ellos.
- PROHIBIDO cualquier meta numérica de carbohidratos/día o de insulina en ayunas (la fuente da
  70-100g/día y un objetivo de 2.5 unidades — eso NUNCA se menciona a una familia con un niño/a).
  Si el Paso 0 menciona insulina en ayunas, es SOLO como "si tienes un examen reciente, compártelo;
  si no, puedes preguntarle a tu pediatra" — nunca un número objetivo.
- PROHIBIDO cualquier porcentaje de macronutrientes (la fuente dice "60-80% proteína animal" —
  eso no se menciona; en cambio, "prioriza proteína de calidad en cada comida", sin número).
- PROHIBIDO el Pilar 4 de la fuente (ayuno intermitente 12-24h) completo. En su lugar: "ventana de
  alimentación" — el tiempo entre primera y última comida, que en niños NUNCA debe superar las 12
  horas. Es un MÁXIMO, no un mínimo — ver CÁLCULO DE LA VENTANA DE ALIMENTACIÓN más abajo para el
  procedimiento completo y MAX_VENTANA_HORAS en el código.
- PALABRAS PROHIBIDAS, aunque aparezcan en la FUENTE: "ayuno", "ayunar", "ayuno nocturno",
  "autofagia". La fuente las usa porque fue escrita para adultos — tú NO las reproduces, ni
  citando, ni entre comillas, ni explicando que el SRB las usa. La frase de la fuente "el ayuno
  nocturno no es opcional" NUNCA se escribe: lo que se dice en su lugar es que cerrar la alimentación
  temprano le da al cuerpo la noche para recuperarse. Cuando la fuente y estas adaptaciones se
  contradigan, mandan SIEMPRE las adaptaciones.
- PROHIBIDO el Pilar 5 de la fuente (fuerza estructurada, 7 min de ejercicios, sentadillas/push-ups).
  El movimiento se trata como juego/actividad que ya disfruta el niño/a, nunca como rutina de
  ejercicios con minutos o repeticiones. TAMPOCO inventes condiciones que el formulario no reportó —
  cada sugerencia de movimiento se ancla a algo concreto que el formulario sí dijo; si no da pie a
  nada específico, queda en general sin inventar escenarios.
- PROHIBIDOS los "6 pasos para restaurar la microbiota" de la fuente (levadura de cerveza cruda,
  vinagre de manzana en ayunas, queso azul obligatorio) — son protocolos de adulto, no aplican aquí.
- PROHIBIDO mencionar o aplicar nada de las secciones de BioEmoción, biodescodificación o fase
  prodrómica — no están en el fragmento de fuente que recibiste, y aunque las conocieras, quedan
  fuera del plan inicial por decisión de Peter.
- VERDURAS: verdura CRUDA o en forma de ensalada — incluyendo pepino, tomate, lechuga, cualquier
  vegetal fresco — va SIEMPRE en ROJO (por su celulosa indigerible y por residuos de pesticidas,
  especialmente la "Docena Sucia"; las solanáceas crudas — papa, tomate, pimentón, berenjena —
  también son ROJO por ser inflamatorias crudas). Verdura BIEN COCIDA, usada EXCLUSIVAMENTE como
  adobo o para dar sabor a la proteína (nunca como plato aparte ni como base), va en AMARILLO. Las
  verduras NUNCA van en VERDE.
- QUESOS — LA EXCEPCIÓN SE ESTRECHA: la fuente dice "Quesos envejecidos (excepción láctea)" de forma
  genérica — ESO YA NO APLICA ASÍ. La única excepción real es el queso azul o roquefort (por el
  Penicillium roqueforti que predigiere los antígenos). NO digas "queso madurado" ni "queso
  envejecido" como categoría — nombra SIEMPRE "queso azul" o "roquefort" específicamente. Cualquier
  otro queso (incluidos parmesano, manchego u otros "envejecidos" que la fuente mencionaba) se trata
  como lácteo no madurado: ROJO. El resto de lácteos no madurados (leche, queso fresco, yogur,
  lácteos comerciales) sigue ROJO firme — nunca "se reducen poco a poco", se eliminan. Queso
  azul/roquefort va en 🟢 VERDE (prioridad en cada comida) — es la única excepción láctea, no una
  concesión de "con moderación".
- TRIGO, NO "PASTA" NI "PAN" GENÉRICO: lo que va en ROJO es el TRIGO como ingrediente, no la
  categoría de alimento. Pasta, pan, masa madre, sándwich — ROJO solo cuando son de trigo. Pasta o
  pan de arroz, quinua o lentejas es AMARILLO (acompañante, nunca base) — son alternativas válidas,
  no la misma regla que el trigo. Nombra siempre el ingrediente de origen ("pasta de trigo", nunca
  "pasta" sola) para que no quede ambiguo cuál color aplica.
- CARBOHIDRATOS — SIEMPRE ACOMPAÑANTE: arroz, lentejas, patacones, papa (cocida, de acompañante —
  distinto de la papa cruda, que es ROJO por la regla de VERDURAS de arriba), arepa y alimentos
  similares (semáforo AMARILLO) se presentan SIEMPRE como acompañante de la proteína y la grasa —
  NUNCA como base ni centro del plato, y NUNCA solos ni como merienda aparte. Si un hábito propone
  uno de estos alimentos, tiene que incluir explícitamente que va "de acompañante", no como plato
  principal.
- CHATARRA EXPLÍCITA EN ROJO: aunque no estén en la tabla original de la fuente, helados y
  salchipapas van SIEMPRE en ROJO si el formulario los menciona — nunca en amarillo.
- LONCHERA Y MERIENDAS — REGLA DE ORO: si el niño/a hace sus 3 comidas principales completas, la
  recomendación por defecto es NO merendar entre comidas — ni en la lonchera del colegio ni en la
  tarde. Si el formulario deja claro que SÍ hace falta una merienda (lonchera por horario escolar
  largo, o hambre real entre comidas principales), las opciones válidas son: huevo duro, tiras de
  pollo frío, queso azul o roquefort (ver QUESOS arriba — nunca "queso envejecido" genérico),
  aguacate, o aceitunas y nueces (pistacho, marañón) — siempre con hidratación de electrolitos
  (suero casero). CERO harinas, CERO carbohidratos, CERO galletas dulces en cualquier merienda, sin
  excepción, por el pico de insulina y el riesgo de generar un hábito de antojo. Usa este set
  completo, no solo nueces.
- RITMO Y SUEÑO — REGLA DURA, MISMA CIFRA SIN IMPORTAR EDAD: tiene que haber un MÍNIMO DE 3 HORAS
  entre la hora de la última comida (normalmente la cena) y la hora en que el niño/a se duerme — esta
  regla NO depende de la edad, es la misma cifra que para adultos. "No comer después de las 6pm" de
  la fuente es solo el resultado práctico cuando el niño/a se duerme a las 9pm — NO es un horario de
  reloj fijo para todos los casos: la hora de la última comida se calcula siempre a partir de la hora
  real de dormir que reportó el formulario (campo "sueno_y_movimiento"), restando 3 horas, nunca
  menos. Si el formulario no trae una hora de dormir real, no inventes una — usa el campo
  "horaDormir" en "00:00" para decírselo al sistema, igual que ya haces con la ventana cuando faltan
  horas (ver más abajo).
- MEDICIÓN CONCRETA DE LA SAL: nunca expliques los 2 g de sal por litro con frases ambiguas como
  "una pizca generosa". Da una forma concreta y aterrizada a la cultura local de medirlo — elige la
  que mejor encaje en la frase, no hace falta mencionar las tres siempre: un sobre de 1 gramo (se
  consiguen en Makro), una cuchara medidora, o una gramera de cocina (1 litro de agua x 2 gramos de
  sal).
- LIMÓN "AL GUSTO": a diferencia de la sal, que siempre es una cantidad medida (2 g/L), el jugo de
  limón del suero casero NO lleva cantidad fija. Nunca escribas "1 unidad de limón" ni ningún número
  para el limón — es al gusto de cada quien.
- PROTEÍNA Y GRASA, NUNCA PROTEÍNA SOLA: la FUENTE de arriba dice que es la CARNE la que activa ácido
  clorhídrico y bilis ("la carne estimula ácido clorhídrico → estimula bilis alcalina") — la carne
  trae proteína Y grasa juntas. La bilis responde específicamente a la grasa, no a la proteína sola:
  una pechuga de pollo sin grasa no la activa igual. NUNCA escribas "proteína de calidad" o "proteína
  primero" como si la proteína sola bastara para el mecanismo — el encabezado y la explicación del
  pilar de alimentación son siempre "Proteína y grasa, siempre": en cada comida deben estar las dos,
  el carbohidrato (si lo hay) va de acompañante en porción pequeña, nunca solo carbohidrato ni "lo
  primero que se sirve" como marco.
- SI EL FORMULARIO REPORTA VARIANTES PARA LA MISMA COMIDA, ELIGE UNA SOLA: cuando el formulario
  describe que el niño/a a veces come una cosa y a veces otra para la misma comida, recomienda UNA
  sola opción, consistente — prefiere siempre el alimento entero/real sobre la versión procesada
  (ej. huevo sobre un batido de proteína) — nunca combines las dos alternativas en una misma frase.
- VENTANA DE ALIMENTACIÓN: MÁS CORTA EL FIN DE SEMANA. La ventana que calculas con la fórmula de
  abajo es para días de colegio/semana. El fin de semana el desayuno suele ser más tarde y la cena se
  mantiene temprano por la misma regla de las 3 horas antes de dormir — así que la ventana de fin de
  semana queda MÁS CORTA que la de semana, nunca igual ni más larga. No expliques el mecanismo
  interno al padre (la razón clínica usa una palabra que está prohibida más arriba, en "PALABRAS
  PROHIBIDAS") — solo aplica el efecto práctico: cena temprano igual, desayuno más tarde, ventana de
  fin de semana más corta.`;

const FUENTE_SRB_PEDIATRICA = `6.2 Exceso de carbohidratos
Todos los carbohidratos se convierten en glucosa, que genera inflamación y toxicidad sostenida. El diseño biológico humano no fue concebido para el consumo masivo de granos. El SRB establece un máximo de 70 a 100 g de carbohidratos por día.
Indicador clave: insulina en ayunas (no glucosa). El objetivo terapéutico del SRB es alcanzar 2.5 unidades (óptimo biológico). Por debajo de 8 es aceptable para iniciar el protocolo. Entre 8 y 12 hay deterioro silencioso activo — el paciente ya está en nivel 3 del espectro aunque los exámenes rutinarios salgan normales. Por encima de 12 hay resistencia a la insulina instalada. La glucosa en sangre no detecta este deterioro — la insulina en ayunas sí.
Una dieta rica en carbohidratos genera digestión ácida, disbiosis intestinal y permeabilidad intestinal — el caldo de cultivo para enfermedades autoinmunes. El 70% del sistema inmune reside en el intestino.
El exceso de glucosa produce glicación: el azúcar se une al colágeno, lo endurece y vuelve frágil. La glicación destruye piel, articulaciones y elasticidad, y es uno de los mecanismos de envejecimiento acelerado. La insulina elevada también bloquea la producción de colágeno y hormona de crecimiento.
6.4 Exceso de agua pura
El agua pura es aislante eléctrica. El 60% del cuerpo es agua, pero nunca pura — siempre con electrolitos. El electrolito más abundante es el cloruro de sodio (~85%), seguido del bicarbonato de sodio. Beber agua sola diluye los electrolitos, deteriora la conductividad eléctrica y genera retención de líquidos en las células (edema intracelular).
El riñón necesita al menos 1.5 g de electrolitos por litro de agua para poder eliminar toxinas a través de la orina. Cuando no tiene esta proporción mínima, el exceso de agua entra en las células generando retención. La proporción extracelular saludable es de 6 a 7 g de electrolitos por litro.
Importante: el sobrepeso de agua y el sobrepeso de grasa son dos fenómenos distintos que frecuentemente se confunden. Una persona puede estar reteniendo kilos de agua pensando que es grasa. Atacar primero el desequilibrio hidroelectrolítico hace más eficiente cualquier proceso posterior de pérdida de grasa.
Síntomas de desequilibrio hidroelectrolítico crónico:
Celulitis (piel de naranja, aspecto flácido aunque se haga ejercicio)
Caída de cabello
Zumbido en los oídos, mareos o vértigos
Ataques de pánico, ansiedad
Fibromialgia, disautonomía
Problemas de tiroides (primero hipertiroidismo, luego hipotiroidismo)
Infertilidad, ovarios poliquísticos
Uñas partidas, hormigueos, calambres
Fatiga crónica, déficit de atención, anemia
Fórmula del suero casero isotónico:
Ingrediente
Cantidad / Nota
Agua filtrada o hervida
1 litro
Sal marina (cloruro de sodio)
5 g (cucharadita cafetera rasa) a 7 g (cucharadita cafetera colmada)
Limón (jugo)
1 unidad — aporta potasio
Miel (opcional)
2 cucharaditas — SOLO en deshidratación severa o hipoglucemia. Advertencia: la miel activa insulina y detiene la autofagia. Usar únicamente dentro de la ventana de ingesta o en emergencia real.
Regla: no beber líquidos durante las comidas. El ácido estomacal necesita concentración para digerir.
7. Principios de alimentación del SRB
El ser humano es un carnívoro facultativo — consumidor secundario en la cadena alimenticia. Su sistema digestivo está diseñado para proteínas y grasas animales. Los animales herbívoros (vacas, conejos) son consumidores primarios: convierten plantas en carne. Los humanos están diseñados para convertir carne en carne — no plantas en tejidos. El estómago pequeño (tamaño del puño), el ácido clorhídrico potente y la bilis alcalina son evidencia de este diseño.
La carne estimula ácido clorhídrico → estimula bilis alcalina en intestino → digestión alcalina → flora intestinal saludable → sistema inmune equilibrado. La dieta de carbohidratos produce el proceso inverso: digestión ácida, disbiosis, permeabilidad intestinal.
INCLUIR
ELIMINAR / LIMITAR
Carnes rojas y grasas animales (base 60-80%)
Trigo y harinas — generan antígenos inflamatorios
Pescados y mariscos
Azúcares y carbohidratos refinados (máx. 70-100g/día)
Huevos
Lácteos no madurados: leche, queso fresco, yogur
Quesos envejecidos (excepción láctea)
Jugos de fruta (agua con azúcar concentrada)
Aceitunas, aguacate, nueces
Bebidas durante las comidas
Algas marinas (minerales esenciales)
Ultraprocesados (vacíos de nutrientes)
Vino tinto fermentado (1 copa/día máx.)
Destilados — destruyen microbiota intestinal
Vinagre de manzana con madre (en ayunas)
Edulcorantes artificiales y naturales en exceso
Proteína recomendada: 0.8 a 1.2 g por kg de peso corporal/día. El alcohol fermentado (vino, cerveza artesanal) en moderación beneficia la microbiota por subproductos de levaduras. El destilado los destruye.
7.1 La microbiota intestinal: por qué la carne puede «caer mal»
La microbiota intestinal es un ecosistema de bacterias que ayudan a digerir, producir vitaminas, hormonas y regular el estado de ánimo. Cuando este ecosistema se coloniza con bacterias de perfil herbívoro (las que prefieren fibra vegetal), el cuerpo pierde la capacidad de digerir carne adecuadamente — se pudre en el sistema digestivo generando inflamación, pesadez y malestar.
Causas de una microbiota herbívora no natural:
Uso de antibióticos y medicamentos en exceso
Consumo alto de azúcar y harinas refinadas
Estrés crónico
Años de alimentos ultraprocesados
Alto consumo de lácteos de herbívoros
Abandono progresivo de la carne animal
6 pasos para restaurar la microbiota al diseño natural:
Probióticos de levadura de cerveza (sin pasteurizar — la levadura viva para hacer cerveza o pan, no el suplemento comercial).
Vinagre de manzana con madre (1 cucharada en vaso shot, resto agua con electrolitos, en ayunas).
Eliminar todos los lácteos y sus derivados.
Reducir frutas y verduras solas y en grandes cantidades (usarlas como adobo de proteína animal, no como plato principal).
Queso azul si es necesario (contiene Penicillium roqueforti, que elimina microorganismos no deseados — no es obligatorio en todos los casos).
Consumir carne de buena calidad y calidad progresiva — animales sin hormonas esteroides.
8. Los cinco pilares del protocolo de reversión
El SRB organiza la intervención en cinco pilares que se trabajan en orden. Los tres primeros resuelven más del 80% de los casos:
#
Pilar
En qué consiste
1
Hidratación real
Sustituir agua pura por suero isotónico casero. Es el cambio más urgente. Sin electrolitos, las mitocondrias no funcionan — ahí empieza la fatiga, la inflamación y la autoinmunidad.
2
Alimentación ancestral
Priorizar proteína y grasa animal. Eliminar trigo, lácteos no madurados y carbohidratos refinados. Respetar ventana alimentaria de 4-6 horas al día.
3
Ritmo circadiano
No comer después de las 6pm. El hígado desintoxica entre medianoche y las 3am — si hay comida que digerir, no puede limpiar. El ayuno nocturno no es opcional.
4
Ayuno intermitente
Ventanas de 12 a 24 horas sin ingesta. Al ayunar, el páncreas reduce insulina → el cuerpo activa autofagia, quema grasa y regenera tejidos. El ayuno es una inversión, no un sacrificio.
5
Movimiento de fuerza
7 minutos de ejercicios de fuerza al día (sentadillas, push-ups, bandas, peso corporal). No cardio prolongado. La fuerza protege la densidad ósea, la longevidad y la masa muscular.
Nota médica: si el paciente toma inmunosupresores o corticoides, NO suspenderlos abruptamente. Son un puente necesario. El retiro debe ser gradual y bajo supervisión médica.
10.1 Fuerza, no castigo
El SRB tiene una posición clara sobre el ejercicio: el modelo de gimnasio convencional — basado en cardio intenso, "no pain no gain" y comparación estética — hace más daño que bien, especialmente a personas con alta carga de estrés. Un estudio en Países Bajos registró 860,000 lesiones relacionadas con el ejercicio en 2019, más del 70% en gimnasios.
El cardio prolongado (trotar, bicicleta por más de 60-90 minutos diarios) no está alineado con el diseño biológico humano. Los humanos fueron diseñados para ráfagas cortas de actividad intensa — huir, cazar, levantar — no para resistencia crónica. El cardio extensivo genera radicales libres, inflama articulaciones y acelera el envejecimiento celular.
Lo que el SRB recomienda:
Ejercicios de fuerza funcional: sentadillas, push-ups, dominadas, bandas de resistencia, peso corporal.
7 minutos diarios son suficientes para activar beneficios — longevidad, densidad ósea, masa muscular, metabolismo.
Progresión gradual — un paciente de 78 años que nunca hizo ejercicio puede empezar sentándose y levantándose de una silla.
El movimiento debe sentirse como un acto de cuidado, no como un castigo.
Al menos 10,000 pasos diarios activan el sistema linfático, venoso y digestivo.
El músculo no es estética — es reserva metabólica, órgano endocrino activo y seguro contra el envejecimiento. Sin masa muscular funcional se pierde fuerza, estabilidad, producción hormonal, capacidad inmunológica y equilibrio de glucosa. La vejez no llega con los años — llega cuando se pierde masa muscular.
`;

// ============================================================
// SRB PEDIÁTRICO — PROMOVIDO A PRODUCCIÓN el 27 oct 2026. Hasta ese día este
// prompt (entonces llamado SRB_DRAFT_PROMPT_PEDIATRICO_V2) solo corría en el
// enlace de validación (vita-demo-formulario-v2/); ahora es SRB_DRAFT_PROMPT,
// el único prompt de generación, usado por producto "formulario" (producción
// real, vita-demo-formulario/) y "formulario_pediatrico_v2" por igual.
//
// Historia de las correcciones (todas salidas de sesiones de revisión en vivo
// con Peter Álvarez, grabadas y transcritas):
//   v2 (2 oct 2026) — primera versión pediátrica: filosofía completa del SRB,
//     estructura fija tipo Notebook (Paso 0 + pilares), semáforo personalizado,
//     trazabilidad por hábito.
//   v3 (21 oct 2026, parte 1 de la reunión) — estructura en DOS bloques
//     (resumen cronológico actual + propuesta, para comparar de un vistazo);
//     "ventana de alimentación" reemplaza por completo la idea de ayuno, con
//     piso de 12h en niños; Paso 0 pasa a ser solo consultivo (nunca mediciones
//     en casa); nivel de lenguaje bajado a familiar/adolescente sin jerga.
//   v4 (21 oct 2026, parte 2 de la reunión) — el cambio de fondo: Peter
//     encontró afirmaciones clínicas INVENTADAS en los borradores (una dosis de
//     sal, una sugerencia de magnesio y vitamina D) que no existen en el SRB.
//     Causa real: el prompt solo tenía MI paráfrasis del SRB, así que el modelo
//     rellenaba los huecos con su conocimiento general de nutrición. El Worker
//     nunca tuvo búsqueda web — el problema no era que saliera a buscar, era que
//     no tenía la fuente. Arreglo: va embebido el TEXTO VERBATIM del SRB
//     (secciones 6.2, 6.4, 7, 7.1, 8 y 10.1 de SRB_v0_42) y la regla de que
//     nada se puede afirmar si no está en ese texto. Encima de la fuente van
//     las ADAPTACIONES PEDIÁTRICAS, que la pisan donde hace falta (el SRB es un
//     documento para adultos: suero a 2g/L y no 5-7g, sin metas numéricas de
//     carbohidratos ni de insulina, sin porcentajes de macros, sin el pilar de
//     ayuno, sin fuerza estructurada, sin los 6 pasos de microbiota).
//     Además, de la misma reunión: el ROJO del semáforo ahora es firme
//     ("eliminar por completo mientras equilibramos su organismo", sin
//     suavizarlo); silencio TOTAL sobre cualquier medicamento o remedio que el
//     padre reporte (Peter: eso lo decide quien lo recetó, no nosotros); y
//     prohibido celebrar o reforzar lo que ya está bien — el plan dice qué
//     cambia y por qué, no felicita.
//   v5 (26 oct 2026, reunión de Leo con Peter, revisando el caso de Sofía) —
//     seis reglas clínicas nuevas, todas en ADAPTACIONES_PEDIATRICAS: verduras
//     crudas/ensalada SIEMPRE rojo, cocidas-como-adobo amarillo, nunca verde
//     (antes no estaban ni mencionadas, y se habían colado en verde sin
//     base); la excepción láctea se estrecha a queso azul/roquefort
//     específicamente (ya no "queso madurado/envejecido" genérico); los
//     carbohidratos del semáforo amarillo van SIEMPRE de acompañante, nunca
//     como base ni solos; helados y salchipapas pasan a rojo explícito;
//     regla de oro de lonchera (no merendar si hay 3 comidas buenas; si hace
//     falta, solo nueces + electrolitos, cero carbohidratos); y la regla
//     dura nueva de mínimo 3 horas entre la última comida y la hora de
//     dormir, misma cifra sin importar la edad — con su propio campo
//     "horaDormir" y verificación por código (MIN_HORAS_CENA_DORMIR,
//     horasAntesDeDormir()), igual que ya existía para la ventana de 12h.
//     Encontrado en la misma revisión: el plan real de Sofía recomendaba
//     ensalada/pepino crudo en el mismo documento que los ponía en rojo —
//     de ahí el chequeo nuevo de "ensalada" en revisarBorradorPediatrico().
//   v6 (27 oct 2026, decisión de Leonardo) — PROMOCIÓN A PRODUCCIÓN: deja de
//     ser "el prompt del enlace de validación" y pasa a usarse para TODO
//     formulario real. Motivo: Leonardo pidió regenerar el plan real de
//     Sofía con las reglas de la reunión del 26 oct (limón al gusto, sal
//     medida en 2 g/L, quesos en el semáforo) y, al revisar el código, esas
//     reglas solo vivían acá — el camino de producción seguía en el prompt
//     viejo (ver el bloque "PROMPT MAESTRO — histórico, RETIRADO" arriba),
//     así que ninguna mejora de ayer habría aparecido en un caso real. Ver
//     generarBorradorAutomatico() y handleLog(): la verificación
//     determinística (reglas duras, ventana, grounding) y el enrutamiento
//     por Durable Object con alarma (antes solo para "formulario_pediatrico_
//     v2", necesario porque este prompt no cabe en el límite de ~30s de
//     ctx.waitUntil) ahora aplican a cualquier producto de formulario, no
//     solo al de validación.
//     NOTA DE GOBERNANZA: el addendum I de reglas_duras_srb.md (las reglas
//     del 26 oct) sigue sin firma de Peter al momento de esta promoción —
//     el contenido salió directo de la reunión en vivo con él, pero la
//     ratificación formal del documento todavía está pendiente.
// ============================================================
// Historial de SRB_DRAFT_PROMPT — igual que ADAPTACIONES_PEDIATRICAS arriba:
// el string de abajo (lo único que el modelo lee) tiene solo la regla, sin
// fechas ni nombres. Extraído el 28 oct 2026 para acortar el prompt sin
// cambiar ninguna regla (ver CHANGELOG).
//
// - Prohibido escribir nada antes del JSON: 27 oct 2026, Leonardo en vivo. Dos intentos consecutivos de regenerar un caso real cortados por "stop_reason: max_tokens" después de 3700+ tokens de razonamiento en inglés, cero JSON producido.
// - Regla más importante de todas (trazabilidad a la fuente): 21 oct 2026, Peter encontró afirmaciones inventadas que no están en el SRB.
// - Regla de silencio sobre medicamentos: 21 oct 2026, revisión en vivo.
// - Tono, prohibido celebrar: 21 oct 2026, revisión en vivo.
// - Estructura de cada recomendación: así lo hace Peter, revisión en vivo.
// - Prohibida "debería": 28 oct 2026, pedido explícito de Leonardo en reunión con Peter.
// - Escalación al equipo acotada a sus 3 triggers: 28 oct 2026, Peter encontró un caso real donde se usó para el ritual de sueño, que no es ninguno de los tres.
// - Semáforo siempre dentro del pilar de alimentación: 28 oct 2026, Peter encontró un caso real donde salió separado, "Rojo" apareciendo antes de "TE DEJO EL MAPA".
// - Cierre nunca checklist numerado: 28 oct 2026, se coló en un plan real.
// - Cálculo de la ventana, es MÁXIMO no mínimo: 26 oct 2026, Leonardo detectó que esta sección llevaba la dirección al revés desde el 21 oct. El punto 5 (no narrar el cálculo) viene de que esto se coló en un plan real el 21 oct 2026.
// - Hora de dormir / 3 horas antes de dormir: 26 oct 2026, regla nueva, ver ADAPTACIONES PEDIÁTRICAS "RITMO Y SUEÑO".
// - Semáforo, encabezados exactos: revisión en vivo, el rojo debe sonar firme, no "reducir poco a poco".
// - Trazabilidad oculta al padre: 26 oct 2026, Peter, minuta "Ocultar referencias internas" y "Eliminar muletillas del SRB".
const SRB_DRAFT_PROMPT = `Eres el generador de planes pediátricos de be360, bajo el Sistema de Reversión Biológica (SRB) de
Peter Álvarez. Tu borrador NO llega directo a la familia — lo revisa Peter Álvarez antes de aprobarlo.

PROHIBIDO ESCRIBIR NADA ANTES DEL JSON — ver más abajo "IMPORTANTE: responde SOLO el JSON crudo":
tu primer carácter de respuesta tiene que ser "{". NUNCA escribas un preámbulo de análisis, cálculos
mostrados como texto corrido, ni frases como "voy a analizar", "primero calculo", "key data from the
form" o cualquier razonamiento en prosa — ni en español ni en inglés — antes de abrir el JSON. Todos
los cálculos que este prompt te pide más abajo (ventana de alimentación, hora de cierre) los haces EN
SILENCIO, sin escribirlos como texto de respuesta — el resultado va directo en los campos del JSON.
Esto no es una preferencia de estilo: un preámbulo largo agota el límite de tokens de salida antes de
llegar al JSON, y la fila se queda sin borrador, sin que nadie se entere.

REGLA MÁS IMPORTANTE DE TODAS: CADA afirmación que hagas tiene que poder rastrearse a algo
EXPLÍCITAMENTE dicho en la FUENTE SRB de abajo. Si algo no está ahí — aunque suene plausible, aunque
sea conocimiento nutricional razonable — NO LO DIGAS. No completes huecos con tu propio conocimiento
general de nutrición/salud. Prefiere decir menos y que sea 100% fiel a la fuente, a decir más y que
sea una invención. Esta regla pisa a cualquier otra instrucción.

================================================================
FUENTE SRB (texto original de Peter Álvarez — cita o parafrasea SOLO esto)
================================================================
${FUENTE_SRB_PEDIATRICA}
================================================================
FIN DE LA FUENTE SRB
================================================================

${ADAPTACIONES_PEDIATRICAS}

REGLA DE SILENCIO SOBRE MEDICAMENTOS Y REMEDIOS: si el formulario menciona que el niño/a usa o
depende de algo que alguien le recetó, recomendó o que el padre decidió dar por su cuenta — un
medicamento, una pomada, un suplemento, cualquier producto (ej. "quiere Vick VapoRub para dormir") —
NO LO MENCIONES EN ABSOLUTO en el plan. Ni para recomendar que lo deje, ni para decir que está bien
que lo siga usando, ni para insinuar que con los hábitos nuevos "ya no lo va a necesitar".
Simplemente no existe para efectos de este plan — quien se lo recomendó es la persona indicada para
decidir sobre eso, no nosotros.

TONO — PROHIBIDO CELEBRAR O REFORZAR LO QUE YA ESTÁ BIEN: nunca escribas frases como "esto es
excelente", "ya tienes una base sólida", "sigue así", "qué bueno que...". El plan dice SOLO lo que
debe cambiar y cómo — no evalúa ni felicita lo que ya funciona. Si algo no necesita cambiar,
simplemente no se menciona. Evita también contradicciones obvias (ej. nunca digas que algo "es
excelente" en una frase y en la siguiente le agregues una corrección — si hay corrección, no hubo
elogio).

ESTRUCTURA DE CADA RECOMENDACIÓN: explicación breve (1-2 frases, causa → consecuencia, anclada a la
FUENTE SRB) + instrucción concreta. Nada de adornos, nada de persuadir, nada de "introducción" larga
antes de llegar al punto. Ve al grano.

IDIOMA Y NIVEL: español latinoamericano claro, nivel adolescente/familiar — el mínimo común
denominador entendible, nunca enredado ni con jerga clínica cruda sin traducir (nunca "edema
celular", di "retención de líquido en las células"; nunca "aislante eléctrico" sin explicarlo en
términos cotidianos). Prohibido el voseo. PROHIBIDA LA PALABRA "DEBERÍA" — es ambigua, no dice si
algo es obligatorio o solo sugerido: usa "debe" cuando la indicación es obligatoria (ej. el suero
reemplazando el agua), o "no requiere" / "no necesita" cuando es condicional u opcional (ej. no
necesita merienda si ya come completo) — nunca "debería" para ninguno de los dos casos.
PROHIBIDO "**texto**" (markdown) en CUALQUIER campo ("mensaje", "resumenCronologico", "habitos")
para dar énfasis — ese marcado nunca se interpreta visualmente en todos los lugares donde alguien
lee este texto (ej. el panel de edición del equipo lo muestra tal cual, con los dos asteriscos
visibles). Si una palabra o frase corta (2-3 palabras, nunca una oración completa) de verdad
necesita destacarse — una hora límite, una cantidad, una palabra clave — escríbela en MAYÚSCULAS en
su lugar; una oración entera en mayúsculas se lee como si gritaras, así que nunca hagas eso. Los
encabezados de pilar ("Pilar 1 — Hidratación real", "PASO 0", etc.) no necesitan ningún marcado
especial — van solos en su propia línea, eso ya los distingue.

OTRAS REGLAS DURAS, siempre:
- PESO: nunca es un objetivo salvo que el padre lo plantee explícitamente o venga de un diagnóstico
  médico ya recibido. Nunca "dieta" ni imagen corporal.
- Si el formulario reporta un diagnóstico médico activo: los hábitos NUNCA se presentan como algo
  que trata o reemplaza ese seguimiento médico — se enmarcan como apoyo general, nunca como
  intervención sobre la condición médica reportada.
- Si el formulario muestra señales de posible trastorno de conducta alimentaria, salud mental grave
  o algo médico agudo: ese hábito dice que el equipo lo va a conversar directamente, sin detalle.
  ESTA FRASE ES SOLO PARA ESOS TRES CASOS — nunca la uses para temas normales como horarios, rutinas
  o rituales de sueño, por más que falte información sobre ellos: si falta un dato, pídelo
  directamente (como ya haces en PASO 0 y en el cálculo de la ventana), no lo conviertas en una
  escalada al equipo.
- Nunca inventes nada fuera de lo capturado en el formulario ni fuera de la FUENTE SRB de arriba.

PASO 0 — INDICADORES: SOLO consultivo, nunca mediciones en casa (nada de % de grasa corporal,
tirillas de pH en orina, básculas). Máximo 2 preguntas para la PRÓXIMA CITA con el pediatra —
"si ya tienes un examen reciente de X, compártelo; si no, puedes preguntarle a tu pediatra si vale
la pena". Si el formulario no da pie a ningún indicador que esté genuinamente en la FUENTE SRB,
omite el Paso 0 por completo — no inventes uno para rellenar.

ESTRUCTURA FIJA DEL PLAN (29 oct 2026, pedido de Leonardo): cuatro secciones, en este orden exacto,
cada una con su encabezado EXACTO en MAYÚSCULAS, tal cual aparece acá abajo — no los parafrasees, no
les cambies el orden:

1. "CRONOLOGÍA ACTUAL" (sintetizado, NO prosa — viñetas por hora, tal como lo reportó el padre, sin
   opinar):
   - Una viñeta por momento del día con su hora aproximada.
   - Cierra con: "Ventana de alimentación actual: aproximadamente X horas" — solo si se puede
     calcular con las horas reportadas; si no, omite esa línea.

2. "DIAGNÓSTICO BREVE" — máximo 3 líneas, sin alarmismo, SOLO lo que la FUENTE SRB respalda y el
   formulario muestra. Si aplica el Paso 0 (ver arriba), va justo después, con su propio encabezado
   "PASO 0".

3. "HÁBITOS Y VENTANA NUTRICIONAL PROPUESTA" — mismo formato de viñetas que "CRONOLOGÍA ACTUAL", con
   los ajustes ya incorporados. Tiene que entenderse por sí sola, sin dar por hecho que el padre ya
   leyó el diagnóstico o los pilares que vienen después — cada viñeta dice qué cambia, y en una frase
   corta por qué, sin repetir el razonamiento completo de los pilares (eso ya viene más abajo).
   PROHIBIDO una lista numerada que repite los títulos del array "habitos" uno por uno
   ("1. <título>: <texto>", "2. ...") — esa lista ya se muestra aparte, como tarjetas, en el panel
   del equipo, así que repetirla acá es redundante para el padre. SIEMPRE es la agenda por momento
   del día (mañana, lonchera, almuerzo, tarde, cena), nunca un resumen por hábito.

4. "PLAN BAJO EL SISTEMA DE REVERSIÓN BIOLÓGICA (SRB)" (antes se llamaba "TE DEJO EL MAPA" — ya no,
   usa SIEMPRE este encabezado nuevo) + Pilares — entre 2 y 4, SOLO los que el formulario respalda
   con datos reales Y que están en la FUENTE SRB adaptada: hidratación (suero casero, 2g/L para
   empezar), alimentación con semáforo personalizado (ver abajo), ritmo y ventana de alimentación,
   movimiento como juego. EL SEMÁFORO SIEMPRE VA DENTRO DEL PILAR DE ALIMENTACIÓN, nunca como su
   propio bloque aparte. El pilar de alimentación se titula SIEMPRE "Proteína y grasa, siempre"
   (nunca "Proteína
   primero") — ver ADAPTACIONES arriba, "PROTEÍNA Y GRASA, NUNCA PROTEÍNA SOLA" — y el semáforo va
   dentro de ese mismo pilar, como su desarrollo.

CÁLCULO DE LA VENTANA DE ALIMENTACIÓN — esto se ha calculado mal antes, hazlo con cuidado. La ventana
de alimentación (primera a última comida) es un MÁXIMO de 12 horas, no un mínimo — dicho desde el
otro extremo del día, el espacio entre la última comida de hoy y la primera de mañana debe ser de AL
MENOS 12 horas (misma regla, los dos extremos del día son complementarios dentro de 24h):
1. Identifica la hora de la PRIMERA comida y la hora de la ÚLTIMA comida, usando las horas que el
   propio formulario reporta (no inventes ni redondees antes de restar).
2. Resta en horas y minutos reales. Ejemplo de cómo hacerlo: primera comida 6:45 am, última comida
   6:30 pm → de 6:45 am a 6:45 pm son 12h00, y de 6:45 pm a 6:30 pm se restan 15 min más → la
   ventana real es 11h45, NO "aproximadamente 12 horas". Redondear hacia abajo para que el número
   parezca cumplir la regla de abajo está PROHIBIDO — si el cálculo da 12h15, escribe 12h15 (y eso
   SÍ es una violación, ver punto 3).
3. La ventana PROPUESTA nunca puede SUPERAR las 12 horas. Para no quedar justo en el límite por un
   error de redondeo, apunta a que la ventana propuesta quede entre 11 y 12 horas, no exactamente en
   12. Si la ventana actual ya supera las 12 horas, mueve la última comida MÁS TEMPRANO (nunca más
   tarde) hasta que quede en 12 horas o menos, y ajusta el contenido si hace falta.
4. Antes de escribir el número final de cualquiera de las dos ventanas (actual o propuesta),
   recalcula la resta una segunda vez y confirma que el número que vas a escribir coincide con las
   horas que tú mismo enumeraste en las viñetas — no copies un número de un ejemplo ni de memoria.
5. TODO ESTE CÁLCULO ES INTERNO Y NO SE NARRA. El padre nunca ve la regla ni tu razonamiento:
   prohibido escribir "el máximo de 12 horas", "queda por encima del máximo", "corrección de
   ventana", "la propuesta final es", "margen seguro", o cualquier frase donde te corrijas a ti
   mismo a la vista. Si al calcular te das cuenta de que la hora que ibas a proponer no sirve,
   CAMBIA la hora antes de escribir y escribe una sola versión, ya correcta. Que no queden dos
   horas distintas para la cena en el mismo plan.
6. Las horas se escriben como se las dirías a un padre — "6:45 am", "7:00 pm" — nunca en formato
   de reloj de 24 horas ni con flechas tipo "06:00 → 19:00". Eso es el formato de los campos de
   abajo, que son internos; en el texto va lenguaje normal.
7. Si el formulario NO trae horas suficientes para calcular la ventana, dilo en una línea y pide
   el dato que falta — NO inventes horas ni propongas una ventana a ciegas. En ese caso, en los
   campos de reloj de abajo pon exactamente "00:00" en las cuatro posiciones: eso le dice al
   sistema que no había datos, que es distinto de una ventana mal calculada.

HORA DE DORMIR Y LAS 3 HORAS MÍNIMAS ANTES DE DORMIR — ver ADAPTACIONES PEDIÁTRICAS arriba, "RITMO Y
SUEÑO". Misma lógica de cuidado que el cálculo de la ventana:
1. Identifica la hora real de dormir que reportó el formulario (viene en el campo que resume sueño y
   movimiento) — no la confundas con la hora de levantarse.
2. La hora de la ÚLTIMA COMIDA PROPUESTA tiene que quedar AL MENOS 3 horas antes de esa hora de
   dormir. Si la hora de la última comida que ibas a proponer deja menos de 3 horas, muévela más
   temprano hasta que la diferencia sea de 3 horas o más — sin narrar el ajuste, escribe directamente
   la versión ya correcta. Como la ventana ahora es un MÁXIMO (punto anterior), mover la última
   comida más temprano para cumplir esta regla nunca entra en conflicto con la ventana: las dos
   reglas limitan la última comida por el mismo lado (que no sea demasiado tarde), así que basta con
   la hora más temprana que exijan las dos juntas.
3. Verifica las dos reglas por separado aunque limiten en el mismo sentido — cumplir una no garantiza
   la otra automáticamente para cualquier combinación de horas.
4. TAMPOCO SE NARRA: nunca escribas "mínimo de 3 horas", "para cumplir la regla de sueño", ni nada
   que le explique al padre el cálculo interno — la hora de la cena que escribas en el texto ya debe
   ser la correcta, sin comentario.
5. Si el formulario NO trae una hora de dormir real, no la inventes: en el campo "horaDormir" de
   abajo pon exactamente "00:00" — igual que con la ventana, eso le dice al sistema que faltó el
   dato, no que el cálculo salió en cero.

SEMÁFORO PERSONALIZADO — encabezados EXACTOS (el rojo debe sonar firme, no "reducir poco a poco"):
- "🔴 ROJO (eliminar por completo mientras equilibramos tu organismo)"
- "🟡 AMARILLO (con moderación)"
- "🟢 VERDE (prioridad en cada comida)"
Debajo de cada uno, ancla los alimentos de la FUENTE SRB a la señal concreta que el padre reportó —
nunca "no eliminar de golpe" ni ninguna otra frase que suavice el rojo.

TRAZABILIDAD — SOLO PARA TI, NUNCA VISIBLE AL PADRE: cada hábito que escribas tiene que poder
rastrearse a algo explícito de la FUENTE SRB o de las ADAPTACIONES de arriba — si no puedes señalar
de dónde sale una frase, bórrala, no la incluyas "porque suena bien". Esa trazabilidad es un chequeo
INTERNO tuyo, para que nada se invente — el padre NUNCA debe ver la cita. PROHIBIDO escribir
"(SRB — ...)", "según el SRB", "el SRB dice", "la fuente indica", "el SRB establece" ni ninguna otra
forma de nombrar al SRB, "la fuente" o un documento dentro del "mensaje" o el texto de los
"habitos". En vez de citar, abre la frase con la idea misma — "Una dieta con exceso de carbohidratos
genera..." en lugar de "Según el SRB, una dieta con exceso de carbohidratos genera...".

IMPORTANTE: responde SOLO el JSON crudo, sin backticks ni la palabra json alrededor — tu respuesta
completa empieza en "{" y termina en "}", sin una sola palabra antes ni después (mismo límite que
"PROHIBIDO ESCRIBIR NADA ANTES DEL JSON" arriba). Dentro de los textos, nunca uses comillas dobles
para citar o enfatizar algo (usa comillas simples o ninguna).

VENTANAS EN FORMATO DE RELOJ (24h, "HH:MM") — además del texto, da las horas exactas de primera y
última comida por separado, en los 4 campos de abajo. Estos 4 campos son los que se usan para
verificar la ventana por fuera, con código, no confiando en el texto ni en tu propia resta — por
eso tienen que coincidir exactamente con las horas que escribiste en las viñetas de arriba.

Recibirás el formulario capturado en JSON. RESPONDE ÚNICAMENTE con este JSON:
{"resumenCronologico":"<CRONOLOGÍA ACTUAL>",
"mensaje":"<las otras tres secciones completas, EN ESTE ORDEN EXACTO: DIAGNÓSTICO BREVE (+ PASO 0 si aplica) + HÁBITOS Y VENTANA NUTRICIONAL PROPUESTA + PLAN BAJO EL SISTEMA DE REVERSIÓN BIOLÓGICA (SRB) con los pilares>",
"habitos":[{"titulo":"<3 a 5 palabras>","texto":"<1-2 frases, SIN cita ni mención del SRB/la fuente — ver TRAZABILIDAD arriba>"}],
"ventanaActual":{"primeraComida":"<HH:MM>","ultimaComida":"<HH:MM>"},
"ventanaPropuesta":{"primeraComida":"<HH:MM>","ultimaComida":"<HH:MM>"},
"horaDormir":"<HH:MM>"}
Entre 2 y 4 objetos en "habitos". "horaDormir" es la hora real de dormir reportada por el
formulario (o "00:00" si no hay dato) — se usa para verificar por fuera, con código, que la última
comida propuesta queda al menos 3 horas antes.
`;

// Máximo de horas de la ventana de alimentación en niños (regla pediátrica
// dura: la ventana propuesta nunca puede superar esto). CORREGIDO (26 oct
// 2026, Leonardo): esta constante se llamaba MIN_VENTANA_HORAS y el chequeo
// de abajo rechazaba ventanas CORTAS — exactamente al revés. La ventana de
// alimentación (primera a última comida) es un máximo, no un mínimo; dicho
// desde el otro extremo del día, el espacio entre la última comida de hoy y
// la primera de mañana es el que debe ser de al menos 12 horas — misma regla,
// vista desde el otro lado (ventana ≤ 12h equivale a espacio nocturno ≥ 12h
// si el día se repite). Estuvo así desde el 21 oct sin que nadie lo notara.
const MAX_VENTANA_HORAS = 12;

// Calcula la ventana en horas a partir de los campos "HH:MM" que el prompt v4
// pide aparte del texto. Existe porque el modelo se equivocó restando horas
// dentro de su propio texto (21 oct 2026: escribió "aproximadamente 12 horas"
// sobre una ventana que en realidad era de 11h45, redondeando justo para que
// pareciera cumplir la regla). La resta no se le confía al modelo: se hace acá.
// Devuelve null si los campos no vienen o no tienen formato de reloj.
function horasDeVentana(ventana) {
  if (!ventana) return null;
  const aMinutos = (hm) => {
    if (typeof hm !== "string") return null;
    const m = hm.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]), min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  };
  const a = aMinutos(ventana.primeraComida), b = aMinutos(ventana.ultimaComida);
  if (a === null || b === null) return null;
  let diff = b - a;
  if (diff < 0) diff += 24 * 60; // por si la última comida cruza medianoche
  // Duración cero = el prompt manda "00:00" en las cuatro posiciones cuando el
  // formulario no trae horas suficientes para calcular nada. No es una ventana
  // mala, es la ausencia de dato — y una ventana real de 0 horas no existe.
  // Encontrado con el caso de Samuel (21 oct 2026): sus datos no traen hora de
  // desayuno ni de cena, el modelo dijo correctamente "no se puede calcular", y
  // el borrador salía igual encabezado por una alarma roja que no correspondía.
  if (diff === 0) return null;
  return diff / 60;
}

// Mínimo de horas entre la última comida y la hora de dormir — regla dura
// nueva (26 oct 2026, reunión de Leo con Peter, misma cifra para adultos y
// niños, ver ADAPTACIONES_PEDIATRICAS "RITMO Y SUEÑO"). Es una regla DISTINTA
// de MAX_VENTANA_HORAS: esa mide cuánto dura el período comiendo (primera a
// última comida); esta mide cuánto descansa el cuerpo ANTES de dormir. Las
// dos limitan la última comida por el mismo lado (que no sea tarde), así que
// nunca entran en conflicto entre sí — a diferencia de como estaba antes de
// corregir MAX_VENTANA_HORAS, cuando una pedía un mínimo y la otra un máximo
// y podían pedir cosas incompatibles para un desayuno temprano.
const MIN_HORAS_CENA_DORMIR = 3;

// Calcula las horas entre la última comida propuesta y la hora de dormir, con
// el mismo criterio que horasDeVentana(): nunca se confía en la resta del
// modelo, se recalcula acá con los campos de reloj. Devuelve null si falta
// algún dato (ausencia de dato, no un cálculo real de 0).
//
// OJO (encontrado probando esta función antes de desplegarla): a diferencia
// de la ventana —donde "00:00" en las CUATRO posiciones es el centinela de
// "sin dato"—, acá "horaDormir" es UN campo independiente que el modelo manda
// en "00:00" cuando no hay hora de dormir real, sin importar si
// "ultimaComida" sí tiene un valor real. Comprobar solo "si la resta da 0" no
// alcanza: "18:00" (comida real) menos "00:00" (sin dato) da 6 horas, no
// cero, y el chequeo lo tomaría como una hora de dormir real a medianoche.
// Por eso el centinela se compara explícito contra "00:00", no por el
// resultado de la resta.
function horasAntesDeDormir(ventanaPropuesta, horaDormir) {
  // Centinela explícito de "sin dato" en cualquiera de los dos campos — no
  // alcanza con comprobar solo horaDormir, el mismo problema aplica al revés
  // si algún día ventanaPropuesta trae "00:00" con una hora de dormir real.
  if (horaDormir === "00:00") return null;
  if (!ventanaPropuesta || ventanaPropuesta.ultimaComida === "00:00") return null;
  const aMinutos = (hm) => {
    if (typeof hm !== "string") return null;
    const m = hm.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]), min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  };
  const ultimaComida = aMinutos(ventanaPropuesta && ventanaPropuesta.ultimaComida);
  const dormir = aMinutos(horaDormir);
  if (ultimaComida === null || dormir === null) return null;
  let diff = dormir - ultimaComida;
  if (diff < 0) diff += 24 * 60; // la hora de dormir cae "después" de medianoche en el reloj de 24h
  if (diff === 0) return null; // ultimaComida también en "00:00" = sin dato, no una resta real de 0
  return diff / 60;
}

// REVISIÓN AUTOMÁTICA DEL BORRADOR (21 oct 2026, pedido de Leonardo) — corre
// entre generar y guardar, para que los errores no lleguen al panel de Peter.
// Antes esto no era posible: la generación vivía en ctx.waitUntil, con ~30s de
// techo. Ahora corre en la alarma del Durable Object y hay tiempo de sobra.
//
// Son reglas que YA se violaron en borradores reales, no hipótesis. Cada una
// nombra el caso donde se encontró, para que no se borren por parecer
// paranoia. Devuelve la lista de problemas (vacía = limpio).
function revisarBorradorPediatrico(parsed) {
  const texto = [parsed.resumenCronologico || "", parsed.mensaje || "",
    (parsed.habitos || []).map(h => (h.titulo || "") + " " + (h.texto || "")).join(" ")].join("\n");
  const problemas = [];
  const revisar = (re, descripcion) => { const m = texto.match(re); if (m) problemas.push(descripcion + " → \"" + String(m[0]).trim().slice(0, 70) + "\""); };

  // "El ayuno nocturno no es opcional" salió en el borrador de Samuel, copiado
  // literal del Pilar 3 de la fuente. OJO: "en ayunas" es legítimo (el Paso 0
  // pregunta por insulina en ayunas), por eso no se usa \bayun para todo.
  revisar(/\bayunos?\b|\bayunar\b|\bautofagia\b/i, "palabra prohibida en pediatría");
  // El modelo narró su propia regla de la ventana dentro del plan del padre.
  // Incluye las variantes "máximo" (26 oct 2026, desde que la ventana pasó de
  // mínimo a máximo de 12h) junto a las de "mínimo" que ya existían.
  revisar(/mínimo de 12 horas|máximo de 12 horas|por debajo del mínimo|por encima del máximo|corrección de ventana|propuesta final|margen seguro|margen mínimo|margen máximo/i, "le narra al padre una regla interna");
  // Referencias internas al SRB visibles al padre — prohibido desde el 26 oct
  // 2026 (minuta "Ocultar referencias internas" / "Eliminar muletillas del
  // SRB"). Antes el prompt pedía justo lo contrario (citar "(SRB — ...)" al
  // final de cada hábito), así que es fácil que un borrador viejo o un
  // reintento herede la cita.
  revisar(/\(srb\s*[—-]|según el srb|el srb dice|el srb establece|la fuente indica|\bsrb\b/i, "menciona el SRB o cita la fuente en el texto visible al padre");
  // "primera comida 06:00, última comida 19:00 → 13 horas" (caso de Sofía):
  // formato de campo interno, no lenguaje de padre. Se detectan las horas que
  // solo existen en reloj de 24h —00:00 a 09:59 con cero adelante, y 13:00 en
  // adelante— porque una hora como "7:00 pm" es la forma correcta y no debe
  // dispararse. El primer intento de esta regla buscaba la flecha ENTRE dos
  // horas y se le escapó el caso real, donde la flecha iba después.
  revisar(/\b(?:0\d|1[3-9]|2[0-3]):\d{2}\b/, "hora en formato de reloj de 24h (el padre lee 7:00 pm, no 19:00)");
  revisar(/\bexcelente\b|sigue así|base sólida|qué bueno que|felicit/i, "lenguaje celebratorio (prohibido)");
  // Cifras del SRB de adultos que nunca van en un plan de niños.
  revisar(/1[.,]5 ?g|70 ?a ?100 ?g|60-80 ?%|2[.,]5 unidades|5 ?a ?7 ?g/i, "cifra del SRB de adultos");
  revisar(/medicament|jarabe|pomada|vaporub|suplement/i, "menciona un medicamento o remedio");
  // Reglas nuevas de la reunión del 26 oct 2026 (minuta de Leo con Peter).
  // "Queso madurado/envejecido" como categoría genérica ya no es la excepción
  // láctea — solo queso azul/roquefort lo es (ver ADAPTACIONES_PEDIATRICAS,
  // "QUESOS — LA EXCEPCIÓN SE ESTRECHA"). Si el borrador usa el término
  // genérico, probablemente heredó la frase vieja de la FUENTE SRB tal cual.
  revisar(/queso\s+madurad[oa]|quesos?\s+envejecid[oa]s?/i, "usa \"queso madurado/envejecido\" genérico — la excepción ya es solo queso azul/roquefort");
  // "Ensalada" es, por definición, verdura cruda — con la regla nueva de
  // verduras (SIEMPRE rojo en crudo) no debería aparecer como recomendación en
  // un plan pediátrico. Encontrado en el plan real de Sofía (26 oct 2026,
  // corregido a mano por Leo porque se le había colado).
  revisar(/\bensalada\b/i, "menciona ensalada (verdura cruda — la regla nueva la pone en rojo)");
  // Reglas nuevas de la revisión en vivo del 28 oct 2026 (reunión de Leo con
  // Peter sobre un caso real, ver CHANGELOG).
  revisar(/\bdeber[íi]a\b/i, "usa \"debería\" (prohibida — debe ser \"debe\" o \"no requiere\"/\"no necesita\")");
  // "**texto**" (28 oct 2026, Leonardo: se ve como asteriscos literales en
  // el panel de edición del equipo, que muestra el texto plano sin
  // interpretar markdown) — usado en prácticamente todos los casos
  // generados hasta hoy, así que vale la pena verificarlo por código y no
  // solo confiar en la instrucción del prompt.
  revisar(/\*\*[^*]+\*\*/, "usa \"**negrilla**\" (markdown) en vez de MAYÚSCULAS — se ve como asteriscos literales en el panel de edición");
  // "o agua" como alternativa al suero/electrolitos se coló tres veces en el
  // mismo plan real (ritual de sueño, media tarde, después de la cena).
  revisar(/(?:suero|electrolitos)[^.\n]{0,30}\bo agua\b/i, "ofrece agua sola como alternativa al suero/electrolitos (prohibido — siempre agua CON electrolitos)");
  // "Hábitos recomendados" es el encabezado de la sección de tarjetas en
  // equipo/ y en la pestaña Hoy de app/ — nunca debería aparecer como texto
  // dentro del "mensaje" narrado al padre; si aparece, es la misma familia de
  // problema que el checklist numerado de abajo, con un encabezado en vez de
  // una lista.
  revisar(/h[áa]bitos recomendados/i, "el encabezado \"Hábitos recomendados\" no va en el mensaje narrado — esa sección ya se muestra aparte, como tarjetas");
  // La frase de escalamiento es rara y de alto cuidado (trastorno alimentario,
  // salud mental grave, algo médico agudo) — un caso real la usó para el
  // ritual de sueño, que no es ninguno de los tres. No se puede verificar por
  // código SI el trigger es legítimo (eso exige leer el formulario completo),
  // así que esta aparición siempre se marca para que el equipo la confirme a
  // mano antes de aprobar, no se asume que está mal ni que está bien.
  revisar(/el equipo (?:lo |la )?va a conversar (?:contigo|con ustedes) directamente/i, "usa la frase de escalamiento al equipo — confirmar a mano que el formulario sí reportó trastorno alimentario, salud mental grave o algo médico agudo (nunca para temas normales como horarios o rituales)");
  // La agenda (antes "cierre", ahora la sección que abre el mensaje — ver
  // "VA PRIMERO LA AGENDA" en SRB_DRAFT_PROMPT) repetida como checklist
  // numerado (28 oct 2026, encontrado comparando dos casos reales): el
  // prompt pide que sea la agenda por momento del día, en viñetas, igual que
  // el Bloque 1 — pero a veces el modelo la reemplaza por una lista numerada
  // que repite, uno por uno, los mismos títulos del array "habitos",
  // duplicando las tarjetas que ya se muestran aparte en la pestaña Hoy y en
  // el panel del equipo. Ninguna parte del formato pedido (agenda, Paso 0,
  // pilares, semáforo) usa "1.", "2." — esos van siempre en viñetas — así
  // que dos o más apariciones en todo el mensaje son, en la práctica,
  // siempre este mismo problema, no un falso positivo.
  const itemsNumerados = (parsed.mensaje || "").match(/(?:^|\n)\s*\d+\.\s/g) || [];
  if (itemsNumerados.length >= 2) {
    const ultimo = (parsed.mensaje || "").lastIndexOf(itemsNumerados[itemsNumerados.length - 1].trim());
    problemas.push("la agenda repite el checklist de hábitos como lista numerada en vez de la agenda por momento del día, en viñetas → \"" + (parsed.mensaje || "").slice(ultimo, ultimo + 70).trim() + "\"");
  }
  return problemas;
}

// Segunda capa: el código no puede ver si una afirmación clínica está
// inventada. Esta llamada le pasa al modelo la MISMA fuente SRB del prompt y el
// borrador, y le pide señalar lo que no tenga respaldo. Es ADVISORY — si
// encuentra algo, se anota para Peter pero no se descarta el borrador: un
// crítico equivocado no debe botar un plan bueno. Nace de que Peter encontró
// una dosis de sal y una sugerencia de magnesio y vitamina D que no existen en
// el SRB (reunión del 21 oct 2026).
async function revisarGroundingConModelo(parsed, env) {
  try {
    const borrador = (parsed.mensaje || "") + "\n\n" + (parsed.habitos || []).map(h => h.texto || "").join("\n");
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 900,
        system: "Eres un verificador. Recibes (A) el texto fuente del SRB, (B) las adaptaciones pediátricas que ANULAN la fuente donde esta habla para adultos, y (C) un borrador de plan. Tu única tarea es listar afirmaciones concretas del borrador que no estén respaldadas NI por la fuente NI por las adaptaciones: dosis, cantidades, frecuencias, cifras, duraciones o mecanismos clínicos que ninguna de las dos diga. REGLA CLAVE: si el borrador sigue una adaptación pediátrica en vez de la fuente, eso es CORRECTO y NO se reporta — por ejemplo 2 g de sal por litro en lugar de 5 a 7, o una ventana de alimentación de 12 horas o menos en lugar de 4 a 6. Ignora el estilo, el tono y la estructura. Ignora datos que vengan del formulario de la familia (horarios, nombres, lo que come, lo que el padre reportó). Si todo está respaldado, devuelve una lista vacía. Responde SOLO este JSON crudo, sin backticks: {\"sinRespaldo\":[\"afirmación 1\",\"afirmación 2\"]}",
        messages: [{ role: "user", content: "(A) FUENTE SRB:\n" + FUENTE_SRB_PEDIATRICA + "\n\n---\n\n(B) ADAPTACIONES PEDIÁTRICAS QUE ANULAN LA FUENTE:\n" + ADAPTACIONES_PEDIATRICAS + "\n\n---\n\n(C) BORRADOR A VERIFICAR:\n" + borrador }],
      }),
    });
    const data = await upstream.json();
    const t = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) return [];
    const r = JSON.parse(m[0]);
    return Array.isArray(r.sinRespaldo) ? r.sinRespaldo.slice(0, 6) : [];
  } catch (e) {
    return []; // si el verificador falla, no bloquea nada — el borrador sigue su camino
  }
}

// Núcleo compartido: genera + verifica + reintenta un borrador a partir de
// "dx" (el formulario capturado), sin guardar nada todavía. Extraído el 28
// oct 2026 (pedido de Leonardo: regenerar casos reales con el prompt ya
// corregido tras la revisión con Peter) para no duplicar esta lógica entre
// la generación automática normal (generarBorradorAutomatico, guarda por
// "ts") y la regeneración manual de un caso existente
// (regenerarBorradorExistente, guarda por "idPlan"). Devuelve
// { mensajeFinal, habitos } o null si no se pudo generar nada limpio. Nunca
// lanza — un fallo acá se trata igual que "no se pudo generar", nunca
// revienta al que la llama.
async function generarYVerificarBorrador(dx, env) {
  try {
    // Un solo prompt para todo formulario real desde el 27 oct 2026 (ver
    // comentario "SRB PEDIÁTRICO — PROMOVIDO A PRODUCCIÓN" junto a
    // SRB_DRAFT_PROMPT) — ya no depende de "producto" (por eso esta función
    // ya no lo recibe; handleLog sigue leyendo su propio "producto" del
    // body para decidir el enrutamiento por Durable Object, ver más abajo).
    //
    // max_tokens en 5000 (21 oct 2026): este prompt trae la fuente SRB
    // verbatim embebida y pide dos bloques (resumen cronológico + propuesta
    // con semáforo y pilares). Generando el caso real de Josef con 2500 se
    // truncaba y el JSON no parseaba, y como esta función falla en silencio
    // (ver abajo) la fila se quedaba sin borrador y nadie se enteraba.

    // "correcciones" se usa en el reintento: se le dice al modelo qué estuvo
    // mal en su intento anterior, en vez de pedirle lo mismo y esperar suerte.
    const pedirBorrador = async (correcciones) => {
      console.log("[generarYVerificarBorrador] llamando a Claude" + (correcciones && correcciones.length ? " (reintento, " + correcciones.length + " correcciones)" : " (primer intento)") + ", ANTHROPIC_API_KEY presente: " + !!env.ANTHROPIC_API_KEY);
      const upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          // REVERTIDO a claude-sonnet-4-6 (2 oct 2026) — el intento de subir a
          // claude-sonnet-5 (16 sept 2026) causaba fallas silenciosas reales:
          // gastaba parte del límite de tokens "pensando" antes de escribir, la
          // respuesta salía cortada, el JSON se rompía y la fila quedaba
          // huérfana sin que nadie se enterara (encontrado con el caso de
          // Samuel). Decisión de Leonardo: no asumir ese riesgo todavía.
          //
          // max_tokens subido de 5000 a 7000 (27 oct 2026, Leonardo detectó el
          // mismo fallo que el comentario de arriba describe para sonnet-5,
          // esta vez con sonnet-4-6: dos intentos consecutivos de regenerar el
          // caso de Sofía cortados por "stop_reason: max_tokens" después de
          // 3700+ tokens de puro razonamiento en inglés antes del JSON, cero
          // borradores guardados). No es solo un problema de sonnet-5 — el
          // margen de tokens importa igual. El fix principal es la regla
          // "PROHIBIDO ESCRIBIR NADA ANTES DEL JSON" al inicio de
          // SRB_DRAFT_PROMPT; este margen más ancho es la red de seguridad
          // para cuando esa regla no baste.
          model: "claude-sonnet-4-6",
          max_tokens: 7000,
          system: SRB_DRAFT_PROMPT,
          messages: [{ role: "user", content: "Formulario capturado (JSON):\n" + JSON.stringify(dx) +
            ((correcciones && correcciones.length)
              ? "\n\nTu intento anterior tuvo estos problemas. Vuelve a escribir el plan completo sin ellos:\n- " + correcciones.join("\n- ")
              : "") }],
        }),
      });

      console.log("[generarYVerificarBorrador] respuesta de Claude: HTTP " + upstream.status);
      const data = await upstream.json();
      if (data.error) console.log("[generarYVerificarBorrador] Claude devolvió error: " + JSON.stringify(data.error));
      const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
      console.log("[generarYVerificarBorrador] stop_reason: " + data.stop_reason + ", texto recibido: " + text.length + " caracteres");

      let parsed = null;
      try { parsed = JSON.parse(text); }
      catch (e) {
        const m = text.match(/\{[\s\S]*\}/); // por si el modelo mete texto extra alrededor
        if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) {} }
      }
      console.log("[generarYVerificarBorrador] JSON parseado: " + !!parsed + ", trae mensaje: " + !!(parsed && parsed.mensaje));
      return parsed && parsed.mensaje ? parsed : null;
    };

    let parsed = await pedirBorrador();

    // REVISIÓN ANTES DE GUARDAR (21 oct 2026, pedido de Leonardo): el
    // borrador no llega al panel sin pasar por acá. Dos capas —
    //   (a) reglas duras por código: palabras prohibidas, reglas narradas al
    //       padre, formato interno filtrado, cifras de adulto, ventana corta.
    //       Si algo falla, se regenera hasta 2 veces más diciéndole qué
    //       corregir (ver MAX_INTENTOS abajo).
    //   (b) verificador de grounding contra la fuente SRB: es advisory, se
    //       anota en el log del Worker pero nunca descarta el borrador.
    // Lo que sobreviva con problemas después de los 3 intentos se guarda
    // igual — mejor un borrador marcado en el log que ningún caso — pero sin
    // avisarlo en el texto que ve el equipo (29 oct 2026, Leonardo: nada de
    // mensajes de advertencia antes de aprobar).
    const evaluar = (p) => {
      if (!p) return [];
      const fallos = revisarBorradorPediatrico(p);
      // horasDeVentana devuelve null cuando NO HAY DATO (el formulario no
      // traía horas y el prompt manda "00:00" para decirlo). Eso no es un
      // error: el propio texto le explica al padre qué hora falta.
      const h = horasDeVentana(p.ventanaPropuesta);
      if (h !== null && h > MAX_VENTANA_HORAS) {
        const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
        fallos.push("la ventana propuesta queda en " + hh + "h" + String(mm).padStart(2, "0") +
          " (de " + p.ventanaPropuesta.primeraComida + " a " + p.ventanaPropuesta.ultimaComida +
          "), por encima del máximo de " + MAX_VENTANA_HORAS + " horas para niños");
      }
      // Regla nueva (26 oct 2026): mínimo 3 horas entre la última comida y
      // la hora de dormir — independiente de la ventana de arriba. Igual
      // que horasDeVentana, null = sin dato (no se reporta como fallo, el
      // propio texto ya le dice al padre qué falta).
      const hd = horasAntesDeDormir(p.ventanaPropuesta, p.horaDormir);
      if (hd !== null && hd < MIN_HORAS_CENA_DORMIR) {
        const hh = Math.floor(hd), mm = Math.round((hd - hh) * 60);
        fallos.push("quedan " + hh + "h" + String(mm).padStart(2, "0") + " entre la última comida (" +
          p.ventanaPropuesta.ultimaComida + ") y la hora de dormir (" + p.horaDormir +
          "), por debajo del mínimo de " + MIN_HORAS_CENA_DORMIR + " horas");
      }
      return fallos;
    };

    // Reintentos hasta que quede limpio, no solo uno (29 oct 2026, Leonardo:
    // "si se detectó, de una vez corregirlo" — antes se rendía después de UN
    // reintento y dejaba la alarma [REVISIÓN AUTOMÁTICA] para que el equipo
    // corrigiera a mano algo que el propio sistema ya sabía que estaba mal).
    // Máximo 3 intentos en total (1 inicial + 2 reintentos) — cada intento es
    // una llamada real a Claude, así que no se alarga sin límite; si después
    // de los 3 sigue con fallos, ahí sí se guarda marcado para revisión
    // manual, igual que antes — mejor un borrador marcado que ningún caso.
    let fallos = evaluar(parsed);
    const MAX_INTENTOS = 3;
    for (let intento = 1; (!parsed || fallos.length > 0) && intento < MAX_INTENTOS; intento++) {
      const reintento = await pedirBorrador(fallos);
      const fallosReintento = evaluar(reintento);
      // Se queda con el reintento si no produjo nada el anterior, o si salió
      // igual o mejor. Nunca se empeora a propósito.
      if (reintento && (!parsed || fallosReintento.length <= fallos.length)) {
        parsed = reintento;
        fallos = fallosReintento;
      }
    }

    if (parsed) {
      const sinRespaldo = await revisarGroundingConModelo(parsed, env);
      for (const s of sinRespaldo) fallos.push("posible afirmación sin respaldo en el SRB: " + s);
      // SIN banner "[REVISIÓN AUTOMÁTICA]" en el mensaje (29 oct 2026,
      // Leonardo: "para qué queremos que eso salga... toda la app
      // minimalista y conciso, no añadas mensajes informativos o de
      // advertencia antes de aprobarlos"). Antes de esto, se rendía después
      // de UN reintento y dejaba el aviso ahí para que el equipo corrigiera
      // a mano — ahora hay hasta 3 intentos (ver MAX_INTENTOS arriba), así
      // que hace mucha menos falta. Lo que sí sobreviva después de los 3
      // intentos queda solo en el log del Worker (console.log abajo), nunca
      // en el texto que ve el equipo.
      if (fallos.length > 0) {
        console.log("[generarYVerificarBorrador] quedaron " + fallos.length + " fallo(s) después de " + MAX_INTENTOS + " intentos: " + fallos.join(" | "));
      }
    }

    if (!parsed) return null; // no se pudo generar limpio — se queda "pendiente"

    // El prompt devuelve el plan en dos bloques (resumen cronológico actual +
    // propuesta). El panel tiene una sola ventana de texto, así que se
    // concatenan en orden, separados por una línea divisoria.
    let mensajeFinal = parsed.mensaje;
    if (parsed.resumenCronologico) {
      mensajeFinal = parsed.resumenCronologico + "\n\n" + "═".repeat(40) + "\n\n" + parsed.mensaje;
    }

    return { mensajeFinal, habitos: Array.isArray(parsed.habitos) ? parsed.habitos : [] };
  } catch (e) {
    // Silencioso a propósito: un fallo acá no debe tumbar al que llama.
    // Queda "pendiente" (o, en regeneración, se queda con el contenido
    // anterior sin tocar).
    return null;
  }
}

// Genera el borrador automáticamente (Claude + Prompt Maestro embebido) y lo
// guarda solo, vía la misma acción "guardar_borrador" del Apps Script. Corre
// en segundo plano (ctx.waitUntil) — si falla por lo que sea, no revienta
// nada: la fila simplemente se queda en "pendiente" para revisión manual,
// igual que se comportaba el sistema antes de esta automatización.
async function generarBorradorAutomatico(dx, ts, env) {
  if (!env.SHEET_WEBHOOK_URL_FORMULARIO) return;
  const resultado = await generarYVerificarBorrador(dx, env);
  if (!resultado) return;
  try {
    await fetch(env.SHEET_WEBHOOK_URL_FORMULARIO, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: env.SHEET_WEBHOOK_SECRET_FORMULARIO || "",
        action: "guardar_borrador",
        ts,
        mensaje: resultado.mensajeFinal,
        plan: { habitos: resultado.habitos },
      }),
    });
  } catch (e) {
    // Silencioso a propósito: un fallo aquí no debe afectar al padre (ya
    // recibió su confirmación) ni tumbar el Worker. Queda "pendiente".
  }
}

// Regenera el borrador de un caso que YA EXISTE (idPlan conocido) con el
// prompt vigente — pedido de Leonardo el 28 oct 2026, tras corregir el
// prompt en una revisión con Peter, para que casos reales ya generados con
// la versión vieja reflejen las correcciones. A diferencia de
// generarBorradorAutomatico(), guarda vía "regenerar_borrador" (por idPlan,
// no por ts) — ver esa acción en Apps Script: SIEMPRE pisa el contenido
// existente y vuelve decision a "pendiente_aprobacion", nunca lo deja
// "aprobado" en silencio (HITL obligatorio, regla dura del proyecto — el
// contenido nuevo necesita que Peter lo revise otra vez antes de llegar a la
// familia, así el caso ya hubiera estado aprobado antes). Se dispara desde
// /panel/regenerar, por el mismo Durable Object que la generación normal
// (toma ~70s, no cabe en ctx.waitUntil).
async function regenerarBorradorExistente(idPlan, dx, env) {
  console.log("[regenerarBorradorExistente] arrancando para idPlan=" + idPlan);
  if (!env.SHEET_WEBHOOK_URL_FORMULARIO) { console.log("[regenerarBorradorExistente] SHEET_WEBHOOK_URL_FORMULARIO no configurado, abortando"); return; }
  // Huella de regeneración (28 oct 2026, pedido de Leonardo — "para saber si
  // se hizo"): a diferencia de generarBorradorAutomatico (que puede fallar
  // en silencio porque el caso simplemente se queda "pendiente", visible por
  // su propia ausencia en el panel), un caso que YA existe no muestra ningún
  // cambio visible si la regeneración falla — por eso CADA salida de esta
  // función, incluida la de generación fallida, deja marcada la hora y el
  // motivo en regeneracion_estado. "ok <iso>" lo escribe regenerarBorrador()
  // en Apps Script como parte de su propio guardado exitoso.
  const marcar = async (estado) => {
    try {
      await fetch(env.SHEET_WEBHOOK_URL_FORMULARIO, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: env.SHEET_WEBHOOK_SECRET_FORMULARIO || "", action: "marcar_regeneracion", idPlan, estado }),
      });
    } catch (e) { /* best-effort: si ni esto se puede escribir, no hay más que intentar */ }
  };
  try {
    const resultado = await generarYVerificarBorrador(dx, env);
    console.log("[regenerarBorradorExistente] generarYVerificarBorrador devolvió: " + (resultado ? "contenido (" + resultado.mensajeFinal.length + " caracteres)" : "null"));
    if (!resultado) {
      await marcar("error " + new Date().toISOString() + ": no se pudo generar un borrador limpio (ver logs del Worker)");
      return;
    }
    const sheetRes = await fetch(env.SHEET_WEBHOOK_URL_FORMULARIO, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: env.SHEET_WEBHOOK_SECRET_FORMULARIO || "",
        action: "regenerar_borrador",
        idPlan,
        mensaje: resultado.mensajeFinal,
        plan: { habitos: resultado.habitos },
      }),
    });
    const sheetData = await sheetRes.json().catch(() => null);
    console.log("[regenerarBorradorExistente] guardado en Sheet: " + JSON.stringify(sheetData));
    if (!sheetData || sheetData.ok !== true) {
      await marcar("error " + new Date().toISOString() + ": " + ((sheetData && sheetData.error) || ("HTTP " + sheetRes.status) || "respuesta inválida de Apps Script"));
    }
  } catch (e) {
    console.log("[regenerarBorradorExistente] excepción: " + String(e));
    await marcar("error " + new Date().toISOString() + ": " + String(e).slice(0, 200));
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

// Guarda uno o más mensajes del chat de seguimiento (27 oct 2026, pedido de
// Leonardo) — ver guardar_mensaje_chat en Apps Script. Mismo patrón que
// handleEscalar justo arriba: reenvía al mismo webhook con el mismo
// SHEET_WEBHOOK_SECRET_FORMULARIO, nunca PANEL_SECRET.
async function handleGuardarChat(request, env, cors) {
  const jsonHeaders = { ...cors, "Content-Type": "application/json" };
  try {
    const body = await request.json();
    const { idPlan, mensajes } = body || {};

    if (!env.SHEET_WEBHOOK_URL_FORMULARIO) {
      return new Response(JSON.stringify({ ok: false, error: "SHEET_WEBHOOK_URL_FORMULARIO no configurado" }), { status: 500, headers: jsonHeaders });
    }

    const sheetRes = await fetch(env.SHEET_WEBHOOK_URL_FORMULARIO, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: env.SHEET_WEBHOOK_SECRET_FORMULARIO || "",
        action: "guardar_mensaje_chat",
        idPlan: idPlan || "",
        mensajes: Array.isArray(mensajes) ? mensajes : [],
      }),
    });

    const sheetText = await sheetRes.text();
    let sheetData = null;
    try { sheetData = JSON.parse(sheetText); } catch (e) {}

    if (!sheetRes.ok || !sheetData || sheetData.ok !== true) {
      return new Response(JSON.stringify({ ok: false, error: "no se pudo guardar" }), { status: 502, headers: jsonHeaders });
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
// Regenera el borrador de un caso existente con el prompt vigente (28 oct
// 2026, pedido de Leonardo tras corregir el prompt en una revisión con
// Peter) — botón "Regenerar" en equipo/. A diferencia de las rutas de panel
// de arriba, NO es un passthrough simple: valida el panelSecret reusando
// "detalle_plan" (la misma acción que equipo/ ya usa para abrir un caso) en
// vez de duplicar la verificación de PANEL_SECRET acá, reconstruye "dx" a
// partir de esa respuesta, y encola la regeneración en el mismo Durable
// Object que la generación automática — toma ~70s, no cabe en la respuesta
// HTTP. Responde de inmediato con "encolado:true"; el resultado aparece en
// el Sheet un minuto después, con decision vuelto a "pendiente_aprobacion"
// (ver regenerarBorradorExistente) para que el equipo lo revise de nuevo
// antes de que llegue a la familia.
async function handleRegenerar(request, env, cors) {
  const jsonHeaders = { ...cors, "Content-Type": "application/json" };
  try {
    const body = await request.json();
    const { panelSecret, idPlan } = body || {};
    if (!idPlan) {
      return new Response(JSON.stringify({ ok: false, error: "idPlan faltante" }), { status: 400, headers: jsonHeaders });
    }
    if (!env.SHEET_WEBHOOK_URL_FORMULARIO) {
      return new Response(JSON.stringify({ ok: false, error: "SHEET_WEBHOOK_URL_FORMULARIO no configurado" }), { status: 500, headers: jsonHeaders });
    }

    const detalleRes = await fetch(env.SHEET_WEBHOOK_URL_FORMULARIO, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "detalle_plan", panelSecret, idPlan }),
    });
    const detalleText = await detalleRes.text();
    let detalle;
    try { detalle = JSON.parse(detalleText); } catch (e) { detalle = { ok: false, error: "respuesta inválida de Apps Script" }; }
    if (detalle.ok !== true) {
      const status = detalle.unauthorized ? 401 : 404;
      return new Response(JSON.stringify(detalle), { status, headers: jsonHeaders });
    }

    // dx con los mismos nombres de campo que espera el prompt (ver registro
    // inicial en Apps Script, doPost) — detalle_plan los devuelve en
    // camelCase, acá vuelven a snake_case.
    const dx = {
      nombre_nino: detalle.nombreNino || "", edad: detalle.edad || "",
      que_deseas_lograr: detalle.queDeseaLograr || "", preocupacion_principal: detalle.preocupacionPrincipal || "",
      origen: detalle.origen || "", sueno_y_movimiento: detalle.suenoYMovimiento || "",
      senales_observables: detalle.senalesObservables || "", diagnosticos_y_atencion_medica: detalle.diagnosticosYAtencionMedica || "",
      cronologia_del_dia: detalle.cronologiaDelDia || "", finde_y_gustos: detalle.findeYGustos || "",
      mente_y_pantallas: detalle.menteYPantallas || "", emociones: detalle.emociones || "",
      nombre_padre: detalle.nombrePadre || "", email_padre: detalle.emailPadre || "",
    };

    if (!env.GENERADOR_BORRADORES) {
      return new Response(JSON.stringify({ ok: false, error: "GENERADOR_BORRADORES no disponible" }), { status: 500, headers: jsonHeaders });
    }

    // Huella de regeneración, parte 1 (28 oct 2026, pedido de Leonardo):
    // marca "iniciado" ANTES de encolar — si esto nunca cambia a "ok" o
    // "error", el problema está en el encolado o en la alarma del Durable
    // Object, no en la generación. Best-effort, nunca bloquea el encolado
    // real: si el marcado falla, igual se sigue.
    try {
      await fetch(env.SHEET_WEBHOOK_URL_FORMULARIO, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: env.SHEET_WEBHOOK_SECRET_FORMULARIO || "", action: "marcar_regeneracion", idPlan, estado: "iniciado " + new Date().toISOString() }),
      });
    } catch (e) { /* best-effort */ }

    const id = env.GENERADOR_BORRADORES.idFromName("regenerar-" + idPlan);
    const stub = env.GENERADOR_BORRADORES.get(id);
    await stub.fetch("https://generador/encolar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modo: "regenerar", idPlan, dx }),
    });

    return new Response(JSON.stringify({ ok: true, encolado: true }), { status: 200, headers: jsonHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: jsonHeaders });
  }
}

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

    // NUEVO (14 ago 2026): antes esto comparaba sheetData.error contra el
    // texto exacto "panelSecret inválido" — funcionaba para el panel de
    // Peter, pero cualquier acción nueva con SU PROPIO secreto (ej.
    // resumen_colegio, con "panelColegioSecret inválido") caía siempre en
    // 400 genérico, aunque la causa real fuera credencial inválida. Apps
    // Script no puede mandar un status HTTP real (ContentService siempre
    // responde 200), así que necesita decírselo al Worker de otra forma —
    // ahora vía el campo estructurado "unauthorized:true" en el cuerpo, que
    // cualquier acción protegida por secreto puede reusar sin que el Worker
    // tenga que conocer el texto exacto de cada mensaje de error.
    const status = sheetData.ok === false ? (sheetData.unauthorized ? 401 : 400) : 200;
    return new Response(JSON.stringify(sheetData), { status, headers: jsonHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: jsonHeaders });
  }
}

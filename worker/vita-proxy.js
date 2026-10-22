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
    await generarBorradorAutomatico(trabajo.dx, trabajo.ts, this.env, trabajo.producto);
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
    // enlace de prueba aparte para el SRB pediátrico nuevo (ver comentario
    // junto a SRB_DRAFT_PROMPT_PEDIATRICO_V2 más abajo). Mismo Sheet y mismo
    // schema que "formulario" — solo cambia qué prompt usa
    // generarBorradorAutomatico, nunca el camino de producción real.
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
    // Hay DOS caminos, y la diferencia es el límite de tiempo (21 oct 2026):
    // ctx.waitUntil() se cancela ~30s después de que el Worker responde. El
    // prompt de producción genera en ~23s y cabe; el pediátrico v4 tarda ~70s
    // y NO cabe — medido. Por eso el pediátrico se delega a un Durable Object
    // con alarma, que no tiene ese tope. Encontrado probando el enlace de
    // validación en producción: la fila se escribía en el Sheet pero el
    // borrador nunca se guardaba, y como esto falla en silencio por diseño,
    // el caso quedaba invisible en el panel de Peter para siempre. Explica por
    // qué todos los borradores pediátricos hasta ahora se generaron a mano.
    if (esFormulario) {
      if (producto === "formulario_pediatrico_v2" && env.GENERADOR_BORRADORES) {
        try {
          const id = env.GENERADOR_BORRADORES.idFromName(tsFinal);
          const stub = env.GENERADOR_BORRADORES.get(id);
          await stub.fetch("https://generador/encolar", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dx, ts: tsFinal, producto }),
          });
        } catch (e) {
          // Si el Durable Object falla, se intenta por el camino viejo — puede
          // que no alcance a terminar, pero es mejor que no intentarlo.
          if (ctx && typeof ctx.waitUntil === "function") {
            ctx.waitUntil(generarBorradorAutomatico(dx, tsFinal, env, producto));
          }
        }
      } else if (ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(generarBorradorAutomatico(dx, tsFinal, env, producto));
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
// PROMPT MAESTRO embebido — versión condensada de
// design-sprint/src/prompts/srb_draft_generator.txt (repo del sprint),
// adaptada para responder JSON estricto (no texto libre con "Parte A/B"),
// para poder guardarse sola sin intervención humana. Si algún día se edita
// el Prompt Maestro del sprint, replicar el cambio aquí también.
//
// TRAZABILIDAD (2 oct 2026, pedido de Leonardo en vivo con Peter) — desde que
// este prompt vive embebido aquí, se ha seguido ajustando DIRECTO en este
// archivo sin reflejar los cambios de vuelta en el repo de documentación del
// sprint (design-sprint/docs/reglas_duras_srb.md, el SRB clínico firmado por
// Peter el 28 jul 2026). SRB_PROMPT_VERSION de abajo registra cada cambio, y
// marca cuáles son contenido CLÍNICO (requieren una versión nueva del SRB
// documentado, con firma de Peter) vs. cuáles son solo voz/comunicación (no
// cambian qué se permite o prohíbe, no requieren SRB nuevo):
//   v1.0 · 31 jul 2026            · origen: srb_draft_generator.txt v1
//                                    (carve-out pediátrico firmado 28 jul).
//   v1.1 · 16 sept 2026 · PR #71  · ESPECIFICIDAD (pedido de Peter) — voz/
//                                    comunicación, NO clínico.
//   v1.2 · 16 sept 2026 · PR #73  · lonchera comprada en el colegio (pedido
//                                    de Peter) — ⚠ SÍ ES CLÍNICO, pendiente
//                                    de ratificar formalmente en
//                                    reglas_duras_srb.md (ver addendum ahí).
//   v1.3 · 2 oct 2026   · PR #78  · idioma latinoamericano estándar +
//                                    concisión (pedido de Peter en vivo) —
//                                    voz/comunicación, NO clínico.
//   v1.4 · 2 oct 2026   · PR #81  · quita el tope de 20 años (pedido de
//                                    Peter y Leonardo en vivo) — ⚠ SÍ ES
//                                    CLÍNICO, pendiente de ratificar
//                                    formalmente en reglas_duras_srb.md (ver
//                                    addendum ahí). Un tope fijo excluía
//                                    estudiantes reales de colegio público en
//                                    extraedad/CLEI (Colombia permite seguir
//                                    matriculado bien entrados los 20).
// Al generar un borrador, esta versión queda disponible para quien llame al
// Worker (ver generarBorradorAutomatico) — no se persiste todavía por caso
// individual en el Sheet (requeriría una columna nueva + cambio en Apps
// Script, pendiente de que Leonardo lo despliegue a mano).
// ============================================================
const SRB_PROMPT_VERSION = "1.4";
const SRB_DRAFT_PROMPT = `Eres el generador de borradores de plan de hábitos de be360, a partir del
Formulario de Hábitos que llenó un padre/madre sobre su hijo/a (2 años en adelante, sin límite
superior). Tu borrador NO
llega directo a la familia — lo revisa Peter Álvarez (autoridad clínica) antes de aprobarlo.

FUENTE ÚNICA — reglas duras, nunca las cruces:
- IDIOMA (2 oct 2026, pedido de Peter en vivo — nunca español rioplatense/argentino): escribe
  SIEMPRE en español latinoamericano estándar, con tuteo neutro ("tú cuentas", "tú puedes",
  "empecemos"). PROHIBIDO el voseo argentino/uruguayo ("vos contás", "vos querés", "fijate",
  "tenés") y cualquier otro modismo marcadamente regional (che, boludo, pibe, vale como muletilla
  española, etc.). Si dudas entre dos formas, usa la más neutra posible para toda Latinoamérica.
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

ESPECIFICIDAD (16 sept 2026, pedido de Peter — "las recomendaciones salen muy genéricas") — cada
hábito debe ser tuyo para ESTE niño/a, no un hábito genérico de SRB que serviría para cualquiera:
- Cada "texto" de hábito debe citar o parafrasear el dato concreto del formulario que lo motiva
  (ej. "porque cuentas que cena como a las 8:30 y se acuesta a las 9" — nunca "es importante cenar
  temprano" a secas). Si no puedes anclar un hábito a un dato específico capturado, no lo incluyas.
- Si "cronologia_del_dia" trae horas concretas, conviértelas en la instrucción: proponé una hora
  objetivo específica de cambio (ej. "prueben moverla a las 6:45"), nunca una frase vaga como "más
  temprano" o "reducir un poco". Si un momento viene marcado "[Sin dato, sin hora exacta, o no
  compartido aún: ...]", NO inventes una hora para ese momento — trabaja solo con lo reportado.
- Prohibido el lenguaje de relleno que podría aplicar a cualquier niño/a sin cambiar una palabra
  ("es importante comer sano", "cada niño es diferente", "poco a poco se logra"). Si una frase del
  borrador serviría igual para otro niño/a con datos distintos, reescríbela o bórrala.

MEDIA MAÑANA/LONCHERA COMPRADA EN EL COLEGIO (16 sept 2026, pedido de Peter — la merienda es el
punto de menor control de la familia, a diferencia del desayuno o la cena en casa): si el
formulario indica que la lonchera se compra en el colegio (cafetería/casino/tienda escolar) en vez
de llevarse de casa, NO propongas un hábito que asuma que la familia elige directamente qué come
el niño/a en ese momento. En su lugar: (a) si es viable, sugiere enviar lonchera de casa como la
alternativa concreta; o (b) si el padre ya contó qué suele vender/comprar el colegio, sugiere cuál
de esas opciones ya disponibles es la menos mala, nunca una alternativa ideal que no existe ahí.

Nivel de especificidad esperado (ejemplo de referencia, no copies el contenido — solo el nivel de
detalle y el anclaje a un dato reportado):
- Evitar (genérico): "Reduce el trigo poco a poco y trata de que duerma mejor."
- Buscar (específico): "Contaste que desayuna pan casi todos los días — empecemos cambiándolo por
  arepa o yuca 3 veces por semana, dejando el pan para el fin de semana."

TONO del mensaje (voz de Vita, estilo WhatsApp): tuteo, cero emojis, cálido, sin culpa, dirigido
SIEMPRE al padre/madre (nunca al niño/a). CONCISO — ve al grano (pedido de Peter en vivo, 2 oct
2026): la intro + contexto no debe pasar de 2-3 frases cortas antes de "TE DEJO EL MAPA", y cada
hábito en el campo "texto" va directo al punto accionable (1 frase corta, 2 como máximo) — nada de
rodeos, nada de reafirmar dos veces la misma idea. Abre reconociendo algo que ya hacen bien, en una
sola frase. Cierra invitando a elegir por dónde empezar — nunca lo presentes como orden fija. Nunca menciones IA,
tecnología, "ayuno", "dieta" ni imagen corporal.

Recibirás el formulario capturado en JSON. RESPONDE ÚNICAMENTE con este JSON — sin texto antes ni
después, sin bloque de código markdown, sin explicación:
{"mensaje":"<el mensaje completo dirigido al padre: intro cálida + 2-3 frases de contexto + 'TE
DEJO EL MAPA' + los mismos hábitos enumerados dentro del texto + cierre invitando a elegir>",
"habitos":[{"titulo":"<3 a 5 palabras>","texto":"<1 a 2 frases, accionable, en el mismo tono>"}]}
Entre 2 y 4 objetos en "habitos". El campo "mensaje" y la lista "habitos" deben ser consistentes
entre sí — son la misma información en dos formatos (uno para el texto corrido, otro para mostrar
como checklist en una página aparte).`;

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
const ADAPTACIONES_PEDIATRICAS = `ADAPTACIONES PEDIÁTRICAS OBLIGATORIAS — estas reglas GANAN SIEMPRE sobre el texto de la fuente de
arriba cuando hay conflicto (el texto de arriba fue escrito para adultos):
- Suero casero: SIEMPRE empieza en 2 g de sal por litro (nunca los 5-7g que dice la fuente para
  adultos).
- PROHIBIDO cualquier meta numérica de carbohidratos/día o de insulina en ayunas (la fuente da
  70-100g/día y un objetivo de 2.5 unidades — eso NUNCA se menciona a una familia con un niño/a).
  Si el Paso 0 menciona insulina en ayunas, es SOLO como "si tienes un examen reciente, compártelo;
  si no, puedes preguntarle a tu pediatra" — nunca un número objetivo.
- PROHIBIDO cualquier porcentaje de macronutrientes (la fuente dice "60-80% proteína animal" —
  eso no se menciona; en cambio, "prioriza proteína de calidad en cada comida", sin número).
- PROHIBIDO el Pilar 4 de la fuente (ayuno intermitente 12-24h) completo. En su lugar: "ventana de
  alimentación" — el tiempo entre primera y última comida, que en niños NUNCA debe bajar de 12
  horas.
- PALABRAS PROHIBIDAS, aunque aparezcan en la FUENTE: "ayuno", "ayunar", "ayuno nocturno",
  "autofagia". La fuente las usa porque fue escrita para adultos — tú NO las reproduces, ni
  citando, ni entre comillas, ni explicando que el SRB las usa. En particular, la frase de la
  fuente "el ayuno nocturno no es opcional" NUNCA se escribe: lo que se dice en su lugar es que
  cerrar la alimentación temprano le da al cuerpo la noche para recuperarse. Esto ya se coló en un
  plan real (21 oct 2026) — el texto literal de la fuente le ganó a esta regla, así que acá queda
  explícito: cuando la fuente y estas adaptaciones se contradigan, mandan SIEMPRE las adaptaciones.
- PROHIBIDO el Pilar 5 de la fuente (fuerza estructurada, 7 min de ejercicios, sentadillas/push-ups)
  — decisión temporal de Peter. El movimiento se trata como juego/actividad que ya disfruta el
  niño/a, nunca como rutina de ejercicios con minutos o repeticiones.
- PROHIBIDOS los "6 pasos para restaurar la microbiota" de la fuente (levadura de cerveza cruda,
  vinagre de manzana en ayunas, queso azul obligatorio) — son protocolos de adulto, no aplican aquí.
- PROHIBIDO mencionar o aplicar nada de las secciones de BioEmoción, biodescodificación o fase
  prodrómica — no están en el fragmento de fuente que recibiste, y aunque las conocieras, quedan
  fuera del plan inicial por decisión de Peter.`;

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
// SRB PEDIÁTRICO v4 — EXPERIMENTAL, NO APROBADO AÚN COMO SRB DE PRODUCCIÓN.
// Es, sin embargo, el prompt que genera los borradores del enlace de
// validación (vita-demo-formulario-v2/) que Peter está usando para revisar
// casos reales — o sea: lo que ven las familias que entran por ese enlace.
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
//
// SOLO se usa cuando producto === "formulario_pediatrico_v2" — el camino de
// producción normal sigue intacto con SRB_DRAFT_PROMPT. Cuando Peter lo
// apruebe formalmente, esto se vuelve el SRB_DRAFT_PROMPT real.
// ============================================================
const SRB_DRAFT_PROMPT_PEDIATRICO_V2 = `Eres el generador de planes pediátricos de be360, bajo el Sistema de Reversión Biológica (SRB) de
Peter Álvarez. Tu borrador NO llega directo a la familia — lo revisa Peter Álvarez antes de aprobarlo.

REGLA MÁS IMPORTANTE DE TODAS (encontrada en revisión en vivo, 21 oct 2026 — Peter encontró
afirmaciones inventadas que no están en el SRB): CADA afirmación que hagas tiene que poder
rastrearse a algo EXPLÍCITAMENTE dicho en la FUENTE SRB de abajo. Si algo no está ahí — aunque
suene plausible, aunque sea conocimiento nutricional razonable — NO LO DIGAS. No completes huecos
con tu propio conocimiento general de nutrición/salud. Prefiere decir menos y que sea 100% fiel a
la fuente, a decir más y que sea una invención. Esta regla pisa a cualquier otra instrucción.

================================================================
FUENTE SRB (texto original de Peter Álvarez — cita o parafrasea SOLO esto)
================================================================
${FUENTE_SRB_PEDIATRICA}
================================================================
FIN DE LA FUENTE SRB
================================================================

${ADAPTACIONES_PEDIATRICAS}

REGLA DE SILENCIO SOBRE MEDICAMENTOS Y REMEDIOS (encontrada en revisión en vivo, 21 oct 2026): si
el formulario menciona que el niño/a usa o depende de algo que alguien le recetó, recomendó o que
el padre decidió dar por su cuenta — un medicamento, una pomada, un suplemento, cualquier producto
(ej. "quiere Vick VapoRub para dormir") — NO LO MENCIONES EN ABSOLUTO en el plan. Ni para
recomendar que lo deje, ni para decir que está bien que lo siga usando, ni para insinuar que con
los hábitos nuevos "ya no lo va a necesitar". Simplemente no existe para efectos de este plan —
quien se lo recomendó es la persona indicada para decidir sobre eso, no nosotros.

TONO — PROHIBIDO CELEBRAR O REFORZAR LO QUE YA ESTÁ BIEN (encontrado en revisión en vivo, 21 oct
2026): nunca escribas frases como "esto es excelente", "ya tienes una base sólida", "sigue así",
"qué bueno que...". El plan dice SOLO lo que debe cambiar y cómo — no evalúa ni felicita lo que ya
funciona. Si algo no necesita cambiar, simplemente no se menciona. Evita también contradicciones
obvias (ej. nunca digas que algo "es excelente" en una frase y en la siguiente le agregues una
corrección — si hay corrección, no hubo elogio).

ESTRUCTURA DE CADA RECOMENDACIÓN (encontrado en revisión en vivo — así lo hace Peter): explicación
breve (1-2 frases, causa → consecuencia, anclada a la FUENTE SRB) + instrucción concreta. Nada de
adornos, nada de persuadir, nada de "introducción" larga antes de llegar al punto. Ve al grano.

IDIOMA Y NIVEL: español latinoamericano claro, nivel adolescente/familiar — el mínimo común
denominador entendible, nunca enredado ni con jerga clínica cruda sin traducir (nunca "edema
celular", di "retención de líquido en las células"; nunca "aislante eléctrico" sin explicarlo en
términos cotidianos). Prohibido el voseo.

OTRAS REGLAS DURAS, siempre:
- PESO: nunca es un objetivo salvo que el padre lo plantee explícitamente o venga de un diagnóstico
  médico ya recibido. Nunca "dieta" ni imagen corporal.
- Si el formulario reporta un diagnóstico médico activo: los hábitos NUNCA se presentan como algo
  que trata o reemplaza ese seguimiento médico — se enmarcan como apoyo general, nunca como
  intervención sobre la condición médica reportada.
- Si el formulario muestra señales de posible trastorno de conducta alimentaria, salud mental grave
  o algo médico agudo: ese hábito dice que el equipo lo va a conversar directamente, sin detalle.
- Nunca inventes nada fuera de lo capturado en el formulario ni fuera de la FUENTE SRB de arriba.

PASO 0 — INDICADORES: SOLO consultivo, nunca mediciones en casa (nada de % de grasa corporal,
tirillas de pH en orina, básculas). Máximo 2 preguntas para la PRÓXIMA CITA con el pediatra —
"si ya tienes un examen reciente de X, compártelo; si no, puedes preguntarle a tu pediatra si vale
la pena". Si el formulario no da pie a ningún indicador que esté genuinamente en la FUENTE SRB,
omite el Paso 0 por completo — no inventes uno para rellenar.

ESTRUCTURA FIJA DEL PLAN, EN DOS BLOQUES:

BLOQUE 1 — RESUMEN CRONOLÓGICO ACTUAL (sintetizado, NO prosa — viñetas por hora, tal como lo
reportó el padre, sin opinar):
- Una viñeta por momento del día con su hora aproximada.
- Cierra con: "Ventana de alimentación actual: aproximadamente X horas" — solo si se puede calcular
  con las horas reportadas; si no, omite esa línea.

BLOQUE 2 — PROPUESTA:
1. Diagnóstico breve — máximo 3 líneas, sin alarmismo, SOLO lo que la FUENTE SRB respalda y el
   formulario muestra.
2. Paso 0, si aplica.
3. Pilares — entre 2 y 4, SOLO los que el formulario respalda con datos reales Y que están en la
   FUENTE SRB adaptada: hidratación (suero casero, 2g/L para empezar), alimentación con semáforo
   personalizado (ver abajo), ritmo y ventana de alimentación, movimiento como juego.
4. Cierre: "Hábitos y ventana nutricional propuesta" — mismo formato de viñetas del Bloque 1, con
   los ajustes ya incorporados.

CÁLCULO DE LA VENTANA DE ALIMENTACIÓN — esto se ha calculado mal antes, hazlo con cuidado:
1. Identifica la hora de la PRIMERA comida y la hora de la ÚLTIMA comida, usando las horas que el
   propio formulario reporta (no inventes ni redondees antes de restar).
2. Resta en horas y minutos reales. Ejemplo de cómo hacerlo: primera comida 6:45 am, última comida
   6:30 pm → de 6:45 am a 6:45 pm son 12h00, y de 6:45 pm a 6:30 pm se restan 15 min más → la
   ventana real es 11h45, NO "aproximadamente 12 horas". Redondear hacia arriba para que el número
   parezca cumplir la regla de abajo está PROHIBIDO — si el cálculo da 11h45, escribe 11h45.
3. La ventana PROPUESTA nunca puede quedar por debajo de 12 horas. Para no quedar justo en el
   límite por un error de redondeo, apunta a que la ventana propuesta quede entre 12 y 13 horas, no
   exactamente en 12. Si mover la última comida más temprano haría que la ventana bajara de 12
   horas, NO la muevas más temprano — deja la hora de la última comida donde ya estaba (o incluso
   más tarde que la hora de la primera comida más 12h) y ajusta solo el contenido (qué se come), no
   el horario, para ganar margen de sobra.
4. Antes de escribir el número final de cualquiera de las dos ventanas (actual o propuesta),
   recalcula la resta una segunda vez y confirma que el número que vas a escribir coincide con las
   horas que tú mismo enumeraste en las viñetas — no copies un número de un ejemplo ni de memoria.
5. TODO ESTE CÁLCULO ES INTERNO Y NO SE NARRA. El padre nunca ve la regla ni tu razonamiento:
   prohibido escribir "el mínimo de 12 horas", "queda por debajo del mínimo", "corrección de
   ventana", "la propuesta final es", "margen seguro", o cualquier frase donde te corrijas a ti
   mismo a la vista. Si al calcular te das cuenta de que la hora que ibas a proponer no sirve,
   CAMBIA la hora antes de escribir y escribe una sola versión, ya correcta. Que no queden dos
   horas distintas para la cena en el mismo plan. Esto se coló en un plan real (21 oct 2026).
6. Las horas se escriben como se las dirías a un padre — "6:45 am", "7:00 pm" — nunca en formato
   de reloj de 24 horas ni con flechas tipo "06:00 → 19:00". Eso es el formato de los campos de
   abajo, que son internos; en el texto va lenguaje normal.
7. Si el formulario NO trae horas suficientes para calcular la ventana, dilo en una línea y pide
   el dato que falta — NO inventes horas ni propongas una ventana a ciegas. En ese caso, en los
   campos de reloj de abajo pon exactamente "00:00" en las cuatro posiciones: eso le dice al
   sistema que no había datos, que es distinto de una ventana mal calculada.

SEMÁFORO PERSONALIZADO — encabezados EXACTOS (encontrado en revisión en vivo: el rojo debe sonar
firme, no "reducir poco a poco"):
- "🔴 ROJO (eliminar por completo mientras equilibramos tu organismo)"
- "🟡 AMARILLO (con moderación)"
- "🟢 VERDE (prioridad en cada comida)"
Debajo de cada uno, ancla los alimentos de la FUENTE SRB a la señal concreta que el padre reportó —
nunca "no eliminar de golpe" ni ninguna otra frase que suavice el rojo.

TRAZABILIDAD — cada hábito trae, entre paréntesis al final, de qué parte específica de la FUENTE
SRB sale (ej. "(SRB — hidratación, suero casero isotónico)"). Si no puedes señalar de dónde sale
una frase, bórrala — no la incluyas "porque suena bien".

IMPORTANTE: responde SOLO el JSON crudo, sin backticks ni la palabra json alrededor. Dentro de los
textos, nunca uses comillas dobles para citar o enfatizar algo (usa comillas simples o ninguna).

VENTANAS EN FORMATO DE RELOJ (24h, "HH:MM") — además del texto, da las horas exactas de primera y
última comida por separado, en los 4 campos de abajo. Estos 4 campos son los que se usan para
verificar la ventana por fuera, con código, no confiando en el texto ni en tu propia resta — por
eso tienen que coincidir exactamente con las horas que escribiste en las viñetas de arriba.

Recibirás el formulario capturado en JSON. RESPONDE ÚNICAMENTE con este JSON:
{"resumenCronologico":"<Bloque 1>",
"mensaje":"<Bloque 2 completo: diagnóstico + Paso 0 si aplica + TE DEJO EL MAPA + pilares + cierre>",
"habitos":[{"titulo":"<3 a 5 palabras>","texto":"<1-2 frases + referencia SRB entre paréntesis>"}],
"ventanaActual":{"primeraComida":"<HH:MM>","ultimaComida":"<HH:MM>"},
"ventanaPropuesta":{"primeraComida":"<HH:MM>","ultimaComida":"<HH:MM>"}}
Entre 2 y 4 objetos en "habitos".
`;

// Mínimo de horas de la ventana de alimentación en niños (regla pediátrica
// dura: la ventana propuesta nunca puede quedar por debajo de esto).
const MIN_VENTANA_HORAS = 12;

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
  revisar(/mínimo de 12 horas|por debajo del mínimo|corrección de ventana|propuesta final|margen seguro|margen mínimo/i, "le narra al padre una regla interna");
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
        system: "Eres un verificador. Recibes (A) el texto fuente del SRB, (B) las adaptaciones pediátricas que ANULAN la fuente donde esta habla para adultos, y (C) un borrador de plan. Tu única tarea es listar afirmaciones concretas del borrador que no estén respaldadas NI por la fuente NI por las adaptaciones: dosis, cantidades, frecuencias, cifras, duraciones o mecanismos clínicos que ninguna de las dos diga. REGLA CLAVE: si el borrador sigue una adaptación pediátrica en vez de la fuente, eso es CORRECTO y NO se reporta — por ejemplo 2 g de sal por litro en lugar de 5 a 7, o una ventana de alimentación de 12 horas o más en lugar de 4 a 6. Ignora el estilo, el tono y la estructura. Ignora datos que vengan del formulario de la familia (horarios, nombres, lo que come, lo que el padre reportó). Si todo está respaldado, devuelve una lista vacía. Responde SOLO este JSON crudo, sin backticks: {\"sinRespaldo\":[\"afirmación 1\",\"afirmación 2\"]}",
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

// Genera el borrador automáticamente (Claude + Prompt Maestro embebido) y lo
// guarda solo, vía la misma acción "guardar_borrador" del Apps Script. Corre
// en segundo plano (ctx.waitUntil) — si falla por lo que sea, no revienta
// nada: la fila simplemente se queda en "pendiente" para revisión manual,
// igual que se comportaba el sistema antes de esta automatización.
async function generarBorradorAutomatico(dx, ts, env, producto) {
  try {
    if (!env.SHEET_WEBHOOK_URL_FORMULARIO) return;

    // Elige el prompt según el producto — "formulario_pediatrico_v2" usa el SRB
    // pediátrico v4 experimental (ver comentario junto a su definición);
    // cualquier otro valor usa el prompt de producción normal.
    //
    // max_tokens sube a 5000 para el v4 (21 oct 2026): el v4 trae la fuente SRB
    // verbatim embebida y pide dos bloques (resumen cronológico + propuesta con
    // semáforo y pilares). Generando el caso real de Josef con 2500 se truncaba
    // y el JSON no parseaba, y como esta función falla en silencio (ver abajo)
    // la fila se quedaba sin borrador y nadie se enteraba.
    const esPediatricoV2 = producto === "formulario_pediatrico_v2";
    const promptAUsar = esPediatricoV2 ? SRB_DRAFT_PROMPT_PEDIATRICO_V2 : SRB_DRAFT_PROMPT;

    // "correcciones" se usa en el reintento: se le dice al modelo qué estuvo
    // mal en su intento anterior, en vez de pedirle lo mismo y esperar suerte.
    const pedirBorrador = async (correcciones) => {
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
          model: "claude-sonnet-4-6",
          max_tokens: esPediatricoV2 ? 5000 : 2000,
          system: promptAUsar,
          messages: [{ role: "user", content: "Formulario capturado (JSON):\n" + JSON.stringify(dx) +
            ((correcciones && correcciones.length)
              ? "\n\nTu intento anterior tuvo estos problemas. Vuelve a escribir el plan completo sin ellos:\n- " + correcciones.join("\n- ")
              : "") }],
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
      return parsed && parsed.mensaje ? parsed : null;
    };

    // Camino de producción (prompt normal): un intento, sin verificación de
    // ventana — ese prompt no genera los campos de ventana ni el bloque 1.
    let parsed = await pedirBorrador();
    let avisoVerificacion = "";

    if (esPediatricoV2) {
      // REVISIÓN ANTES DE GUARDAR (21 oct 2026, pedido de Leonardo): el
      // borrador no llega al panel sin pasar por acá. Dos capas —
      //   (a) reglas duras por código: palabras prohibidas, reglas narradas al
      //       padre, formato interno filtrado, cifras de adulto, ventana corta.
      //       Si algo falla, se regenera UNA vez diciéndole qué corregir.
      //   (b) verificador de grounding contra la fuente SRB: es advisory, se
      //       anota para Peter pero nunca descarta el borrador.
      // Lo que sobreviva con problemas se guarda igual, con la lista arriba.
      // Mejor un borrador marcado que un caso vacío — y la alarma solo aparece
      // cuando de verdad hay algo, para que Peter no aprenda a ignorarla.
      const evaluar = (p) => {
        if (!p) return [];
        const fallos = revisarBorradorPediatrico(p);
        // horasDeVentana devuelve null cuando NO HAY DATO (el formulario no
        // traía horas y el prompt manda "00:00" para decirlo). Eso no es un
        // error: el propio texto le explica al padre qué hora falta.
        const h = horasDeVentana(p.ventanaPropuesta);
        if (h !== null && h < MIN_VENTANA_HORAS) {
          const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
          fallos.push("la ventana propuesta queda en " + hh + "h" + String(mm).padStart(2, "0") +
            " (de " + p.ventanaPropuesta.primeraComida + " a " + p.ventanaPropuesta.ultimaComida +
            "), por debajo del mínimo de " + MIN_VENTANA_HORAS + " horas para niños");
        }
        return fallos;
      };

      let fallos = evaluar(parsed);
      if (!parsed || fallos.length > 0) {
        const reintento = await pedirBorrador(fallos);
        const fallosReintento = evaluar(reintento);
        // Se queda con el reintento si no produjo nada el primero, o si salió
        // igual o mejor. Nunca se empeora a propósito.
        if (reintento && (!parsed || fallosReintento.length <= fallos.length)) {
          parsed = reintento;
          fallos = fallosReintento;
        }
      }

      if (parsed) {
        const sinRespaldo = await revisarGroundingConModelo(parsed, env);
        for (const s of sinRespaldo) fallos.push("posible afirmación sin respaldo en el SRB: " + s);
        if (fallos.length > 0) {
          avisoVerificacion = "[REVISIÓN AUTOMÁTICA — " + fallos.length + " punto(s) a mirar antes de aprobar]\n" +
            fallos.map(f => "· " + f).join("\n");
        }
      }
    }

    if (!parsed) return; // no se pudo generar limpio — se queda "pendiente"

    // El prompt v4 devuelve el plan en dos bloques (resumen cronológico actual
    // + propuesta). El panel tiene una sola ventana de texto, así que se
    // concatenan en orden, separados por una línea divisoria.
    let mensajeFinal = parsed.mensaje;
    if (esPediatricoV2 && parsed.resumenCronologico) {
      mensajeFinal = parsed.resumenCronologico + "\n\n" + "═".repeat(40) + "\n\n" + parsed.mensaje;
    }
    if (avisoVerificacion) {
      mensajeFinal = avisoVerificacion + "\n\n" + "═".repeat(40) + "\n\n" + mensajeFinal;
    }

    await fetch(env.SHEET_WEBHOOK_URL_FORMULARIO, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: env.SHEET_WEBHOOK_SECRET_FORMULARIO || "",
        action: "guardar_borrador",
        ts,
        mensaje: mensajeFinal,
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

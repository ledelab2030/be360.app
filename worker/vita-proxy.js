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
    const { mode, dx, ts, producto } = body || {};
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
      ctx.waitUntil(generarBorradorAutomatico(dx, tsFinal, env, producto));
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

// ============================================================
// SRB PEDIÁTRICO v2 — EXPERIMENTAL, NO APROBADO (2 oct 2026). Construido en
// vivo con Peter durante la sesión de validación: incorpora la filosofía
// completa del SRB (no solo la sección de alimentación), la estructura fija
// que pidió ("Paso 0" + pilares, tipo Notebook), semáforo personalizado por
// señales del niño/a, y trazabilidad por hábito (de qué sección del SRB
// sale). Probado en vivo contra los casos reales de Josef, Sofía y Samuel —
// resultados en el panel, pendientes de que Peter los apruebe formalmente.
// SOLO se usa cuando producto === "formulario_pediatrico_v2" (ver
// vita-demo-formulario-pediatrico/, un enlace aparte del de producción) —
// nunca se activa en el camino normal. No tiene SRB_PROMPT_VERSION propio
// todavía porque no es la versión vigente; cuando Peter lo apruebe, esto se
// vuelve el SRB_DRAFT_PROMPT real y este comentario se actualiza.
// ============================================================
const SRB_DRAFT_PROMPT_PEDIATRICO_V2 = `Eres el generador de planes pediátricos de be360, bajo el Sistema de Reversión Biológica (SRB) de
Peter Álvarez, traducido a una versión segura para niños y adolescentes (2 años en adelante, sin
límite superior). Tu borrador NO llega directo a la familia — lo revisa Peter Álvarez antes de
aprobarlo.

FILOSOFÍA DEL SRB (voz y esencia, no solo reglas — para que el plan suene a Peter, no a una lista
genérica): el SRB no trata síntomas aislados, busca las causas reales detrás de ellos —hábitos que
se pueden ajustar con acompañamiento. El cuerpo de un niño o adolescente "no está roto, está
sobrecargado" — el entorno diario (comida, hidratación, sueño, pantallas) es lo que se puede
cambiar. Siempre dirigido al padre/madre, nunca al niño/a directamente.

FUENTE ÚNICA — reglas duras, nunca las cruces:
- IDIOMA: español latinoamericano estándar, tuteo neutro. Prohibido el voseo argentino/uruguayo y
  modismos regionales marcados.
- PROHIBIDO SIEMPRE: ayuno intermitente o ventanas de ingesta restrictivas, restricción agresiva de
  carbohidratos con metas numéricas de gramos/día, dietas cetogénicas/carnívoras, déficit calórico
  agresivo. "No comer de noche" se enmarca como higiene de sueño/hígado — NUNCA como ayuno.
- EXCLUIDO EN ESTA VERSIÓN (decisión de Peter, 2 oct 2026, temporal): entrenamiento de fuerza
  estructurado y análisis de BioEmoción. El movimiento se trata como juego/actividad que disfrute,
  nunca como rutina de ejercicios. La dimensión emocional NO entra en el plan inicial — se reserva
  para una eventual Fase 2 a los 3-6 meses, solo si Peter lo indica caso por caso. No la menciones.
- PESO: nunca es un objetivo salvo que el padre lo plantee explícitamente o venga de un diagnóstico
  médico ya recibido. Nunca "dieta" ni imagen corporal.
- Si el formulario reporta un diagnóstico médico activo (ej. cardíaco, autoinmune, cualquier
  condición ya en tratamiento): los hábitos NUNCA se presentan como algo que trata o reemplaza ese
  seguimiento médico — se reconoce explícitamente que ese tema está en manos del especialista
  correspondiente, y los hábitos se enmarcan como apoyo general (digestión, energía, defensas,
  descanso), nunca como intervención sobre la condición médica reportada.
- Si el formulario muestra señales de posible trastorno de conducta alimentaria, salud mental grave
  o algo médico agudo: ese hábito dice que el equipo lo va a conversar directamente, sin detalle.
- Nunca inventes nada fuera de lo capturado en el formulario.

ESTRUCTURA FIJA DEL PLAN (pedido de Peter, 2 oct 2026 — estructura consistente tipo "Notebook", no
prosa libre; la misma estructura para todos los casos, solo cambia el contenido):

1. PASO 0 — Indicadores para compartir con su pediatra (NO metas que el padre persiga solo en
   casa; son datos a pedir en la próxima consulta, el equipo médico los interpreta): según lo que
   el formulario sugiera relevante para el caso, hasta 2 indicadores simples y no invasivos (ej.
   "cuántas veces a la semana reporta [síntoma X]", "si el pediatra ya le ha medido Y"). Si el
   formulario no da pie a ningún indicador claro, omite este paso por completo — no inventes uno.

2. LOS PILARES QUE VAMOS A TRABAJAR — entre 2 y 4, SOLO los que el formulario respalda con datos
   reales, cada uno anclado a algo concreto que el padre contó:
   a) Hidratación real — agua + suero casero si aplica, SIEMPRE empezando en 2g/L, nunca más.
   b) Alimentación con semáforo personalizado — ver abajo.
   c) Ritmo y rutina (sueño, pantallas, horarios) — nunca lenguaje de ayuno.
   d) Movimiento como juego — solo si el formulario lo amerita, nunca estructurado como ejercicio.

SEMÁFORO PERSONALIZADO (pedido de Peter — adapta el semáforo general a las señales específicas de
ESTE niño/a, no uses siempre la misma lista genérica):
- ROJO (reducir, nunca eliminar de golpe salvo intolerancia reportada): ancla a la señal que el
  padre mencionó — ej. si hay gases o malestar digestivo, trigo/ultraprocesados; si hay antojo
  difícil de explicar, azúcar añadida y jugos de caja.
- AMARILLO (moderar): lácteo de herbívoro (vaca/cabra — nunca bebidas vegetales, esas no cuentan),
  arroz, jugos naturales.
- VERDE (priorizar): proteína de calidad (idealmente orgánica si está al alcance), grasas buenas,
  verduras, carbohidratos complejos sin trigo (yuca, papa, plátano, ahuyama), fruta entera, agua.

TRAZABILIDAD (pedido de Peter) — cada hábito debe traer, entre paréntesis al final, de qué parte
del SRB se deriva (ej. "(SRB §7 — alimentación)", "(SRB §3 — ritmo circadiano)") para que el equipo
pueda verificar rápido que no se inventó nada fuera del método.

ESPECIFICIDAD Y CONCISIÓN: cada hábito cita el dato concreto que el padre dio — nunca lenguaje de
relleno genérico. Mensaje breve: intro de 2-3 frases + "TE DEJO EL MAPA" + los pilares + cierre
invitando a elegir. Tono cálido, sin culpa, nunca al niño/a directamente.

IMPORTANTE: responde SOLO el JSON crudo, sin backticks ni la palabra json alrededor. Dentro de los
textos, nunca uses comillas dobles para citar o enfatizar algo (usa comillas simples o ninguna) —
rompen el JSON.

Recibirás el formulario capturado en JSON. RESPONDE ÚNICAMENTE con este JSON — sin texto antes ni
después, sin bloque de código markdown:
{"mensaje":"<mensaje completo: intro + Paso 0 si aplica + TE DEJO EL MAPA + pilares + cierre>",
"habitos":[{"titulo":"<3 a 5 palabras>","texto":"<1-2 frases accionables + referencia SRB entre paréntesis>"}]}
Entre 2 y 4 objetos en "habitos".`;

// Genera el borrador automáticamente (Claude + Prompt Maestro embebido) y lo
// guarda solo, vía la misma acción "guardar_borrador" del Apps Script. Corre
// en segundo plano (ctx.waitUntil) — si falla por lo que sea, no revienta
// nada: la fila simplemente se queda en "pendiente" para revisión manual,
// igual que se comportaba el sistema antes de esta automatización.
async function generarBorradorAutomatico(dx, ts, env, producto) {
  try {
    if (!env.SHEET_WEBHOOK_URL_FORMULARIO) return;

    // Elige el prompt según el producto (2 oct 2026) — "formulario_pediatrico_v2"
    // usa el SRB pediátrico v2 experimental (ver comentario junto a su
    // definición); cualquier otro valor usa el prompt de producción normal.
    // max_tokens sube a 2500 para el v2: su estructura (Paso 0 + pilares +
    // semáforo personalizado + trazabilidad) es más larga que el prompt
    // normal y 2000 lo dejaba cerca del límite en pruebas.
    const esPediatricoV2 = producto === "formulario_pediatrico_v2";
    const promptAUsar = esPediatricoV2 ? SRB_DRAFT_PROMPT_PEDIATRICO_V2 : SRB_DRAFT_PROMPT;

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        // REVERTIDO a claude-sonnet-4-6 (2 oct 2026) — el intento de subir a
        // claude-sonnet-5 (16 sept 2026, junto con el bloque de ESPECIFICIDAD
        // de arriba) causaba fallas silenciosas reales: encontrado probando
        // con Samuel (12 años, hijo de Leonardo) — el caso se guardaba pero
        // nunca aparecía en el panel de Peter. Causa confirmada y reproducida:
        // Sonnet 5 gasta una porción grande del límite de 2000 tokens en
        // "pensar" internamente antes de escribir la respuesta visible: con
        // datos tan detallados como los de Samuel, eso dejaba la respuesta
        // cortada a la mitad, rompía el formato JSON esperado, y
        // generarBorradorAutomatico() se quedaba callado (por diseño, ver
        // comentario de la función) — la fila quedaba huérfana para siempre,
        // sin que nadie se enterara. El bloque de ESPECIFICIDAD en el prompt
        // se queda igual (sigue siendo la instrucción correcta); solo se
        // revierte el modelo. Decisión de Leonardo: no vale la pena asumir el
        // riesgo de la nueva falla por la ganancia de especificidad del
        // modelo nuevo — al menos no todavía, sin un mecanismo de alerta si
        // un borrador falla en silencio.
        model: "claude-sonnet-4-6",
        max_tokens: esPediatricoV2 ? 2500 : 2000,
        system: promptAUsar,
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

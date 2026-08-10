# CHANGELOG técnico — Vita (be360)

> Registro de cambios del repo `be360.app` (el producto web). Para el estado del
> proyecto/negocio/sprint clínico, ver `CONTEXT.md` en la carpeta del sprint
> (`be360-workspace`). Este documento cubre: arquitectura, decisiones técnicas,
> medidas de seguridad/privacidad, y pendientes conocidos — pensado para
> auditoría, compliance, grants, inversionistas y cualquier persona que se
> sume al desarrollo.

---

## Resumen ejecutivo

Vita es el asistente de bienestar de Bienestar 360, con dos líneas de producto en este repo:

- **`vita-demo-srb-3`** — un diagnóstico conversacional general (adulto o familia), basado en el método SRB de Peter Álvarez. Producto propio, anterior al sprint clínico pediátrico.
- **`vita-demo-formulario`** — construido específicamente para el piloto con familias del colegio BIS: captura, conversando con el padre/madre, exactamente las áreas del *Formulario de Hábitos* validado con Peter, y alimenta un flujo de aprobación clínica antes de que cualquier recomendación llegue a una familia.

**La regla que gobierna todo el sistema:** ningún padre recibe una recomendación generada por IA sin que Peter Álvarez (la autoridad clínica) la revise y apruebe primero. Esto se llama *Human-in-the-Loop* (HITL) y está implementado en el código, no solo en el proceso — el sistema está diseñado para que sea imposible saltárselo, no solo para que no se salte por buena voluntad.

**Estado actual (9 ago 2026):** el ciclo completo está construido y **probado de punta a punta, 100% automático de principio a fin, con doble camino de captura y una herramienta de revisión real para Peter** — no ya una hoja de cálculo cruda. Padre conversa con Vita o llena el formulario directo (puede cambiar de uno a otro sin perder nada) → se genera un borrador de plan solo → Peter lo revisa, edita o excluye hábitos uno por uno en **panel/index.html**, un panel dedicado (no la hoja de cálculo) → al aprobar, **un correo automático le llega DIRECTO al padre/madre con el link de su plan, sin que nadie del equipo tenga que enviarlo a mano** → el padre abre su plan (checklist de hábitos) y puede escribirle a Vita desde ahí, con escalamiento real a correo si hace falta un humano — y ese mismo escalamiento ahora también existe desde la captura inicial, con una red de respaldo que no depende de que el modelo se acuerde de marcarlo. Verificado con un panel sintético de 9 personas con perfiles críticos (desconfianza, apuro, exigencia de consejo, riesgo real, crítica del tono), que encontró y ayudó a corregir fallas reales antes de exponer el sistema a familias. TRL actual: 4, cruzando a 5 — ver `be360_TRL_assessment` en Drive. Lo que falta para producción real está en "Pendientes conocidos" al final.

**Costo/infraestructura:** cero servidores propios. Todo corre sobre GitHub Pages (frontend), un Cloudflare Worker (proxy seguro a la API de Anthropic + lógica de negocio) y Google Sheets/Apps Script (persistencia y panel de revisión). Esto es deliberado: mantiene el costo marginal cercano a cero mientras se valida el modelo con las primeras familias, antes de invertir en infraestructura de producción.

---

## Arquitectura actual

```
Padre/madre                          Peter (revisor clínico)
    │                                        │
    ▼                                        │
vita-demo-formulario (GitHub Pages)          │
    │  conversación, captura el formulario   │
    ▼                                        │
Cloudflare Worker "vita-proxy"               │
    │  proxy seguro a Claude (API key nunca  │
    │  en el navegador) + lógica de negocio  │
    ▼                                        │
Google Sheet "vita-demo-formulario"  ◄───────┘  Peter revisa/edita/aprueba
    │  vía Apps Script (Web App)                 en panel/index.html
    ▼                                             (PIN, no toca el Sheet)
Worker genera un link único (/plan?id=...)
    │  — SOLO funciona si Peter aprobó
    ▼
plan/index.html (GitHub Pages)
    │  el padre ve su plan: checklist de hábitos + progreso
    ▼
Correo automático directo al padre/madre con el link — sin clic humano
```

No hay base de datos propia ni backend con estado — el Sheet **es** la base de datos. Desde el 9 ago, Peter ya no la toca directamente: `panel/index.html` (protegido por PIN) es la única vía normal de revisión/edición/aprobación, hablando con el Sheet a través de acciones dedicadas del Apps Script (`/panel/*` en el Worker) que nunca exponen el secreto de escritura real del Sheet al navegador.

---

## Línea de tiempo técnica

### 4-5 ago 2026 — HITL en `vita-demo-srb-3` (rama `feat/hitl-capture-only`, PR #1)

- **Hallazgo:** el demo generaba una recomendación ("microcambio") directo en el chat, sin pasar por revisión de Peter. Esto violaba la regla dura firmada por Peter el 28 jul ("ningún plan llega al padre sin su aprobación").
- **Decisión de arquitectura** (evaluada y confirmada con el equipo): *capture-only*. El chat deja de generar recomendaciones; solo captura información y la manda a un Sheet de revisión. El plan real se genera aparte, después de la aprobación.
- Se agregó el endpoint `POST /log` al Worker, que reenvía el diagnóstico capturado a un Google Sheet vía Apps Script (Web App).
- **Blindaje server-side:** el Worker nunca deja pasar un campo de recomendación no vacío hacia el Sheet, aunque el prompt fallara — no depende solo del modelo de lenguaje para cumplir la regla.
- **Decisión de acceso:** no se comparte la cuenta de Cloudflare con el agente de IA. Se usó un token de API de alcance mínimo (solo edición de scripts de Workers), revocado y renovado varias veces por higiene tras quedar expuesto en conversación.
- Se corrigió el código del Worker reconstruido inicialmente por una versión verificada línea por línea contra el código real en producción (vía API de Cloudflare).
- **Bug encontrado y corregido:** Google Apps Script siempre responde HTTP 200 así la operación falle internamente (ej. secret incorrecto) — el Worker inicialmente solo miraba el código HTTP, no el contenido de la respuesta, y por eso reportaba éxito falso. Corregido para verificar el campo `ok` real del cuerpo de la respuesta.
- **Causa raíz de varias horas de debugging:** los despliegues se estaban haciendo desde una rama de git vieja (`feat/hitl-capture-only`) en vez de `main` — cada corrección quedaba en GitHub pero nunca llegaba a producción. Ya resuelto; documentado para que no se repita.

### 5-6 ago 2026 — `vita-demo-formulario`, producto separado (PRs #2, #3)

- **Corrección de rumbo:** `vita-demo-srb-3` es un producto de diagnóstico general, no el que diseñó el sprint clínico pediátrico. Se construyó `vita-demo-formulario` desde cero, con:
  - Prompt que captura exactamente las áreas del `formulario_habitos.json` v4 del sprint (general/objetivo, origen, sueño y movimiento, señales, diagnósticos, cronología del día, fin de semana, mente/pantallas, emociones) — no el schema genérico del otro demo.
  - Solo modo familia (2-20 años) — sin modo adulto, porque el sprint no lo necesita.
  - Voz de Vita alineada a la guía de tono del sprint: tuteo, cero emojis, mensajes de 2-4 líneas, una pregunta a la vez.
  - Capture-only desde el diseño original (no es un parche posterior, como en el otro demo).
- **Worker extendido:** el endpoint `/log` ahora enruta por un campo `producto` (`"srb3"` | `"formulario"`) a dos Sheets separados, cada uno con sus propios secrets — evita mezclar dos schemas de datos distintos en la misma hoja.
- Prueba end-to-end con un caso ficticio ("Samuel") corrida en vivo: conversación completa capturada correctamente en el Sheet.

### 5 ago 2026 — Corrección clínica: lácteo de herbívoro vs. bebidas vegetales

- En sesión de trabajo con Peter Álvarez, aclaró que en su método el lácteo de un animal herbívoro (leche de vaca, cabra, etc.) va deliberadamente en rojo — no es un matiz suave — por su asociación con enfermedad crónica en humanos con el uso sostenido.
- Corrección necesaria: el sistema no distinguía esto de las bebidas vegetales que coloquialmente se llaman "leche" (almendra, avena, soya), que **no** son lácteo y no aplica la misma restricción.
- Corregido en `traduccion_pediatrica.txt` y `srb_draft_generator.txt` (repo del sprint clínico) — el semáforo pediátrico y el Prompt Maestro ahora distinguen explícitamente ambos casos.

### 6 ago 2026 — Panel de revisión de Peter v2 + página del plan para el padre (PR #7)

- **Apps Script extendido:** nueva acción `guardar_borrador` (recibe el borrador generado — tabla de recomendaciones + mensaje al padre — y lo escribe en la fila correspondiente del Sheet, generando un identificador aleatorio de plan) y un nuevo `doGet` de solo lectura.
- **Worker extendido:**
  - `POST /guardar-borrador` — guarda el borrador generado a partir del Prompt Maestro.
  - `GET /plan?id=...` — lectura **pública** (sin restricción de origen, porque la abre el padre desde un link, no desde el sitio) que **solo** devuelve contenido si la fila tiene `decision = "aprobado"` en el Sheet. Un borrador sin aprobar nunca es accesible por esta vía, aunque alguien adivinara o interceptara el identificador.
  - El identificador de plan es un token aleatorio, no un ID secuencial — no se puede enumerar planes de otras familias probando IDs consecutivos.
- **Página nueva `plan/index.html`:** el padre ve su plan aprobado con el mismo diseño visual (tarjetas con checklist por hábito + barra de progreso) que se validó directamente con Peter Álvarez en sesión de trabajo. El estado de los checkboxes se guarda localmente en el navegador del padre (no en el servidor, en esta fase).
- **Prueba end-to-end confirmada:** caso ficticio de Samuel — formulario → borrador generado (Prompt Maestro) → guardado en Sheet → bloqueado hasta aprobación (verificado con petición directa, respondió 404) → aprobado manualmente en el Sheet (simulando a Peter) → link del plan funcionando con los datos reales.

### 6 ago 2026 — Captura de contacto + entrega automática por correo/WhatsApp

- **`vita-demo-formulario`:** nueva área de captura al inicio (nombre del padre/madre + WhatsApp de contacto), antes de empezar con el hijo/a. Sin esto no se podía armar el link de entrega.
- **Bug encontrado y corregido:** Google Sheets interpreta un valor que empieza con `+` (como un número de teléfono `+57 300...`) como el inicio de una fórmula, y la celda queda en `#ERROR!`. Corregido forzando formato de texto plano (`setNumberFormat("@")`) en esa columna antes de escribir el valor — tanto para lo que escribe el Worker como recomendación para cualquier edición manual.
- **Trigger de aprobación (`onAprobado`):** instalado como trigger *instalable* (no simple trigger — los simple triggers de Apps Script no tienen permiso para mandar correo) sobre el evento "Al editar" del Sheet. Apenas alguien escribe `aprobado` en la columna `decision`, se dispara automáticamente un correo al equipo con: el link del plan y un link `wa.me` ya armado con el mensaje de entrega precargado para el WhatsApp del padre — un clic para enviar.
- El botón "Escribirle a Vita" en `plan/index.html` pasó de ser texto suelto a un link real (`wa.me`) al número de contacto del equipo.
- **Prueba end-to-end confirmada con notificación real:** aprobar el caso de Samuel en el Sheet disparó el correo automático; el link de WhatsApp generado abrió correctamente con el mensaje precargado; el padre (de prueba) recibió el link y pudo ver su plan.

### 7 ago 2026 — Generación automática del borrador (cierra el último pendiente del ciclo)

- El Worker ahora genera el borrador **solo**, en segundo plano (`ctx.waitUntil`, el padre no espera), justo después de guardar el formulario capturado — ya no requiere que un desarrollador corra el Prompt Maestro a mano por cada caso.
- Se embebió una versión condensada del Prompt Maestro (`design-sprint/src/prompts/srb_draft_generator.txt` del repo del sprint) directo en el Worker, adaptada para responder JSON estricto (parseable) en vez del formato "Parte A/B" en texto libre — necesario para que el sistema pueda guardarse el borrador solo, sin un humano interpretando el resultado.
- **Diseño a prueba de fallos:** si Claude no devuelve JSON válido, o la llamada falla, la fila simplemente se queda en `pendiente` — el sistema no se rompe, y sigue siendo posible generar el borrador a mano como respaldo (`POST /guardar-borrador`, sin cambios).
- Con esto, **los 3 pasos que antes requerían intervención humana en el camino crítico del ciclo quedan en 1**: la única acción humana obligatoria que queda es la aprobación de Peter (por diseño — es la regla dura que no se automatiza) y el clic para enviar el WhatsApp final (por decisión, mientras no haya WhatsApp Business API).

### 7 ago 2026 — Chat de seguimiento real (reemplaza el WhatsApp monitoreado a mano)

- **"Escribirle a Vita"** en `plan/index.html` pasó de abrir WhatsApp a un número que una persona del equipo tenía que contestar manualmente, a abrir un **chat real dentro de la app** — mismo patrón técnico que `vita-demo-formulario` (bot de verdad, no una persona fingiendo).
- El prompt del chat (`buildSeguimientoPrompt`) se arma dinámicamente por caso: los hábitos del plan **ya aprobado** de ese niño/a específico son su única fuente — no propone hábitos nuevos, no cambia el plan, solo acompaña el sostenimiento (loop de `tono_identidad_bot.txt`: preguntas abiertas, nunca señala fallas, ofrece versión más pequeña del hábito si hace falta).
- **Escalamiento real, no solo "el bot lo dice":** cuando el modelo detecta una urgencia clínica, una duda sobre el plan que no debe resolver, o que el padre pide hablar con una persona, marca un identificador invisible en su respuesta; el frontend lo detecta y llama a un nuevo endpoint `POST /escalar`, que reenvía un correo real al equipo (acción `notificar_escalamiento` en el Apps Script). Sin este paso, una señal de riesgo real podría quedar flotando en un chat sin que nadie del equipo se enterara — se decidió construirlo antes de considerar el ciclo completo.
- **Probado end-to-end:** conversación de seguimiento con el caso de Valeria reconoció correctamente los hábitos específicos de su plan (no genéricos) y mantuvo el tono correcto; prueba directa de `/escalar` confirmó que el correo de escalamiento llega de verdad.

### 8 ago 2026 — Se deja de pedir WhatsApp; entrega del plan 100% automática por correo (decisión de Leonardo)

- **Decisión:** no pedirle el WhatsApp al padre/madre por ahora. Tratar WhatsApp como canal de entrega implica controles, restricciones y costos de la API de Meta que no hacen falta todavía — con correo alcanza para lo que el sprint necesita, y `plan/index.html` ya tiene su propio chat de seguimiento (no depende de WhatsApp para nada desde el 7 ago).
- **`vita-demo-formulario`:** la captura de contacto pide correo en vez de WhatsApp (`email_padre` reemplaza a `whatsapp_padre` en el schema, el prompt y el Sheet).
- **`onAprobado` (Apps Script) ya no arma un link de WhatsApp para que alguien del equipo lo mande a mano:** manda el correo con el link del plan DIRECTO al padre/madre, automáticamente, apenas Peter pone `aprobado`. Esto cierra el último paso manual que quedaba en el camino crítico del ciclo (antes: "un clic humano para WhatsApp"; ahora: nada).
- El número de WhatsApp de Vita (`+372 81282920`) se mantiene solo como canal de contacto de respaldo (ej. si alguien abre un link de plan que todavía no está aprobado) — no como parte del flujo de entrega.
- **Pulido de experiencia** (ver PRs #15, #16, #18): se corrigieron detalles de copy que sonaban mecánicos en vez de cuidados — el header del chat y el panel lateral ya no exponen la palabra "Formulario" ni la tratan como un contador de progreso; se quitó el disclaimer duplicado y el tiempo estimado incorrecto ("5-10 min" → "20-30 min", más realista); "Peter la revisa" pasó a "la revisamos"/"el equipo" en toda la copy visible y las instrucciones del bot, para que be360 se vea como equipo y no como una sola persona; la pantalla de confirmación ahora dice el nombre del hijo/a en vez de "tu hijo/a"; y se arregló un link de WhatsApp roto en `plan/index.html` (decía "escríbenos" sin dar ningún link).
- **Prueba end-to-end confirmada con datos reales, en vivo, con Leonardo como padre de prueba (caso "Tomás", 8 ago):** conversación completa con Vita (14/14 áreas, correo en vez de WhatsApp) → borrador generado solo, respetando las reglas duras (nunca dice "eliminar" la leche, dice "reducir sin golpe", conforme a la regla A.2) → aprobado en el Sheet → **llegaron los dos correos automáticos esperados**: uno al padre ("El plan de Tomás ya está listo", primera persona, firmado "El equipo de Bienestar 360") y la copia interna de auditoría al equipo ("✅ Plan enviado automáticamente — Tomás") → el plan se vio correctamente en `plan/index.html` con el checklist funcionando → el chat de seguimiento arrancó (con el botón, no solo) y respondió con detalles reales de la conversación. Primera vez que el ciclo completo corre sin ningún paso manual salvo la aprobación de Peter.

### 8-9 ago 2026 — Escalamiento desde la captura + red de respaldo determinística (PRs #20, #21)

- **Hallazgo:** el escalamiento real (correo al equipo) solo existía en el chat de seguimiento post-aprobación (`plan/index.html`), no en la captura inicial (`vita-demo-formulario`) — una señal de riesgo real (trastorno alimentario, salud mental, urgencia médica) contada durante el formulario no disparaba nada hasta que, quizás, alguien lo notara al revisar el borrador.
- Se agregó el mismo mecanismo de marcador (`<escalar>`) y motivo (`riesgo_alimentario` / `riesgo_salud_mental` / `urgencia_medica`) también en `vita-demo-formulario`, con `notificarEscalar()` llamando a `/escalar`.
- **Falla real encontrada probando esto en vivo:** se verificó, inspeccionando directamente las peticiones de red del navegador (no solo mirando la respuesta del chat), que tras una conversación con una señal de riesgo real el modelo respondía de forma apropiada en el texto pero **no emitía el marcador `<escalar>`** — cero llamadas a `/escalar` en el registro de red. El marcador del modelo, por sí solo, no era confiable.
- **Fix — red de respaldo determinística:** `detectarRiesgoTextual()`, un conjunto de patrones de texto (no depende del modelo) que corre en dos puntos: en cada turno del chat, y de nuevo escaneando todos los campos capturados justo antes de permitir el envío a revisión (`sendToReview`) — defensa en profundidad, no un solo punto de falla.

### 8-9 ago 2026 — Modo formulario directo + cambio de modo bidireccional sin pérdida de datos (PRs #22-#25)

- **Hallazgo (reportado con capturas de pantalla):** un padre que le pedía a Vita en el chat "prefiero seguir con el formulario" no lograba nada — Vita respondía "Claro, seguimos" y continuaba haciendo preguntas de chat. No existía ningún mecanismo, ni de UI ni de texto, para cambiar de modo.
- Se construyó un modo formulario directo (mismos campos y ayudas que el chat, sin conversación) que comparte el mismo estado (`dx`) que el chat — llenar uno actualiza el otro.
- Cambio de modo en ambas direcciones: botón 📝 en el header del chat → formulario; link "conversar con Vita" en el formulario → chat. Además, un marcador `<cambiar_modo>` que el propio Vita puede emitir si detecta la intención en el texto del padre (ej. la frase real de arriba), no solo por botón.
- **Caso borde cubierto:** si el padre edita el formulario mientras el chat está en pausa, `sincronizarCambiosFormulario()` manda un turno invisible de contexto a Vita al volver al chat, para que no le repita preguntas ya respondidas ni ignore lo nuevo.
- **Hotfix en el camino (PR #23):** una comilla invertida de estilo markdown dentro de un template literal del prompt rompió el parseo de JS y dejó la página en blanco en producción por un rato — reafirmó la práctica (ya en curso desde antes) de correr `node --check` sobre cualquier archivo `.js`/`.gs.txt` y una transformación Babel sobre cualquier JSX antes de publicar, no solo revisión visual.

### 9 ago 2026 — Validación real de suficiencia antes de enviar a revisión (PR #26)

- **Hallazgo (pedido explícito):** el envío a revisión solo contaba cuántos campos tenían algo escrito (mínimo 4 de cualquiera) — un padre podía enviar con respuestas de una palabra y pasar el corte, o quedarse sin poder enviar por elegir 4 campos poco informativos mientras dejaba vacía la cronología del día, el campo más importante para el borrador.
- Nueva regla: identificación completa (nombre y correo del padre, nombre y edad del niño/a) **siempre** obligatoria, más una cronología del día con sustancia real (mínimo de caracteres, no solo "no vacío"), más un mínimo de 4 de las 9 áreas opcionales restantes con contenido real.
- El botón de enviar queda deshabilitado con un mensaje específico de qué falta (`mensajeFaltante()`), no un rechazo genérico.

### 9 ago 2026 — Panel de revisión de Peter: reemplaza la edición directa del Sheet (PRs #27-#32)

- **Motivo (pedido explícito de Leonardo):** "la hoja de sheets la daña cualquiera que tenga acceso sin querer" — Peter aprobando/editando directo en Google Sheets es fácil de romper por accidente (borrar una fila, editar la columna equivocada, romper una fórmula) y no tiene ningún control de qué se puede y no se puede hacer.
- **`panel/index.html` (nuevo):** app de una sola página, con el mismo estilo visual del resto del producto, protegida por PIN (guardado localmente tras el primer ingreso, con botón de mostrar/ocultar el PIN al escribirlo). Desde ahí Peter puede, sin tocar el Sheet:
  - Ver la lista de **pendientes de aprobación**, con nombre, edad y preocupación principal de un vistazo.
  - Abrir el detalle de un caso: ver todo el formulario capturado, el mensaje generado para el padre (editable), y la lista de hábitos propuestos con un check para **incluir/excluir cada uno individualmente** sin borrarlo (queda guardado como excluido, no se pierde, por si Peter reconsidera antes de aprobar).
  - **Guardar sin aprobar** (deja el caso en pendientes con los cambios) o **aprobar** (dispara el correo real al padre — con un diálogo de confirmación explícito que cita el correo real antes de mandar).
  - **Descartar** un caso pendiente (para limpiar pruebas), bloqueado deliberadamente si ese caso **ya le envió correo a una familia real** — el chequeo es sobre el hecho concreto de si se mandó el correo (`correo_enviado_ts`), no sobre si el estado dice "aprobado", porque un caso puede quedar marcado aprobado en pruebas sin que haya un correo real de por medio.
  - **Historial de aprobados**, de solo lectura, con acceso directo al link del plan tal como lo ve el padre — separado de pendientes en una barra lateral, para que Peter no tenga que buscar entre las dos listas mezcladas.
- **Apps Script extendido** con seis acciones nuevas protegidas por un secreto de panel propio (`PANEL_SECRET`, **distinto** del secreto de escritura del Sheet — el Worker jamás ve ni necesita este último para las rutas de panel): `listar_pendientes`, `listar_historial`, `detalle_plan`, `guardar_edicion_plan`, `aprobar_plan`, `descartar_pendiente`.
- **Worker extendido** con seis rutas (`/panel/pendientes`, `/panel/historial`, `/panel/detalle`, `/panel/guardar`, `/panel/aprobar`, `/panel/descartar`), cada una un passthrough genérico hacia la acción correspondiente del Apps Script — no requirió ningún secreto nuevo de Cloudflare.
- **Bug de configuración encontrado y corregido:** la plantilla original tenía un valor de `PANEL_SECRET` de relleno (tipo "CAMBIA-ESTO-por-un-pin...") pensado como instrucción, no como valor real — pero cada vez que se volvía a pegar el archivo completo para desplegar una versión nueva, ese relleno pisaba el PIN real ya configurado por Peter, rompiendo el acceso en silencio. **Decisión permanente:** el código generado desde ahora usa `"1990-I"` como valor por defecto real de `PANEL_SECRET`, documentado en el propio archivo para que nadie vuelva a poner un placeholder ahí.
- **Verificación con un panel sintético de 9 personas críticas** (generadas para representar perfiles adversos: desconfianza, apuro, exigencia de un consejo directo saltándose al bot, una señal de riesgo real de trastorno alimentario/autolesión, y una crítica directa del tono) — encontró en la práctica la falla del marcador de escalamiento no confiable (arriba) y sirvió para poblar y probar el panel con casos variados antes de dárselo a Peter. Se limpiaron 3 duplicados generados por un timeout del lado de las pruebas (no del producto) usando la función de descarte recién construida.

### 9 ago 2026 — Consentimiento formalizado en el producto (PR #34)

- **Origen:** el assessment de RAI (framework de Marwa Soudi/Tallinn Univ., ver `be360_RAI_maturity_assessment` en Drive) marcó esto como el gap más serio de las 9 dimensiones evaluadas — Privacy → Consent management, score 0/4. Hasta hoy no existía NINGUNA pantalla dentro del producto que explicara qué se captura, quién lo revisa y cómo pedir que se borre; solo un guion **verbal** de consentimiento para las sesiones del Día 5 del sprint, que no cubre a nadie que use el producto por su cuenta.
- **`vita-demo-formulario`:** nueva pantalla `consentimiento`, obligatoria antes de que empiece cualquier captura — ambos caminos de entrada (chat o formulario directo) pasan por ahí primero, una sola vez por sesión. Explica en 3 puntos simples: quién revisa la información (equipo clínico, HITL, nunca llega un plan sin que un humano lo vea), para qué se usa (solo para preparar el plan, no se comparte con nadie más), y cómo pedir que se borre (correo directo al equipo). No se puede avanzar sin marcar la casilla de aceptación.
- La aceptación queda como `dx.consentimiento_ts` (timestamp ISO) — viaja con el resto de `dx` hacia `/log` sin que el Worker necesite ningún cambio (el `dx` completo pasa tal cual hacia Apps Script para `vita-demo-formulario`).
- **Apps Script y panel, preparados pero pendientes de un paso manual:** se agregó la columna `consentimiento_ts` (`COLS`, `appendRow`, `detallePlan`) al archivo `apps-script-formulario-v2.gs.txt`, y `panel/index.html` ya muestra si un caso tiene consentimiento registrado o no. Backward-compatible: mientras no se despliegue la nueva versión del Apps Script, el campo viaja en el payload pero se ignora sin romper nada — la pantalla ya protege a cualquier familia real desde que se mergeó, el registro server-side es lo único que falta y requiere el paso manual de siempre ("Implementar → Nueva versión").
- Verificado en producción, en vivo: pantalla aparece antes de ambos caminos de entrada, botón deshabilitado hasta marcar la casilla, y navega correctamente al destino original (chat o formulario) tras aceptar. Sin errores de consola.

### 9 ago 2026 — Rate limiting real, por IP (PRs #36, #37, #38) — primer intento con KV falló, reemplazado por Durable Objects

- **Contexto:** Leonardo creó y conectó desde el dashboard de Cloudflare (en el móvil, sin usar wrangler) un namespace de KV (`vita_rate_limit`) como binding `RATE_LIMIT_KV` — primer intento de cerrar el pendiente de rate limiting.
- **Probado en vivo, con 73 peticiones de prueba seguidas (33 + 35 + 40, distintos espaciados) y NUNCA se disparó el límite.** Causa raíz: Cloudflare Workers KV es *eventually consistent* a propósito — está pensado para lecturas frecuentes con pocas escrituras, no para un contador que cambia en cada petición. Un `get()` justo después del `put()` de otra petición puede no ver el valor nuevo todavía. No era un bug del código — era la herramienta equivocada para este trabajo.
- **Error real cometido en el camino:** las primeras 68 peticiones de prueba se mandaron contra `/escalar`, que dispara un correo real a `leonardo@ledelab.group` por cada llamada — nadie pensó en esa consecuencia hasta que llegaron 69 correos de prueba a la bandeja real. Aprendizaje aplicado de inmediato: las pruebas de carga siguientes usaron un endpoint sin efectos secundarios (POST a `/` con cuerpo `{}` — Anthropic lo rechaza al instante por falta de `messages`, sin costo real ni de API ni de correo, misma técnica de diagnóstico ya usada antes en este changelog).
- **Reemplazo:** clase `RateLimiter` (Durable Object) en `vita-proxy.js` — una instancia por IP (`env.RATE_LIMITER.idFromName(ip)`); Cloudflare garantiza que las peticiones a la MISMA instancia se procesan una por una, así que el contador (`this.state.storage`) sí es confiable, sin condición de carrera entre peticiones distintas. Ventana fija de 60s, límite de 30 peticiones/IP/minuto.
- **`wrangler.toml`:** binding `durable_objects.bindings` + migración (`new_sqlite_classes`, para que quede disponible en el plan free de Cloudflare, no solo en planes de pago). El namespace de KV queda huérfano (sin usar, no hace daño dejarlo).
- **Verificado en producción, en vivo, limpio:** 30 peticiones seguidas en 400 (rechazo esperado por falta de `messages`), y las peticiones 31, 32 y 33 en 429 — el bloqueo se dispara exactamente donde debía y se sostiene dentro de la misma ventana.
- **Cómo se desplegó:** primera vez en este proyecto que un agente de IA obtuvo acceso directo de despliegue vía `wrangler` (token de alcance mínimo — `Workers Scripts: Edit` + `Workers KV Storage: Edit` —, provisto por Leonardo vía variable de entorno en `~/.zshenv`, nunca pegado en la conversación). Antes de esto, todo despliegue del Worker requería que Leonardo copiara/pegara el código a mano en el editor del dashboard.

---

## Medidas de seguridad y privacidad (para compliance/auditoría)

- **Human-in-the-Loop real, no solo procedimental:** implementado en el código (el Worker verifica el estado de aprobación antes de servir cualquier plan), no solo como una política que alguien podría olvidar seguir.
- **La API key de Anthropic nunca toca el navegador** — vive como secreto en Cloudflare, inaccesible desde el cliente.
- **CORS restringido** a `be360.app` en los endpoints internos (captura, generación de borrador). El único endpoint público es `/plan`, y está intencionalmente limitado a devolver solo planes ya aprobados.
- **Minimización de datos:** el prompt de captura instruye explícitamente a no retener más de lo necesario; no hay expediente médico completo, solo lo relevante para el seguimiento del hábito.
- **El interlocutor es siempre el adulto responsable**, nunca el menor — verificado en el diseño del prompt en ambos demos.
- **No se promete ningún servicio inexistente:** el sistema no ofrece coordinación médica automática ni tiempos de respuesta que no puede garantizar (regla explícita en el prompt).
- **Nada de IA/stack/proveedores se menciona** de cara a familias o colegios — solo en materiales internos, de grant o de inversión (registro doble, ya documentado en `CONTEXT.md`).

---

## Pendientes conocidos (honestidad ante inversionistas/grants — esto NO está listo para producción real)

1. ~~No hay captura de contacto del padre~~ **Resuelto 6 ago, actualizado 8 ago:** `vita-demo-formulario` captura nombre y correo del padre/madre al inicio de la conversación (antes era WhatsApp — ver punto 2).
2. ~~No existe un número de WhatsApp dedicado para Vita~~ **Resuelto 6 ago, superado 8 ago:** se decidió no pedir WhatsApp al padre por ahora (evita depender de esa API de Meta mientras no haga falta). El número `+372 81282920` se mantiene solo como contacto de respaldo, no como parte del flujo. La entrega del plan ahora es por correo, automática (ver punto 3).
3. ~~El "chatear con Vita" sigue siendo una persona~~ **Resuelto 7 ago, entrega automatizada 8 ago:** "Escribirle a Vita" abre un chat de seguimiento real (bot, no persona). La entrega inicial del plan, que hasta el 7 ago requería un clic humano para WhatsApp, ahora es **automática por correo** — `onAprobado` le escribe directo al padre/madre apenas Peter aprueba. Ya no queda ningún paso manual en el camino crítico del ciclo, salvo la aprobación misma de Peter (por diseño).
4. ~~La generación del borrador no está automatizada~~ **Resuelto 7 ago:** el Worker genera el borrador solo (Claude + Prompt Maestro embebido) apenas se guarda el formulario, en segundo plano — el padre no espera, y un desarrollador ya no tiene que correrlo a mano.
5. **Google Sheets/Apps Script es una capa de persistencia de prototipo**, no una base de datos de producción. ~~No tiene política formal de retención ni borrado de datos todavía~~ **Decidida 9 ago, aprobada por Leonardo — ver punto 13.** Falta implementarla en código (fast-follow, no bloquea nada hoy).
6. ~~El Worker no bloquea peticiones sin header Origin~~ **Resuelto 8 ago:** ahora exige el header `Origin` exacto (`be360.app`) en vez de solo rechazar los incorrectos — un `curl` directo ya no puede gastar créditos de Claude ni spamear `/escalar`. ~~Sigue faltando rate limiting real~~ **Resuelto 9 ago** — ver punto 12.
7. **Alineación clínica incompleta:** quedan puntos abiertos con Peter sobre nivel de detalle del plan y fraseo de algunas preguntas (relajación/emociones) — ver `CONTEXT.md` del sprint para el detalle vivo.
8. **Sin pruebas de carga ni análisis de costo a escala** — validado con casos ficticios, no con volumen real. El costo por interacción (API de Anthropic + envío de correo, que no tiene costo marginal vía Apps Script) está pendiente de verificar contra el modelo de negocio (compromiso pendiente de Leonardo con Peter, sesión 5 ago).
9. ~~Peter aprueba/edita directo en la hoja de Sheets, con riesgo de daño accidental por cualquiera con acceso~~ **Resuelto 9 ago:** `panel/index.html`, protegido por PIN, es ahora la única vía normal de revisión — ver PRs #27-#32 arriba. El Sheet sigue siendo la base de datos de fondo, pero ya no se edita a mano en el camino normal de trabajo.
10. **Falta validación con familias reales — es el gap principal hacia TRL 5, no uno técnico.** Todo lo de arriba está probado con datos ficticios/simulados (incluido un panel sintético de 9 personas adversas diseñado para encontrar fallas). El Día 5 del sprint (`guion_sesion_dia5.txt`, ya actualizado al sistema real) es el paso que falta ejecutar — ver `be360_TRL_assessment` (Drive) para el detalle completo del camino a TRL 5.
11. ~~No hay un flujo formal de consentimiento informado dentro del producto~~ **Totalmente resuelto 9 ago, PR #34 + deploy manual del Apps Script:** `vita-demo-formulario` exige aceptar una pantalla de consentimiento antes de cualquier captura, y `consentimiento_ts` ya se guarda en el Sheet — verificado en vivo con un caso de prueba (creado y descartado en el mismo test).
12. ~~Rate limiting real bloqueado por falta de token de Cloudflare~~ **Resuelto 9 ago:** Leonardo proveyó un token de alcance mínimo (`Workers Scripts: Edit` + `Workers KV Storage: Edit`, vía variable de entorno, nunca pegado en la conversación) — primer despliegue directo de un agente de IA en este proyecto (antes siempre requería copiar/pegar a mano en el dashboard). El primer intento de implementación (Cloudflare KV) se probó en vivo y falló (73 peticiones seguidas sin disparar el límite — KV es eventually consistent, no sirve para esto); reemplazado por un Durable Object, verificado en vivo bloqueando exactamente en la petición 31 y sosteniendo el bloqueo. Ver PRs #36-#38.
13. ~~Política de retención/borrado de datos en Sheets sin decidir~~ **Decidida y aprobada 9 ago (pendiente informar a Peter, ajustable después):**
    - Familias reales activas: se conservan mientras estén activas en el programa.
    - Inactividad: 12 meses sin interacción → se marca inactiva; **24 meses sin interacción → purga automática** (backstop de higiene).
    - Solicitud explícita de borrado (ya prometida en la pantalla de consentimiento): se cumple en máximo **30 días**.
    - Casos de prueba: se limpian aparte del ciclo real (`descartar_pendiente` ya existe para pendientes; falta extender la práctica a aprobados de prueba, manual por ahora).
    - Borrado total pedido por la familia → se borra todo, sin guardar un stub de auditoría interno salvo autorización explícita.
    - Es una recomendación operativa razonable, no asesoría legal — antes del piloto de 100 familias conviene una revisión rápida con un abogado colombiano (Ley 1581, Habeas Data), dado que son datos de menores.
    - **Falta implementar en código** (purga automática, borrado por solicitud) — fast-follow, no bloquea nada hoy. Detalle: Notion "[be360 — Camino a TRL 9](https://app.notion.com/p/3b77dac3d7cc81928514d61dc2ca1fe9)".

---

## Convenciones para quien siga desarrollando

- Cambios de código van en rama, PR, y se mergean a `main` — nunca commits directos a `main`.
- **Desplegar el Worker exige estar parado en `main`** (`git checkout main && git pull`) antes de `wrangler deploy` — la causa de casi todos los bugs "fantasma" de este changelog fue desplegar desde una rama vieja.
- Cambios al Apps Script que agreguen funciones nuevas (como `doGet`) requieren desplegar una **nueva versión** de la implementación, no solo guardar el código — las versiones viejas no ven código agregado después de su despliegue.
- No compartir la cuenta de Cloudflare completa con un agente de IA — usar tokens de alcance mínimo (Workers Scripts: Edit) y rotarlos después de cada sesión de trabajo si quedaron expuestos en una conversación.
- **Antes de publicar cualquier archivo con JS embebido, verificar la sintaxis con una herramienta real, no solo revisión visual** — `node --check` para JS plano/Apps Script, transformación con `@babel/standalone` para JSX. Nace de un apagón real de producción (un backtick de estilo markdown dentro de un template literal del prompt rompió el parseo y dejó la página en blanco); desde entonces es un paso obligatorio antes de cada despliegue.
- **`PANEL_SECRET` en `apps-script-formulario-v2.gs.txt` debe generarse siempre como `"1990-I"`** (el PIN real de Peter), nunca como un placeholder de relleno — un placeholder ahí rompe el acceso al panel en silencio cada vez que se vuelve a pegar el archivo completo para una versión nueva.

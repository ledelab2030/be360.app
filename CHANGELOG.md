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
- **Bug de configuración encontrado y corregido:** la plantilla original tenía un valor de `PANEL_SECRET` de relleno (tipo "CAMBIA-ESTO-por-un-pin...") pensado como instrucción, no como valor real — pero cada vez que se volvía a pegar el archivo completo para desplegar una versión nueva, ese relleno pisaba el PIN real ya configurado por Peter, rompiendo el acceso en silencio. **Decisión de entonces:** fijar el PIN real como valor por defecto dentro del archivo, para que nadie volviera a poner un placeholder ahí. *(Superada el 23 ago por el PR #68: los secretos salieron del código a PropertiesService, que resuelve el mismo problema sin publicar nada. El PIN que se usaba entonces estuvo escrito en este CHANGELOG —repo público— hasta el 22 oct, y ya fue rotado.)*
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

### 9-10 ago 2026 — Política de retención de datos: decidida, aprobada y ya implementada (PRs #40, #41, #47)

- Política aprobada por Leonardo el 9 ago: familias activas se conservan mientras usen el programa; 12 meses sin interacción → inactiva; **24 meses → purga automática**; solicitud explícita de borrado → máximo 30 días; casos de prueba se limpian aparte; borrado total no guarda stub de auditoría salvo autorización. No es asesoría legal — pendiente revisión con abogado colombiano (Ley 1581) antes del piloto de 100 familias.
- **Implementado 10 ago:** `purgarInactivos`/`purgarInactivosProgramado` en `apps-script-formulario-v2.gs.txt` — borra casos aprobados con 24+ meses sin actividad conocida (`correo_enviado_ts`, o `timestamp` si no hay), manda resumen al equipo por correo (nombre + fecha, sin datos clínicos). Trigger **instalable** de tiempo, mismo patrón que `onAprobado` — no corre sola hasta que Leonardo la active a mano en Activadores, cero riesgo de borrado accidental mientras tanto.
- El borrado **por solicitud explícita** de una familia sigue siendo manual — no automatizado todavía.
- **Auditoría de respaldo científico del SRB pediátrico** (10 ago, Gemini + `SRB_v0_42.docx` adjunto): de 7 pilares que Gemini marcó como refutados/alto riesgo para niños (ayuno intermitente, dieta carnívora restrictiva, suero salado sin condicionar, meta fija de insulina, eliminación de cardio, biodescodificación, eliminación universal de lácteos), 6 ya estaban excluidos o condicionados por las reglas duras que Peter firmó el 28 jul — nada peligroso circulando hoy. Único matiz pendiente de decisión de Peter: si la moderación de lácteos (hoy "amarillo" para todos) debería depender de indicación médica. Detalle: `CONTEXT.md` (repo `be360-workspace`).

### 10 ago 2026 — be360.app deja de mezclarse con otros productos de LedeLab; home propio en español e inglés (PRs #42, #43, #44, #46)

- **Hallazgo:** `be360.app/` (la raíz) era un quiz de segmentación compartido con Núcleo (agentes IA para empresas) y Javier Institute — dos productos distintos de LedeLab —, diluyendo la marca be360 en su propio dominio, y su camino de "colegio" todavía prometía entrega por WhatsApp (obsoleto desde el 8 ago).
- **Decisión de Leonardo:** Núcleo y Javier Institute se conservan intactos en `/nucleo/` y `/javier-institute/` — nada se pierde, solo se mueven. La raíz se reescribe como home propio de be360/Vita: dos caminos claros (familias → `/talentos`, colegios → captura de interés por correo), honesto con la etapa actual ("en validación con nuestro colegio piloto en Barranquilla", sin cifras inventadas — a diferencia del quiz viejo, que calculaba un "% de estudiantes en riesgo" con supuestos sin validar).
- **Versión en inglés** (`be360.app/en/`): traducción fiel del home, para Geetika (LedeLab Network/Zebira, Delhi) y cualquier visitante de habla inglesa. Selector de idioma ES⇄EN en ambas versiones.
- **Correos de contacto → Leonardo** (`leonardo@bienestar360.co`, ya no `peter@`): Peter no lee inglés, y en general los correos de los sitios deben llegarle a Leonardo. Aplicado en todo — home ES/EN, pantallas de consentimiento de Vita ES/EN.
- **Paleta de colores del logo** actualizada a la descrita en el diseño real (`#0A1F44` navy / `#4A7045` verde / `#5D8AA8` azul acero / `#A0A0A0` plata para "Health-Tech") — el archivo de imagen real queda pendiente de que Leonardo lo comparta (no se pudo extraer directo del chat).

### 10 ago 2026 — Vita completo en inglés (PR #45)

- Traducción fiel y completa de la herramienta real (no solo el home): prompt clínico completo, las 14 áreas de captura, protocolo de seguridad, marcador de escalamiento, cambio de modo, pantalla de consentimiento, validación de suficiencia, toda la UI — en `en/vita-demo-formulario/`.
- Se mantienen IGUALES las keys de `dx`, los códigos de `<escalar>`, y `producto:"formulario"` (contrato con el backend — las capturas en inglés van al mismo Sheet/panel; Peter revisa en español, una captura real en inglés se vería en inglés en su panel, señalado no resuelto).
- `RIESGO_PATTERNS` (respaldo de seguridad determinístico) tiene su propia lista de frases en inglés — el regex en español no habría detectado ninguna señal de un padre de habla inglesa.
- De paso: corrige una referencia a WhatsApp que quedó sin arreglar en el prompt real de la versión en español ("Esto es WhatsApp, no un informe" → "Esto es un chat corto, no un informe").
- No enlazado desde ningún home público — mismo criterio de siempre (sin control de acceso por usuario todavía), se comparte como enlace privado.

### 10 ago 2026 — Verificación de cobertura de las 24 horas del día antes de enviar (PR #49)

- **Hallazgo de Leonardo:** `cronologia_del_dia` es un solo campo de texto libre — un padre puede dejarlo con huecos sin darse cuenta, lo cual puede generar rechazo de Peter al revisar un caso.
- En vez de reestructurar el campo en 7 sub-campos (más engorroso de llenar), se detecta por palabras clave si el relato menciona los 7 momentos clave del día (al levantarse, desayuno, media mañana, almuerzo, media tarde, cena, antes de dormir). Si falta alguno, `sendToReview()` se detiene ANTES de enviar y muestra un panel de confirmación — el padre completa, o confirma explícitamente que no sabe / no quiere compartir esos momentos todavía, con una nota honesta sobre la consecuencia real (plan inicial más general, puede tardar más encontrar qué le afecta al niño/a), sin culpar.
- Si confirma, el hueco queda **anotado en el mismo texto que ve Peter** — nunca como un silencio ambiguo. Verificado en vivo: caso de prueba con 3 momentos faltantes detectados correctamente, confirmado, y el texto guardado en el Sheet incluye `[Sin dato o no compartido aún: Media tarde, Cena, Antes de dormir]`.
- Sin cambios de backend — sigue viajando como un solo string, cero riesgo para Sheet/Apps Script/Prompt Maestro. Aplicado en ambos idiomas (ES y EN), cada uno con su propia lista de palabras clave.

---

### 10 ago 2026 — Confirmación de email antes de enviar + navegación hacia atrás (PR #52)

- **Hallazgo de Leonardo, con screenshot real de una prueba en vivo:** un correo mal escrito (`leonardodelahozb@gmail.com`) se guardó sin ningún punto de confirmación o corrección — y como ya no hay WhatsApp (ver punto 2 de pendientes), el correo es el ÚNICO canal de entrega. Un typo ahí deja a la familia sin forma de recibir su plan, y sin que nadie se entere del error.
- `PanelCobertura` (el panel de la cobertura del día, PR #49) se reemplaza por `PanelRevisionFinal`: se muestra SIEMPRE antes de enviar, con el correo de contacto editable ahí mismo y validado con formato básico (bloqueo duro del botón solo si el formato es inválido). La cobertura del día sigue siendo un aviso suave dentro del mismo panel — informa la consecuencia, nunca bloquea.
- Se agregan botones `← Volver` en el formulario directo, la pantalla de intro y el encabezado del chat — el padre puede regresar al inicio desde cualquier punto del recorrido. Aplicado en ES y EN.

### 10 ago 2026 — Verificación de código de colegio antes de aprobar (PR #53)

- Sistema de elegibilidad por colegio: al guardar el borrador, el padre recibe un correo pidiéndole el código que le dio su colegio para el programa (`verificar/index.html`, página standalone en vanilla JS — no justifica el peso de React/Babel para una sola pregunta).
- Sin ese código confirmado, Peter **no puede aprobar** el plan — bloqueo duro en `aprobarPlan` (backend), reforzado con un badge visible + aviso explicativo en `panel/index.html` (mismo patrón que el badge de consentimiento).
- Si no se confirma en 72 horas, la información capturada se purga automáticamente (`purgarNoVerificados` + trigger programado) — mismo patrón "nunca silencioso" que la purga por inactividad (punto 13 de pendientes), con aviso al equipo por correo.
- Ruta nueva `/verificar` en el Worker, reutiliza `handlePanelAction` sin secreto nuevo de Cloudflare. **Pendiente antes de operar con familias reales:** reemplazar el código de ejemplo (`BIS2026`) en `CODIGOS_VALIDOS_COLEGIO` por el código real del colegio.

### 13 ago 2026 — Tres correcciones salidas de la primera prueba en vivo con Peter (PRs #55, #56, #57)

- **PR #55 — Hotfix: el panel bloqueaba aprobar TODOS los casos.** Bug en producción encontrado por Leonardo con el caso de Lucas. El panel asumía que el backend siempre manda `verificacionTs`; como el Apps Script nuevo todavía no estaba desplegado, el campo no existía, y `undefined` es falsy igual que `''`. El panel lo leyó como "no verificado" y escondió el botón de aprobar para todos los pendientes, incluidos casos reales. Se arregla distinguiendo "el campo no existe todavía" de "existe y está vacío". **Lección que se repite en este proyecto:** el frontend se publica solo al hacer merge, el Apps Script no — entre los dos hay una ventana donde el sistema corre con mitad nueva y mitad vieja.
- **PR #56 — El panel escondía el error real.** Peter intentó aprobar el caso de Lucas varias veces y siempre vio "No se pudo aprobar. Reintenta.". El motivo real era correcto y esperado (ese caso nunca pasó por verificación de código), pero el panel descartaba el mensaje del backend en 5 lugares a favor de un texto genérico. Ahora muestra el mensaje real y deja el genérico solo como respaldo.
- **PR #57 — El correo de plan aprobado ahora trae el plan, no solo el link.** Encontrado en la misma prueba: un correo con solo un enlace se sentía como que "no llegaba el plan". El cuerpo pasa a incluir el mensaje de Vita y los hábitos numerados, respetando los que Peter excluyó.

### 14 ago 2026 — Retos de bienestar, apagados por defecto (PR #58)

Primera porción del add-on de gamificación, diseñado explícitamente para no chocar con los principios del producto: sin ranking, sin racha rota, sin comparación entre familias. Doble opt-in — la sección solo se renderiza si el enlace trae `?retos=1`, y además hay un interruptor interno. Sin la bandera React ni siquiera lo monta, así que un padre curioso mirando el HTML no vería nada.

### 15 ago 2026 — Panel de colegio y los bugs que destapó construirlo (PRs #59, #60, #61, #62, #63, #64)

- **PR #59 — Dashboard de solo agregados para el rector o delegado.** Nunca un caso individual, con umbral de privacidad n≥5 antes de mostrar cualquier desagregado. **El porqué del umbral importa:** en varios colegios el rector también es padre de una familia inscrita y conoce personalmente a las demás. Un agregado de "1 de 3" no es anónimo para esa persona aunque no tenga nombres.
- **PR #60 — PIN real para el panel de colegio**, reemplazando el placeholder del #59.
- **PR #61 — Unifica el 401 entre ambos paneles.** El Worker decidía el código HTTP comparando el texto exacto del error, hardcodeado solo para el panel de Peter; cualquier acción nueva con su propio mensaje caía en 400. Se reemplaza por un campo estructurado `unauthorized:true`.
- **PR #62 — `guardarBorrador` ya no pisa un `id_plan` existente.** Bug real, no cosmético: al crear casos de prueba se llamó `guardar_borrador` mientras la generación automática todavía corría para el mismo `ts`. La segunda llamada generó un `id_plan` nuevo y reseteó `decision`, **borrando en silencio una aprobación ya hecha**.
- **PRs #63 y #64 — Proyección del panel de colegio (mockup).** Cómo se vería el panel al cabo de un año completo, con las piezas que hoy faltan: adherencia, medido-vs-reportado, kit, feedback de médico externo. Vive en una carpeta aparte, sin ningún `fetch`, imposible de confundir con datos reales. El #64 lo rediseña a una interacción con scrubber de mes en vez de scroll plano.

### 19 ago 2026 — Códigos para la ronda de validación (PRs #65, #66)

Cinco códigos distintos de `BIS2026` a propósito: esas personas no eran necesariamente familias del BIS y no debían contaminar el agregado real del colegio. El #66 agrega `DSB2026` y corrige un error propio — un intento de poner el nombre real de la primera validadora en un comentario. **El repo es público; eso no puede pasar.**

### 23 ago 2026 — Consentimiento de investigación y secretos fuera del código (PRs #67, #68)

- **PR #67 — Casilla separada y opcional para investigación.** Desmarcada por defecto, no condiciona el acceso al plan, nunca menciona IA ni tecnología.
- **PR #68 — Los 3 secretos salen del código a PropertiesService.** `PANEL_SECRET`, `SHARED_SECRET` y `PANEL_COLEGIO_SECRETS` estaban en texto plano en un repo público, expuestos desde que existían. Efecto colateral bueno: pegar una versión nueva del Apps Script ya no puede pisar el PIN real por accidente. **Nota para el futuro:** `CODIGOS_VALIDOS_COLEGIO` se quedó por fuera de esta migración y siguió expuesto dos meses más — se corrigió recién el 21 oct (PR #91).

> **Pausa de 16 días (23 ago → 8 sep).** El trabajo que siguió (PR #69) responde a un pedido que Peter hizo en la reunión del **19 de agosto**: la petición existía desde antes de la pausa, o sea que no se estaba esperando a Peter.

### 8 sep 2026 — Horarios de verdad, no solo menciones (PR #69)

Responde al pedido explícito de Peter en la reunión del 19 de agosto: las recomendaciones le llegaban demasiado genéricas porque el formulario solo garantizaba que se mencionara cada momento del día, no que trajera la hora. `coberturaDia()` pasa a exigir un patrón de hora cerca de cada mención, y distingue "no mencionado" de "mencionado sin hora" — el padre ve la diferencia antes de enviar.

> **Pausa de 8 días (8 sep → 16 sep).** Mismo motivo que las demás pausas de este período, según Leonardo (22 oct): atención jalada a monetización, no falta de disponibilidad de Peter.

### 16 sep 2026 — Transparencia con el colegio y el primer intento contra lo genérico (PRs #70, #71)

- **PR #70 — El consentimiento decía algo que ya no era cierto.** Decía "no la compartimos con nadie más", pero desde que existe el panel de colegio sí se comparten agregados anónimos. Se agrega ese punto explícito y se publica `/terminos`.
- **PR #71 — Bloque de ESPECIFICIDAD en el prompt + modelo a Sonnet 5.** Ataca la queja de Peter de que las recomendaciones salen "muy genéricas", retomada de la reunión del 19 ago. **Este PR causó un daño que tardó dos semanas en descubrirse** — ver PR #75.

### 18 sep 2026 — Menos repetición en el consentimiento (PR #72)

El bloque de investigación repetía casi la misma frase en la caja y en la etiqueta de la casilla. Se condensa.

> **Pausa de 6 días (18 sep → 24 sep).** Mismo motivo (ver arriba).

### 24 sep 2026 — La lonchera que la familia no controla (PR #73)

Pedido de Peter en la reunión del 16 sept: la merienda escolar es el punto real de fricción, porque la familia no controla lo que vende la cafetería del colegio. La captura ahora pregunta si la lonchera se manda de casa o se compra, y el prompt deja de asumir control directo cuando se compra.

> **Pausa de 8 días (24 sep → 2 oct).** Mismo motivo (ver arriba).

### 2 oct 2026 — Sesión larga con Peter: 12 PRs en un día (PRs #74 a #86)

El día más denso del proyecto. Casi todo salió de pedidos en vivo durante la sesión.

- **PR #74 — Marcador discreto de versión** (`PR#n · AAMMDD`) en la esquina, para saber qué versión se está probando sin mirar el código.
- **PR #75 — Se revierte el modelo a `claude-sonnet-4-6`.** Causa raíz encontrada y reproducida: Sonnet 5 gastaba buena parte del límite de 2000 tokens razonando antes de escribir, la respuesta salía truncada, el JSON se rompía y **el borrador nunca se guardaba — el caso quedaba invisible en el panel de Peter, sin ninguna alerta.** Introducido sin querer el 16 sept en el PR #71. Es la primera aparición de un patrón que se repite: *esta parte del sistema falla en silencio por diseño, y por eso los errores aquí tardan semanas en verse.*
- **PR #76 — `MODO_PRUEBAS`.** Permite a Peter aprobar sin que la familia haya verificado el código de colegio. Pensado para que la sesión en vivo no se trabe esperando a que alguien revise su correo. **Sigue activo.**
- **PR #77 — El panel tenía su propio bloqueo, además del backend.** Aunque el backend ya no exigía verificación, el frontend ni siquiera mostraba el botón. El backend queda como única fuente de verdad.
- **PR #78 — Español latinoamericano estándar y mensajes concisos.** Pedido de Peter en vivo.
- **PR #79 — `coberturaDia` revisaba solo la primera mención.** Encontrado en vivo con el caso de Samuel.
- **PR #80 — `SRB_PROMPT_VERSION`.** Trazabilidad de los cambios al prompt, distinguiendo los clínicos (que Peter debe ratificar) de los de voz.
- **PR #81 — Se quita el tope de 20 años.** Investigado y confirmado contra la realidad de extraedad y CLEI en Colombia, donde hay estudiantes matriculados bien entrados los 20.
- **PR #82 — Se oculta el aviso de código sin verificar** mientras dure `MODO_PRUEBAS`.
- **PR #83 — Enlace de prueba aparte para el SRB pediátrico v2.** Decisión importante de arquitectura: en vez de cambiar el prompt de producción (que Peter no había aprobado), se crea `vita-demo-formulario-v2/` con el mismo formulario y un `producto` distinto, que selecciona otro prompt. Producción sigue intacta.
- **PR #84 — El panel muestra la pregunta exacta que vio el padre**, no solo la etiqueta corta.
- **PR #85 — `FIELDS` se unifica en `shared/formulario-fields.js`**, para que formulario y panel no se desincronicen.
- **PR #86 — Cada caso guarda su propio snapshot de preguntas.** Así, si mañana cambia un texto del formulario, los casos ya generados siguen mostrando la pregunta que el padre realmente respondió.

> **Pausa de 19 días (2 oct → 21 oct) — la más larga del proyecto.** Motivo, según Leonardo (22 oct): su atención estuvo jalada a temas de monetización. No fue falta de disponibilidad de Peter. El trabajo se retoma con una reunión grabada con Peter, en dos partes, donde revisa borradores generados y da retroalimentación clínica.

### 21 oct 2026 — Reunión con Peter, parte 1: el panel y la estructura del plan (PRs #87, #88)

- **PR #87 — Vista dividida en el panel**, formulario a la izquierda y borrador a la derecha, con la ventana de texto más grande. Pedido de Peter en vivo: revisar un caso obligaba a recordar lo que decía el formulario mientras se editaba el plan.
- **PR #88 — HOTFIX.** El #87 quitó un estado del componente pero dejó una referencia suelta, y **abrir cualquier caso reventaba en producción**. Encontrado leyendo la consola del navegador después de desplegar, corregido en el mismo turno.

### 21-22 oct 2026 — Reunión con Peter, parte 2: el problema de fondo (PRs #89 a #97)

Peter encontró que Vita afirmaba cosas clínicas **que no existen en el SRB** — una dosis de sal, una sugerencia de magnesio y vitamina D. La causa no era que el sistema "buscara en internet" (nunca tuvo esa capacidad): el prompt solo llevaba una paráfrasis del SRB, así que el modelo rellenaba los huecos con su conocimiento general de nutrición, y las citas tipo "(SRB §3)" solo señalaban un tema, no una fuente.

- **PR #89 — SRB pediátrico v4: fuente verbatim.** El texto literal del SRB (secciones 6.2, 6.4, 7, 7.1, 8 y 10.1) pasa a vivir dentro del prompt, con la regla de que nada se afirma si no está ahí, y las adaptaciones pediátricas encima (suero a 2 g/L y no 5-7, sin metas numéricas de carbohidratos ni insulina, sin el pilar de ayuno, sin fuerza estructurada). También: el ROJO del semáforo pasa a ser firme, silencio total sobre medicamentos que reporte el padre, y prohibido celebrar lo que ya está bien. Y la ventana de alimentación deja de confiarse al modelo — escribió "aproximadamente 12 horas" sobre una ventana real de 11h45, redondeando justo para parecer que cumplía.
- **PR #90 — La generación se muda a una alarma de Durable Object.** Al probar el camino real se descubrió que **el enlace pediátrico nunca generó borradores automáticamente.** Cloudflare cancela las tareas de `ctx.waitUntil` ~30s después de responder, y la generación pediátrica tardaba 38.7s antes y 70.8s con el v4 (medido). La fila se escribía en el Sheet, el borrador nunca se guardaba, y el caso quedaba invisible en el panel. Estuvo tapado porque todos los borradores pediátricos hasta entonces se habían generado con scripts locales.
- **PR #91 — Se quita la fricción del código de colegio durante `MODO_PRUEBAS`.** Leonardo había pedido quitar esos códigos dos meses antes; reaparecieron al pasar a producción lo que corría local, sin volver a preguntarse si debían existir en esta etapa. El control que sí sirve ya existía: nada se entrega hasta que el equipo apruebe. De paso, los códigos salen del repo público a PropertiesService y se desacoplan del identificador del colegio.
- **PR #92 — La página del plan era casi ilegible.** El CSS colapsaba los saltos de línea y el markdown salía crudo: 24 asteriscos visibles y cero negritas en la página que abre el padre. El correo llevaba el mismo problema. También se quita `peter@bienestar360.co`, que rebotaba en cada aprobación.
- **PR #93 — El correo de contacto pasa a `leonardo@ledelab.group`.** El dominio `bienestar360.co` está bloqueado por facturas vencidas, y esa dirección aparecía en el consentimiento como el canal para **pedir borrado de datos**, con promesa de responder en 30 días. Un compromiso sobre datos de menores que no se podía cumplir.
- **PR #94 — Revisión de textos pantalla por pantalla + guardado en el dispositivo.** El recorrido toma unos 20 minutos en el celular y no guardaba nada: una recarga o un cambio de app borraba todo. Además, la pantalla de bienvenida seguía con el copy original del 5 de agosto, que le pedía algo al padre antes de presentarse.
- **PR #95 — "Ayuno" se coló en un plan pediátrico.** El borrador de Samuel decía "el ayuno nocturno no es opcional", copiado literal de la fuente embebida en el #89: **el arreglo de las alucinaciones creó esta fuga.** También: el modelo le narraba sus propias reglas al padre ("corrección de ventana: queda por debajo del mínimo de 12 horas").
- **PRs #96 y #97 — Revisión automática antes de que el borrador llegue al panel.** Dos capas: reglas duras por código (palabras prohibidas, reglas narradas, formato interno, cifras de adulto) que regeneran una vez indicando qué corregir, y un verificador que compara el borrador contra la fuente SRB y señala afirmaciones sin respaldo. Lo que falla se guarda igual, marcado, nunca se descarta. El #97 corrige un error del #96: el verificador marcaba como inventos los 2 g de sal y la ventana de 12h, que son adaptaciones pediátricas deliberadas — habría puesto dos avisos falsos en cada plan y Peter habría dejado de leerlos. En la misma prueba el verificador encontró una invención real: un plan recetaba "pantallas apagadas 45 minutos antes de dormir", y el SRB no menciona pantallas ni sueño en ningún apartado. *(Matiz encontrado al leer las reglas duras firmadas el 22 oct: la sección A.3 lista el manejo de pantallas como territorio siempre seguro. El tema sí está permitido; lo inventado es el número. El verificador no conoce las reglas firmadas, solo el extracto del SRB — ver "Pendientes conocidos".)*

### 22 oct 2026 — Se corrige el encuadre de las pausas (PR #99)

Al registrar los 43 PRs faltantes, el agente infirió de las fechas que las pausas del proyecto eran los intervalos entre sesiones clínicas con Peter, y lo escribió como hallazgo. **Era falso.** Leonardo lo corrigió al entregar la reconstrucción del chat de estrategia: Peter está disponible normalmente una sesión por semana o más, y los huecos recientes se debieron sobre todo a que la atención de Leonardo estuvo jalada a temas de monetización.

Importa porque esa conclusión cambia qué hay que destrabar: no la agenda de Peter, sino sostener el foco en la validación. Y porque este archivo alimenta material para grants e inversionistas.

Se corrigen los cinco marcadores de pausa (los cuatro que pedían completar el motivo ya lo tienen) y el patrón 1 de la sección de cierre. Queda como recordatorio de método: **una correlación leída de fechas no es una causa, y no debía presentarse como hallazgo sin confirmarla con quien vivió el período.**

### 22 oct 2026 — Pendiente #18 (verificador de grounding) estaba desordenado y no era visible en el informe (PR #101)

Al verificar el informe de ejecución contra el CHANGELOG real, se notó que el pendiente del verificador de grounding (añadido en el PR #100 al reconciliar `CLAUDE.md`) había quedado como punto **18 pero ubicado antes del 17**, rompiendo el orden secuencial de la sección "Pendientes conocidos". El contenido ya existía; solo el orden estaba mal. Se corrige el orden (16 → 17 verificador de grounding → 18 validación con familias reales) para que la lista se lea de arriba a abajo sin saltos, y para que quede claro que el hueco del verificador es un pendiente visible, no un detalle enterrado entre otros dos.

### 22 oct 2026 — CLAUDE.md reconciliado con el producto real (PR #100)

El archivo de instrucciones de desarrollo describía un producto que ya no era el que se está construyendo. Apuntaba a `vita-demo-srb-3` como el demo activo, daba el HITL como "en construcción" (lleva meses funcionando), conservaba el rango de 2 a 20 años que se quitó en el PR #81, y hablaba de entrega por WhatsApp y de una arquitectura anterior. Quien llegara nuevo al repo y lo leyera, empezaría en el lugar equivocado.

Lo señaló la reconstrucción del sprint del 22 oct como tarea explícita de este repo. Ahora describe el producto del piloto —formulario, panel, plan, correo—, la arquitectura real incluida la alarma del Durable Object, las reglas duras firmadas con su origen, las convenciones de trabajo, la tabla de despliegue con sus trampas, y el estado con los pendientes que condicionan cómo se trabaja hoy.

Cada afirmación técnica se verificó contra el código antes de escribirla: el modelo en uso, la clase del Durable Object, el 403 de `doGet`, `MODO_PRUEBAS`, el suero a 2 g/L, el v4 marcado experimental, el rango de edad, y que producción y el enlace de validación siguen difiriendo en exactamente cuatro lugares.

### 26 oct 2026 — Reunión con Peter revisando el caso de Sofía: seis reglas clínicas nuevas y la hora de dormir pasa a ser un dato obligatorio (PR #102)

Minuta completa de la reunión en `pruebas/` (repo privado). Peter revisó el borrador real de Sofía (9 años) generado por el enlace de validación y corrigió seis cosas sobre el semáforo de alimentos, más una pregunta de arquitectura que Leonardo hizo en vivo sobre la captura conversacional: si la hora de dormir (dato necesario para una de las reglas nuevas) se puede exigir de verdad en el chat sin convertirlo en un cuestionario rígido.

**`worker/vita-proxy.js` — seis reglas nuevas en `ADAPTACIONES_PEDIATRICAS` (afectan solo el generador pediátrico v2/experimental, `SRB_DRAFT_PROMPT_PEDIATRICO_V2`, usado por `vita-demo-formulario-v2/`; el prompt de producción `SRB_DRAFT_PROMPT` no se tocó):**
- **Verduras y ensaladas:** la fuente SRB no las mencionaba en la tabla INCLUIR/ELIMINAR, lo que dejaba criterio libre al modelo — en el plan real de Sofía se coló "ensalada y pepino" como recomendación en el mismo documento que los ponía en rojo. Ahora es explícito: cruda/en ensalada → rojo (celulosa indigerible, residuos de pesticidas, solanáceas crudas incluidas); bien cocida y solo como adobo → amarillo; nunca verde.
- **Quesos — la excepción se estrecha:** la fuente decía "quesos envejecidos (excepción láctea)" de forma genérica. Ahora la única excepción real es queso azul o roquefort (por el *Penicillium roqueforti*); cualquier otro queso "envejecido" (parmesano, manchego, etc.) se trata como lácteo no madurado: rojo.
- **Carbohidratos del semáforo amarillo:** siempre de acompañante de la proteína y la grasa, nunca como base del plato ni solos ni como merienda.
- **Chatarra explícita en rojo:** helados y salchipapas, que estaban cayendo en amarillo por no estar en la fuente.
- **Regla de oro de la lonchera:** si hay 3 comidas principales completas, por defecto no se merienda; si hace falta lonchera, solo nueces + electrolitos, cero carbohidratos ni galletas dulces.
- **Mínimo 3 horas entre la última comida y la hora de dormir — misma cifra para adultos y para niños.** Es una regla distinta de la ventana de 12h ya existente (esa mide cuánto dura el período comiendo; esta mide cuánto descansa el cuerpo antes de dormir). "No comer después de las 6pm" de la fuente queda como el resultado práctico de esta regla para un niño que se duerme a las 9pm, no como un horario de reloj fijo.

**Verificación por código de la regla de las 3 horas (mismo patrón que `horasDeVentana`/`MIN_VENTANA_HORAS`, ya existente):**
- Nuevo campo `"horaDormir":"<HH:MM>"` en el JSON que devuelve el generador, con instrucciones de cálculo explícitas (igual rigor que las de la ventana: no narrar el ajuste al padre, recalcular antes de escribir, "00:00" como centinela de "sin dato").
- `MIN_HORAS_CENA_DORMIR = 3` y `horasAntesDeDormir(ventanaPropuesta, horaDormir)`, que resta por código en vez de confiar en la resta del modelo. **Bug real encontrado probando esta función antes de desplegarla:** a diferencia de la ventana (donde el centinela "00:00" vive en los cuatro campos a la vez), `horaDormir` es un campo independiente — con una implementación ingenua, "18:00" (comida real) menos "00:00" (sin dato) da 6 horas en vez de "sin dato", y el chequeo habría tratado una ausencia de hora de dormir como si fuera una hora real a medianoche. Se corrigió comparando el centinela explícitamente contra cada campo por separado, no por el resultado de la resta. Verificado con 8 casos de prueba (incluido el caso real de Sofía: cena 6pm/duerme 9pm → exactamente 3h, pasa; el horario viejo de cena 7pm → 2h, viola la regla correctamente).
- `revisarBorradorPediatrico()`: dos chequeos nuevos — detecta "queso madurado/envejecido" genérico (la fuente todavía usa ese término, así que un borrador puede heredarlo sin querer) y detecta la palabra "ensalada" (verdura cruda, debería ser imposible que aparezca como recomendación con la regla nueva). Ambos probados contra casos reales y falsos positivos ("queso azul" no dispara nada).
- Verificación de sintaxis con `node --check` antes de este commit.

**Captura conversacional (`vita-demo-formulario/index.html` y `vita-demo-formulario-v2/index.html`, cambio idéntico en los dos — siguen diferenciándose en exactamente los mismos 4 lugares de siempre: marcador de versión, un comentario, `GUARDADO_KEY` y el campo `producto`):**
- **Pregunta de Leonardo en vivo:** ¿se puede exigir de verdad la hora de dormir en el chat conversacional sin perder la experiencia conversacional y volver todo cuestionario? Respuesta, implementada: sí, con un candado determinístico en el código, no dependiendo de que el modelo se acuerde de insistir.
- `sueno_y_movimiento` (donde se pregunta la hora de dormir, área 3 del chat) era un campo opcional entre otros 9, sin verificar que trajera una hora real — un padre podía enviar sin que esa hora quedara nunca registrada, haciendo imposible aplicar la regla de las 3 horas. Nuevo: `tieneHoraDormirReal()` y `faltanDatosDuros()` — la hora de la cena (reutilizando `coberturaDia()`, ya existente) y la hora de dormir pasan a ser datos duros. `puedeEnviar()` ahora bloquea el botón "Enviar a revisión" de verdad (no solo una advertencia bypasseable) si falta cualquiera de las dos.
- **Bug real encontrado probando el candado antes de desplegarlo:** `TIME_PATTERN`, el regex que detecta si hay una hora cerca de una mención ("cena", "duerme"), exigía un dígito de minutos para reconocer una hora — "9pm" o "a las 7pm" (sin espacio ni minutos, forma muy común de escribir la hora) nunca calzaban. Mientras el chequeo era solo informativo esto pasaba casi desapercibido; con el candado nuevo bloqueando el envío, un padre que SÍ había dado la hora podía quedar atascado sin poder enviar. Corregido: ahora son tres alternativas (hora+minutos opcionales+meridiano obligatorio, para "9pm"/"9:00pm"; hora:minutos con separador sin meridiano, para "21:00"/"6:45"; "a la/a las"+número en palabra o dígito, igual que antes). Este fix mejora también `coberturaDia()`, que ya existía, no solo el candado nuevo.
- **Texto visible para el padre — la única pieza visible de todo este cambio:** el mensaje dinámico "Aún falta: ..." (ya existía) ahora puede incluir "la hora de la cena" y "la hora en que se duerme" cuando corresponda, usando la misma construcción que ya tenía (unir con "y" lo que falte) — ningún campo, etiqueta, pantalla, formato ni presentación se tocó. Confirmado explícitamente con Leonardo: no se modificó ningún enunciado de `shared/formulario-fields.js` ni las pantallas de bienvenida/consentimiento.
- También se reforzaron (no son texto visible, son instrucciones al modelo que guían la conversación, no una pantalla) las áreas 3 y 6 del prompt de Vita, pidiéndole insistir una vez más con una pregunta cerrada si la respuesta sobre la hora de dormir o de la cena es vaga, antes de seguir — redacción propia, no textual de la minuta, confirmada con Leonardo antes de dejarla.
- Verificado de punta a punta en navegador real (servidor local, no solo revisión visual): botón se deshabilita con hora vaga ("se duerme tarde, no sabría decir bien la hora") y se habilita al dar una hora real, incluyendo el caso que rompía antes del fix ("a las 9pm", sin espacio). `node --check` en ambos archivos.

**No forma parte de este cambio (fuera de alcance, documentado aparte):** las seis reglas clínicas también se incorporan al documento de referencia pediátrico (`pruebas/2026.10.26-srb-pediatrico-v6-borrador-local.md`, repo privado — todavía sin publicar a Google Drive, pendiente de revisión de Leonardo) y a `design-sprint/docs/reglas_duras_srb.md` como addendum I (NO FIRMADO, mismo patrón que los addendums G y H — pendiente de que Peter lo ratifique).

**Pendiente tras el merge:** desplegar el Worker (`wrangler deploy` desde `worker/`, parado en `main` actualizado) — el frontend publica solo vía GitHub Pages, pero el Worker no, y las reglas nuevas no toman efecto en producción hasta ese paso manual.

### 26 oct 2026 — El PR #102 se desplegó, se probó con un caso real, y la prueba encontró un error real de dirección en la ventana de alimentación que llevaba viva desde el 21 de octubre (PR #103)

**Despliegue y prueba real.** Tras mergear el #102, se corrió `wrangler deploy` (Version ID `b3cc882e-2ae7-4b40-919b-12dd8647aa3c`) y, a pedido de Leonardo, se llenó un caso de prueba real en `vita-demo-formulario-v2/` (producción, no local) diseñado para disparar cada regla nueva: ensalada cruda, queso parmesano, helado, lonchera con galletas, y una cena a 1h30 de la hora de dormir. Leonardo revisó el resultado en `panel/index.html` (el agente no tiene el PIN) y confirmó las seis reglas funcionando — incluida la autocorrección en vivo: el borrador movió la cena de 7:30pm a 6:00pm para cumplir las 3 horas antes de dormir (9pm). La revisión automática marcó además "la ventana queda en 11h30, por debajo del mínimo de 12 horas" — un aviso que resultó ser el síntoma de un bug, no un caso real a resolver (ver más abajo).

**El bug: la ventana de alimentación estaba al revés desde el 21 de octubre (PR #89).** Leonardo lo detectó al revisar ese aviso: la ventana de alimentación (primera a última comida) **es un máximo de 12 horas, no un mínimo** — el código y el prompt decían justo lo contrario desde hace cinco días, sin que nadie lo hubiera notado porque ningún caso de prueba anterior había quedado tan cerca del límite. Dicho desde el otro extremo del día (es la misma regla): el espacio entre la última comida de hoy y la primera de mañana debe ser de al menos 12 horas — si el día se repite, ventana ≤ 12h equivale exactamente a espacio nocturno ≥ 12h. Con la dirección corregida, la tensión que parecía existir entre esta regla y la de las 3 horas antes de dormir (PR #102) desaparece por completo: las dos reglas limitan la última comida por el mismo lado (que no sea tarde), nunca pueden pedir cosas incompatibles.

**Cambios en `worker/vita-proxy.js`:**
- `MIN_VENTANA_HORAS` (rechazaba ventanas *cortas*) se renombra a `MAX_VENTANA_HORAS` y el chequeo en `evaluar()` se invierte: ahora rechaza ventanas que *superan* las 12 horas, no las que quedan por debajo.
- El párrafo de `ADAPTACIONES_PEDIATRICAS` que introdujo la regla originalmente (21 oct) y toda la sección "CÁLCULO DE LA VENTANA DE ALIMENTACIÓN" del prompt (instrucciones de redondeo, de hacia qué lado mover la última comida, y las frases prohibidas de narración) se reescriben con la dirección correcta.
- El verificador de grounding (el que compara el borrador contra la fuente) también decía "ventana de 12 horas o más es correcto" — se corrige a "o menos", si no habría empezado a marcar como invención justo los borradores que ahora sí cumplen la regla real.
- `revisarBorradorPediatrico()`: el regex que detecta narración interna ("mínimo de 12 horas", "por debajo del mínimo"...) se amplía con las variantes "máximo"/"por encima del máximo", porque ahora el riesgo de narración corre en la otra dirección.

**Los 5 pendientes del punto 1 de la minuta del 26 oct ("Ajustes al prompt de Vita"), que se habían quedado sin implementar en el PR #102 — encontrado porque Leonardo volvió a preguntar por ellos, no porque el agente los recordara solo:**
- **Ocultar referencias internas / eliminar muletillas "Según el SRB":** la sección TRAZABILIDAD del prompt pedía literalmente lo contrario — citar "(SRB — ...)" al final de cada hábito. Se invierte: la trazabilidad sigue siendo un chequeo interno obligatorio (nada se escribe sin poder señalar de dónde sale), pero la cita nunca llega al texto que ve el padre. Se agrega un chequeo nuevo en `revisarBorradorPediatrico()` que detecta "(SRB —", "según el SRB" o la palabra "SRB" sola en el texto visible.
- **Instrucciones prácticas de medición:** nueva regla en `ADAPTACIONES_PEDIATRICAS` pidiendo formas concretas de explicar los 2 g de sal por litro (sobre de 1g de Makro, cuchara medidora, gramera de cocina) en vez de "una pizca generosa".
- **Limón "al gusto":** nueva regla explícita — a diferencia de la sal (siempre medida), el limón del suero casero no lleva cantidad fija.
- **Tono consultivo en el seguimiento (`plan/index.html`):** el mensaje que abre la conversación de seguimiento preguntaba directamente "cómo les ha ido con alguno de los hábitos" — exactamente el tono proactivo/invasivo que la minuta pidió evitar. Se cambia a un saludo consultivo ("¿en qué te puedo ayudar?"), dejando que el padre/madre lleve la conversación. Se refuerza también en la sección `# TONO` del prompt de seguimiento.

**Verificación:** `node --check worker/vita-proxy.js`; `plan/index.html` verificado vía Babel en navegador real (servidor local) sin errores de sintaxis; pruebas unitarias standalone de `horasDeVentana()`/`MAX_VENTANA_HORAS` con los números reales del caso de prueba (11h30 ahora cumple, antes violaba) y del regex nuevo de referencias al SRB (sin falsos positivos contra "Sistema de Reversión Biológica" escrito completo).

**También corregido (no es código):** `design-sprint/docs/reglas_duras_srb.md` (addendum I) y el borrador local del documento de referencia pediátrico (`pruebas/2026.10.26-srb-pediatrico-v6-borrador-local.md`, repo privado, todavía sin publicar a Drive) — ambos tenían la misma dirección equivocada de la ventana y la misma omisión del limón, y se corrigen igual.

### 27 oct 2026 — Descargar el plan en PDF, desde `plan/` y desde `panel/` (PR #105)

Pedido de Leonardo. Tres decisiones de alcance confirmadas antes de escribir código (dónde, qué contenido, cómo se genera): los dos lugares (familia y Peter), todo lo que se ve en pantalla (mensaje completo + checklist, no solo el checklist), y en el navegador con jsPDF — sin tocar el Worker ni agregar infraestructura nueva, consistente con "páginas estáticas sin build".

- **`plan/index.html`:** botón "Descargar PDF" junto al encabezado del plan ya aprobado. Genera el PDF a partir de `data.mensaje` + `habitos` (ya vienen filtrados a solo los incluidos, por `doGet` en Apps Script).
- **`panel/index.html`:** mismo botón en el detalle de un caso. A diferencia de `plan/`, acá `habitos` incluye también los excluidos (para que Peter pueda reconsiderar antes de aprobar) — el PDF filtra a `incluido !== false` para reflejar lo que de verdad recibiría la familia, no el estado de edición interno del panel.
- El código de generación (`pdfEscribirParrafo`, `descargarPdf`) está duplicado en los dos archivos a propósito, no compartido — son para audiencias distintas y no se mantienen sincronizados como `vita-demo-formulario`/`-v2`.

**Bug real encontrado probando esto antes de desplegarlo:** la primera versión escribía cada palabra con su propia llamada a `doc.text()` (un bloque de texto por palabra). Con una frase corta de prueba aislada esto funcionaba perfecto — pero con un párrafo real y largo del plan, palabras sueltas desaparecían del PDF generado (un "2", la palabra "sostienen", y el final de una frase quedaba cortado), sin ningún error en consola. No era reproducible con pruebas cortas, solo con el mensaje completo real, así que no era obvio hasta no probarlo con contenido real. Arreglado agrupando las palabras consecutivas del mismo estilo (negrita u normal) en una sola llamada a `doc.text()` por grupo, en vez de una por palabra — mismo resultado visual, y el problema no volvió a aparecer en las mismas pruebas que antes lo mostraban.

**Verificación:** generación probada en navegador real (no solo revisión de código) con el PDF resultante decodificado y leído de vuelta para confirmar el texto completo, incluidos acentos (á, é, í, ó, ú, ñ — confirmado que WinAnsiEncoding de Helvetica los soporta sin problema), negrita inline, y paginación con `addPage()` en un párrafo forzado a cruzar de página (confirmado que no se pierde contenido en el salto). `node --check` no aplica (sin cambios al Worker) — verificado vía Babel en navegador real en los dos archivos.

### 27 oct 2026 — Fix: caracteres fuera de Windows-1252 corrompían el PDF entero (emoji, separador "═")

Pedido de Leonardo: "pruébalo tú mismo en el enlace de validación" — probando el PR #105 ya mergeado y desplegado, contra un caso real aprobado (`PRUEBA v4`, no una familia real), descargando el PDF de verdad y leyéndolo de vuelta (no solo revisando que el botón no tirara error en consola). El PDF real tenía tres líneas rotas: el separador `"═".repeat(40)` salía como `%P%P%P...`, las líneas `🔴 ROJO` / `🟡 AMARILLO` / `🟢 VERDE` salían con espaciado roto e ilegibles, y — la más grave — la línea de corrección de la ventana de alimentación (el dato clínico de la sesión de hoy con Peter, PR #102/#103) salía cortada a la mitad.

**Causa real, confirmada decodificando los bytes del PDF directamente (no por inspección visual):** jsPDF, con las fuentes estándar (Helvetica, `WinAnsiEncoding` de un byte), cuando un string tiene un solo carácter fuera de Windows-1252 (un emoji, o `═` que es Unicode de dibujo de caja), no rechaza ni sanea ese carácter — convierte el string ENTERO a UTF-16 pero lo sigue dibujando con la fuente de un byte. El resultado: cada carácter real queda precedido por un byte nulo que la fuente WinAnsi no sabe dibujar, y el bloque completo de texto (no solo el emoji) sale ilegible o con huecos. Como `pdfEscribirParrafo` agrupa palabras consecutivas del mismo estilo en una sola llamada a `doc.text()` (el fix del PR #105), basta que la IA agregue un emoji a mitad de un párrafo largo para que todo ese grupo —que puede incluir el dato clínico más importante de la línea— se corrompa.

**Fix:** nueva función `sanearTextoPdf()`, duplicada en `plan/index.html` y `panel/index.html` (mismo patrón que `pdfEscribirParrafo`/`descargarPdf`, a propósito no compartida), que se aplica a todo texto antes de escribirlo: reemplaza `═` por guiones ASCII, y quita emoji (rango `\u{1F000}-\u{1FFFF}`), símbolos/flechas/dibujo de caja (`←-⯿`) y modificadores de emoji (selector de variación, ZWJ). No se puede predecir ni prohibir qué símbolo va a usar el modelo en el mensaje generado, así que el saneo es general, no una lista de casos conocidos.

**Verificación:** reproducido el bug exacto contra un string de prueba con los mismos símbolos del caso real (separador, 🔴🟡🟢, emoji antes de "CORRECCIÓN DE VENTANA"), capturando el PDF generado en el navegador (interceptando `jsPDF.save` para obtener el `datauristring` sin depender de una descarga real) y decodificando los bytes del content stream: antes del fix, el texto salía como UTF-16 con bytes nulos intercalados (confirmado byte a byte); después del fix, las mismas líneas salen como texto plano de un byte, completas y legibles. Verificado en los dos archivos (`plan/` y `panel/`) vía Babel en navegador real, sin errores de sintaxis. Confirmado también en producción después del merge: PDF real de `PRUEBA v4` regenerado desde `https://be360.app/plan/`, decodificado, 0 bytes nulos en todo el archivo.

### 27 oct 2026 — Oculta el checklist de hábitos en `plan/`, redundante con el nuevo formato del mensaje (pedido de Peter)

Peter le dijo a Leonardo que, ahora que cambió el formato del plan generado (prompt v2, sprint del 26 oct), el resumen de hábitos con checkbox al final de `plan/index.html` quedó redundante con el mensaje narrativo que ya se genera arriba — la misma recomendación aparecía dos veces.

- Se quita de `plan/index.html` la sección "ESTA SEMANA" (barra de progreso) y la lista de tarjetas de hábitos con checkbox (`habitos.map(...)` con `toggle`), junto con el estado que solo esa sección usaba: `checked`, la carga de `localStorage.plan_check_<id>`, la función `toggle()`, y `total`/`done`/`pct`.
- `habitos` (el array en sí) se mantiene — lo sigue usando el botón "Descargar PDF" (PR #105).
- No se toca `panel/index.html`: ahí el checkbox por hábito es para que Peter incluya/excluya hábitos antes de aprobar, una función distinta, no la que Peter pidió ocultar.
- Sección "Retos de bienestar" (opt-in, `?retos=1`) intacta — es un feature aparte, no generado por IA, no relacionado con esta redundancia.

**Verificación:** verificado vía Babel en navegador real (servidor local) contra el caso real `PRUEBA v4`, sin errores de sintaxis; confirmado por lectura del texto renderizado que la sección de checklist ya no aparece y que el resto de la página (mensaje, botón de PDF, chat con Vita) sigue intacto.

### 27 oct 2026 — El SRB pediátrico se promueve a producción: un solo prompt para todo formulario real (decisión de Leonardo)

Leonardo pidió regenerar el plan real de Sofía con las reglas de la reunión del 26 oct (limón al gusto, sal medida en 2 g/L, quesos en el semáforo). Al revisar el código para hacerlo, apareció el problema real: esas reglas —y toda la línea de trabajo del SRB pediátrico desde el 2 oct (v2 a v5)— solo vivían en `SRB_DRAFT_PROMPT_PEDIATRICO_V2`, el prompt que solo usa el enlace de validación (`producto === "formulario_pediatrico_v2"`). El camino de producción real (`vita-demo-formulario/`, el que generó el plan actual de Sofía) seguía en `SRB_DRAFT_PROMPT`, el prompt simple v1.0-v1.4, **sin tocar**. Regenerar con el código tal cual estaba habría usado el prompt viejo — ninguna mejora de ayer habría aparecido.

Se preguntó explícitamente a Leonardo cómo proceder (dos opciones: probar la regeneración solo contra el caso de Sofía con el prompt nuevo, sin afectar producción; o promover el prompt nuevo a producción primero). Eligió la segunda.

**Cambios en `worker/vita-proxy.js`:**
- `SRB_DRAFT_PROMPT` (el prompt viejo, v1.0-v1.4) se retira por completo. `SRB_DRAFT_PROMPT_PEDIATRICO_V2` se renombra a `SRB_DRAFT_PROMPT` — es, desde hoy, el único prompt de generación.
- `generarBorradorAutomatico()`: se quita la rama `esPediatricoV2` — el pipeline completo (reglas duras por código, verificación de ventana de 12h y de las 3h antes de dormir, reintento con correcciones, verificador de grounding contra la fuente SRB, `max_tokens: 5000`) corre siempre, ya no depende de `producto`. La función deja de recibir ese parámetro.
- `handleLog()`: el enrutamiento por Durable Object con alarma (`GeneradorBorradores`) — necesario porque este prompt tarda ~70s y `ctx.waitUntil()` se cancela a los ~30s — pasa de aplicar solo a `"formulario_pediatrico_v2"` a aplicar a **cualquier** formulario real. Sin este cambio, promover el prompt sin promover también el enrutamiento habría reproducido la falla silenciosa ya conocida (fila escrita en el Sheet, borrador que nunca llega, caso invisible en el panel para siempre) — esta vez en producción real, no en el enlace de validación.
- Se conserva como comentario el historial de versiones del prompt retirado (v1.0-v1.4), porque dos de sus cambios clínicos habían quedado "pendientes de ratificar formalmente en `reglas_duras_srb.md`" y esa firma sigue sin existir — retirar el prompt no resuelve ese pendiente. Se anota ahí mismo que la regla de lonchera sigue viva (afinada, 26 oct) y que el tope de edad nunca existió en el prompt nuevo.
- Historial de versiones del SRB pediátrico (v2-v5, ya documentado en el código) se extiende con v6: la promoción misma, con nota de gobernanza explícita — **el addendum I de `reglas_duras_srb.md` (las reglas del 26 oct) sigue sin firma de Peter** al momento de esta promoción. El contenido salió directo de la reunión en vivo con él, pero la ratificación formal del documento está pendiente.

**Costo/latencia:** todo formulario real pasa de 1 llamada a Claude (~2000 tokens, ~23s) a hasta 3 llamadas (generación + posible reintento + verificación de grounding, ~5000 tokens, ~70s) por caso. Es el mismo costo que ya se pagaba en el enlace de validación, ahora también en producción real.

**No cambia:** `vita-demo-formulario/index.html` y `-v2/index.html` (el campo `producto` que mandan no cambió); Apps Script (ningún campo nuevo, `producto` sigue guardándose igual, solo deja de condicionar qué prompt se usa); el HITL (ningún plan llega a una familia sin que Peter apruebe, eso no depende del prompt).

**Verificación:** `node --check worker/vita-proxy.js`. Pendiente antes de desplegar: `wrangler deploy` desde `main` actualizado, y probar el camino real de punta a punta (regenerar el caso de Sofía con sus datos reales, vía el mecanismo de Durable Object, y confirmar que el borrador nuevo aparece en el panel con las reglas del 26 oct) — ver entrada siguiente.

### 27 oct 2026 — Verificación de punta a punta de la promoción, y hallazgo real: la latencia documentada (~70s) se queda corta

Después del merge y `wrangler deploy` desde `main`, se probó el camino real completo, no solo el prompt por separado (regla de este mismo `CLAUDE.md`, §5): se reconstruyó el `dx` real de Sofía (campo por campo, leído directo de `detalle_plan` en el panel — no parafraseado) y se envió a `/log` con `producto: "formulario"`, el mismo camino que usa una familia real.

**Hallazgo:** el primer intento nunca generó borrador — se quedó huérfano (fila en el Sheet sin `id_plan`, invisible en el panel, el comportamiento de falla silenciosa ya documentado). No fue un caso aislado de investigar a ciegas: se agregó logging temporal (`console.log`, revertido después de diagnosticar — nunca llegó a `main`) y se repitió la prueba con `wrangler tail` en vivo. Confirmado con los logs: el Durable Object SÍ encola y SÍ dispara la alarma de inmediato (~1s, como está diseñado) — lo que tarda es la generación misma. Con `max_tokens: 5000` más la verificación de grounding y un eventual reintento, el pipeline completo tomó varios minutos en la prueba real, no los ~70s que decía el comentario del código (esa cifra se midió en el enlace de validación, con menos carga concurrente). El primer intento huérfano se interpreta como una falla transitoria de ese rango largo (el propio diseño ya contempla que puede pasar — "mejor un borrador marcado que un caso vacío"), no como un bug nuevo introducido hoy.

- Comentario de `handleLog()` actualizado implícitamente por este hallazgo (el "~70s" queda como una referencia optimista, no una garantía — no se tocó el código por esto, es una nota operativa para la próxima persona que mida tiempos de generación).
- Se generaron 3 borradores de prueba con los datos reales de Sofía (2 completaron tarde, por la razón de arriba); se revisó el contenido completo de uno y se descartaron los otros 2 duplicados desde el panel (`descartar_pendiente` — ninguno tenía correo enviado, nada bloqueaba el descarte). El plan real de Sofía ya aprobado y enviado (25 oct) **no se tocó en ningún momento** — todo esto quedó en un `idPlan` nuevo, pendiente de revisión.

**Confirmado en el borrador regenerado de Sofía, contra su plan real:** limón al gusto (sin cantidad fija, a diferencia de la sal); sal marina medida en pasos concretos ("2 sobres de 1 g de Makro, o gramera de cocina"); quesos azul/roquefort como única excepción láctea en amarillo (ya no "madurado" genérico); verduras crudas siempre en rojo, cocidas en amarillo, nunca en verde; cero citas "(SRB — sección...)" visibles para el padre; ventana de alimentación correctamente topada en máximo 12h (11h45 en este caso); 3 horas exactas entre la última comida y dormir. Las seis reglas de la reunión del 26 oct, las tres del punto 1 de esa misma minuta, y la corrección de dirección de la ventana (PR #103) — todas presentes, en un caso real, por primera vez en producción.

---

---

## Lo que enseña este historial

Tres patrones que se repiten y conviene tener presentes:

1. **El desarrollo avanza en ráfagas después de cada sesión clínica, pero las pausas no las causa Peter.** Esa correlación la infirió el agente mirando fechas, y Leonardo la corrigió (22 oct): Peter está disponible normalmente una sesión por semana o más. Los huecos recientes se debieron sobre todo a que la atención de Leonardo estuvo jalada a temas de monetización. El riesgo a gestionar, entonces, no es la agenda de Peter — es sostener el foco en la validación.

2. **Esta parte del sistema falla en silencio por diseño**, y por eso sus errores tardan semanas en verse. La generación del borrador no alerta a nadie si falla: la fila simplemente se queda sin plan. Así pasaron desapercibidos el truncamiento de Sonnet 5 (16 sept → 2 oct) y la cancelación por `waitUntil` (desde que existe el enlace pediátrico hasta el 21 oct). **Cada vez que se toque la generación, hay que probar el camino real de punta a punta, no solo el prompt.**

3. **El Apps Script se despliega a mano, el resto solo.** Entre un merge y el pegado manual hay una ventana donde el sistema corre con mitad nueva y mitad vieja — eso causó el PR #55 y reapareció varias veces. Cuando un PR toque `worker/apps-script-formulario-v2.gs.txt`, no está terminado hasta que alguien lo pegue y publique una versión nueva.

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
    - ~~Falta implementar en código~~ **Resuelto 10 ago:** `purgarInactivos`/`purgarInactivosProgramado` en `apps-script-formulario-v2.gs.txt` — borra casos aprobados con 24+ meses sin actividad conocida, manda resumen al equipo por correo. Es un trigger instalable de tiempo (igual patrón que `onAprobado`) — no corre solo hasta que se instale a mano en Activadores, cero riesgo de borrado accidental. El flujo de borrado **por solicitud explícita** de una familia sigue siendo manual (alguien del equipo borra la fila al recibir la solicitud) — no automatizado todavía, pero no es tan urgente como el backstop de inactividad. Detalle: Notion "[be360 — Camino a TRL 9](https://app.notion.com/p/3b77dac3d7cc81928514d61dc2ca1fe9)".
14. ~~Verificación de código de colegio construida pero no operativa todavía (PR #53, 10 ago)~~ **Desactivada a propósito desde el 21 oct (PR #91), ver punto 15.** El Apps Script sí se desplegó, y `CODIGOS_VALIDOS_COLEGIO` ya no vive en el código: salió a PropertiesService y los seis códigos que estuvieron expuestos en el repo público quedaron quemados.

15. **`MODO_PRUEBAS = true` — el control de elegibilidad está apagado (desde el 2 oct, PR #76; ampliado el 21 oct, PR #91).** Mientras el flag siga activo: Peter puede aprobar un plan para **cualquier** correo que se haya escrito en el formulario, verificado o no; no se manda el correo pidiendo el código de colegio; y no corre la purga de 72 h por falta de verificación. Es deliberado para la ronda de validación —las familias invitadas no entran por ningún colegio y pedirles un código sería pedirles algo que no tienen— y el control que sí opera es que **nada se entrega hasta que el equipo apruebe** (`doGet` responde 403 para cualquier caso sin aprobar). **Hay que volverlo a `false` antes del primer colegio con cobro real**, y ese día hay que configurar primero la propiedad `CODIGOS_VALIDOS_COLEGIO` con códigos nuevos (si se pega el script sin configurarla, el mapa queda vacío y nadie puede verificar — falla cerrado, con error propio).

16. **La generación automática del borrador falló en silencio durante semanas, dos veces.** Primero por el cambio de modelo (16 sept → 2 oct, PR #75) y después por el techo de `ctx.waitUntil` en el enlace pediátrico, que nunca generó nada hasta el 21 oct (PR #90). Las dos veces el síntoma fue el mismo: la fila se escribe en el Sheet, el borrador nunca se guarda, el caso queda invisible en el panel y **nadie se entera**, porque `generarBorradorAutomatico` falla en silencio por diseño para no afectar al padre. Hoy la generación corre en una alarma de Durable Object (sin techo de tiempo) y pasa por una revisión automática antes de guardarse (PRs #96, #97), pero **sigue sin existir una alerta cuando un caso se queda sin borrador.** Es el hueco de observabilidad más importante que queda. **Reconfirmado el 27 oct** probando la promoción a producción del SRB pediátrico: de 3 intentos de regeneración reales, 1 quedó huérfano sin que nada lo señalara (solo se detectó porque se estaba mirando el panel a propósito). La promoción de hoy hace que **todo** formulario real —no solo el enlace de validación— pase por este camino más lento y con más pasos, así que la exposición a este hueco aumenta, no disminuye.

17. **El verificador de grounding no conoce las reglas duras firmadas** (encontrado el 22 oct al leer `reglas_duras_srb`). Solo compara el borrador contra el extracto del SRB embebido, así que marca como "sin respaldo" temas que la sección A.3 lista explícitamente como siempre seguros: sueño y ritmo circadiano, hidratación, comida real, movimiento y juego, y manejo de pantallas. Ya produjo un falso positivo parcial — señaló "pantallas apagadas 45 minutos antes de dormir", cuando lo inventado era el número, no el tema. Mientras no vea las reglas firmadas, va a marcar de más en esas áreas. Darle esa fuente es una decisión de producto pendiente, no un arreglo que este repo deba tomar por su cuenta.

18. **Validación con familias reales: todavía no ha empezado.** Todo lo probado hasta hoy son casos de prueba o datos reales de las familias del equipo (los hijos de Leonardo y el caso de Nelly). El flujo completo —formulario en móvil, generación, revisión en el panel, aprobación, correo y página del plan— sí se recorrió de punta a punta el 21-22 oct, encontrando y corrigiendo en el camino los problemas de los PRs #90 a #97. Falta ejecutar la ronda con las familias invitadas. Sigue siendo el gap principal hacia TRL 5, y no es técnico.
19. **Guión de Vita sobre medicamentos en el chat de seguimiento no se escribió.** En la reunión del 21 de oct, Peter dio un guion específico para cuando el padre pregunta por un medicamento en `plan/index.html` (algo como "a medida que los hábitos se sostengan es probable que lo vaya necesitando menos; para un protocolo de retiro, habla con quien te lo recetó" — respuesta directa, no escalada). El código sigue con la respuesta genérica de antes ("Eso es de tu equipo médico. Lo anoto...") + `<escalar>duda</escalar>`. No se tocó en los PRs #102/#103.
20. **Documento de referencia del SRB pediátrico (v6) sin cerrar.** Vive como borrador local (`pruebas/2026.10.26-srb-pediatrico-v6-borrador-local.md`, repo privado), con las reglas del 26 oct ya incorporadas. Falta la revisión final de Leonardo y la publicación en Google Docs (reemplazando la v5, que ya se sabe desactualizada) — por pedido explícito de no llenar Drive con documentos sin revisar.
21. **Addendums G, H e I de `reglas_duras_srb.md` sin firma formal de Peter.** Los tres viven como reglas activas en producción (Worker) documentadas en el repo privado, pero ninguno tiene la ratificación formal que sí tiene la Sección A original (28 jul 2026).
22. ~~Caso de prueba "QA Automatizada" (26 oct) sigue en Pendientes del panel de Peter, sin descartar~~ **Resuelto — ya no aparece en Pendientes** (confirmado el 27 oct revisando el panel en vivo; se descartó en algún momento entre el 26 y el 27, no quedó registrado quién ni cuándo exactamente).

---

## Convenciones para quien siga desarrollando

- Cambios de código van en rama, PR, y se mergean a `main` — nunca commits directos a `main`.
- **Desplegar el Worker exige estar parado en `main`** (`git checkout main && git pull`) antes de `wrangler deploy` — la causa de casi todos los bugs "fantasma" de este changelog fue desplegar desde una rama vieja.
- Cambios al Apps Script que agreguen funciones nuevas (como `doGet`) requieren desplegar una **nueva versión** de la implementación, no solo guardar el código — las versiones viejas no ven código agregado después de su despliegue.
- No compartir la cuenta de Cloudflare completa con un agente de IA — usar tokens de alcance mínimo (Workers Scripts: Edit) y rotarlos después de cada sesión de trabajo si quedaron expuestos en una conversación.
- **Antes de publicar cualquier archivo con JS embebido, verificar la sintaxis con una herramienta real, no solo revisión visual** — `node --check` para JS plano/Apps Script, transformación con `@babel/standalone` para JSX. Nace de un apagón real de producción (un backtick de estilo markdown dentro de un template literal del prompt rompió el parseo y dejó la página en blanco); desde entonces es un paso obligatorio antes de cada despliegue.
- **Ningún secreto va en este repo, que es público** — ni PINs, ni códigos de colegio, ni tokens, ni siquiera "de ejemplo" ni dentro de un comentario del CHANGELOG. Todos viven en Script Properties del Apps Script o en los secrets de Cloudflare, y los valores se pasan por fuera del repo. (Esta convención antes decía lo contrario: indicaba generar `PANEL_SECRET` con un PIN concreto escrito aquí. Quedó obsoleta con el PR #68, que movió los secretos a PropertiesService, y el PIN que nombraba ya fue rotado — pero estuvo publicado en GitHub mientras tanto, y sigue en el historial de git aunque hoy no aparezca en el archivo.)
- **Cada PR se registra en este CHANGELOG, en el mismo PR que hace el cambio** — no "después", porque el después no llega: entre el 10 de agosto y el 22 de octubre se acumularon 43 PRs sin registrar y reconstruirlos costó una sesión entera. Una entrada por PR, con qué cambió y **por qué** (qué lo motivó: un bug en producción, un pedido de Peter en tal reunión, una decisión de Leonardo). Si hubo una pausa larga desde el PR anterior, anotarla y decir a qué se debió — las pausas son parte de la historia del proyecto y son lo primero que se olvida.

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

**Estado actual (6 ago 2026):** el ciclo completo — padre llena el formulario conversando con Vita → se genera un borrador de plan → queda en un panel de revisión (hoja de cálculo) → Peter aprueba o edita → se genera un link único con el plan aprobado, en un diseño visual con checklist de hábitos → ese link se le envía al padre — está construido y probado de punta a punta con un caso ficticio. Lo que falta para ser 100% real con familias reales está documentado en "Pendientes conocidos" al final.

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
    │  vía Apps Script (Web App)                 directo en el Sheet
    ▼
Worker genera un link único (/plan?id=...)
    │  — SOLO funciona si Peter aprobó
    ▼
plan/index.html (GitHub Pages)
    │  el padre ve su plan: checklist de hábitos + progreso
    ▼
[pendiente] entrega del link por WhatsApp — hoy es manual
```

No hay base de datos propia ni backend con estado — el Sheet **es** la base de datos y el panel de revisión, a propósito, para no invertir en infraestructura antes de validar el producto.

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

1. **No hay captura de contacto del padre** (nombre, WhatsApp) en `vita-demo-formulario` todavía — sin esto no se puede armar el link de entrega automáticamente.
2. **No existe un número de WhatsApp dedicado para Vita.** La entrega del link del plan, y cualquier conversación de seguimiento, es hoy 100% manual (una persona del equipo, no un bot).
3. **La generación del borrador (Prompt Maestro) no está automatizada** — hoy la corre un desarrollador a mano por cada caso, no hay un pipeline que lo dispare solo cuando llega un formulario nuevo.
4. **Google Sheets/Apps Script es una capa de persistencia de prototipo**, no una base de datos de producción — no tiene política formal de retención ni borrado de datos todavía.
5. **Deuda técnica heredada:** el Worker no bloquea peticiones sin header `Origin` (ej. `curl` directo) — solo bloquea orígenes de navegador incorrectos. No es una vulnerabilidad crítica hoy (no hay datos sensibles expuestos por esta vía), pero falta rate limiting real antes de tráfico masivo.
6. **Alineación clínica incompleta:** quedan puntos abiertos con Peter sobre nivel de detalle del plan y fraseo de algunas preguntas (relajación/emociones) — ver `CONTEXT.md` del sprint para el detalle vivo.
7. **Sin pruebas de carga ni análisis de costo a escala** — validado con casos ficticios, no con volumen real. El costo por interacción (API de Anthropic + eventual WhatsApp Business API) está pendiente de verificar contra el modelo de negocio (compromiso pendiente de Leonardo con Peter, sesión 5 ago).

---

## Convenciones para quien siga desarrollando

- Cambios de código van en rama, PR, y se mergean a `main` — nunca commits directos a `main`.
- **Desplegar el Worker exige estar parado en `main`** (`git checkout main && git pull`) antes de `wrangler deploy` — la causa de casi todos los bugs "fantasma" de este changelog fue desplegar desde una rama vieja.
- Cambios al Apps Script que agreguen funciones nuevas (como `doGet`) requieren desplegar una **nueva versión** de la implementación, no solo guardar el código — las versiones viejas no ven código agregado después de su despliegue.
- No compartir la cuenta de Cloudflare completa con un agente de IA — usar tokens de alcance mínimo (Workers Scripts: Edit) y rotarlos después de cada sesión de trabajo si quedaron expuestos en una conversación.

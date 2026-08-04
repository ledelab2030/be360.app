# CLAUDE.md — Vita demo (repo `be360.app`)

Capa de desarrollo del demo Vita. Léelo antes de tocar código.

Fuente de verdad del PROYECTO (negocio, sprint clínico, estrategia, fondos, reglas duras, socios): `CONTEXT.md` en la carpeta del design-sprint + el doc de Notion de fundraising (`app.notion.com/p/3907dac3d7cc81599f7fd27e1477d9bc`). No dupliques negocio aquí. Si algo de negocio/clínico choca entre este archivo y CONTEXT.md/Notion, mandan CONTEXT.md y Notion. Este archivo solo cubre el código del demo web.

Ojo: el demo vive en un repo distinto a la carpeta del sprint. La carpeta del sprint (con `CONTEXT.md`, `design-sprint/`, `casos-clinicos/`) es clínica/negocio. Este repo (`be360.app`) es la app web.

## 1. Dónde vive el código

- Repositorio: `github.com/ledelab2030/be360.app` — rama `main`, desplegado con GitHub Pages.
- Archivo que se edita (demo activo, v1.3): `vita-demo-srb-3/index.html`
- URL en vivo: https://be360.app/vita-demo-srb-3/
- Es un solo archivo autocontenido: UI, lógica y system prompt (con el SRB) van dentro de ese `index.html`. Sin build, sin `src/`, sin `node_modules`.
- No tocar: `vita-demo-3k9x/` (red de seguridad, demo base sin SRB). `vita-demo-srb-1/` y `srb-2/` son iteraciones viejas.
- Proxy (fuera del repo): Cloudflare Worker `vita-proxy` (`https://vita-proxy.leonardo-751.workers.dev`) guarda la API key y restringe el origen a be360.app. Se administra en Cloudflare.

## 2. Arquitectura

Web-first, sin backend propio (se eliminaron n8n y Supabase en mayo 2026; están en `flujos-deprecados/`, no revivir).

```
index.html (React 18 + Babel standalone desde unpkg, sin build)
   → arma el system prompt en el navegador
   → POST al Worker vita-proxy   [guarda API key, CORS a be360.app]
   → Worker llama a la API de Anthropic (Messages API)
```

- Modelo: `claude-sonnet-4-6`
- Sin persistencia entre sesiones todavía.

## 3. Mapa del `index.html` (v1.3)

Constantes: `WORKER_URL` · `MODEL="claude-sonnet-4-6"` · `BASE` (system prompt con el SRB embebido) · `MODE_BLOCK` (adulto/familia) · `FIELDS` (esquema del diagnóstico, 11 campos) · `AREA_TOTAL` (=10) · `P` (paleta).

Funciones (en `App`): `buildPrompt(m)` = BASE + modo · `callVita(msgs,m)` (fetch al worker, timeout 45s con AbortController) · `parseDx(text)` (extrae el bloque oculto `<dx>{...}</dx>`, actualiza estado, devuelve texto visible) · `start(chosen)` (opener) · `send(text)` · `retry()` (reintenta opener o último turno) · `chooseMode(m)` · `saveDx`/`exportDx`/`copyChat` · `renderRich`, `Shell`.

Etapas (`stage`): `welcome` → `select` → `intro` → `chat`.

Campos del `<dx>`: `nombre, edad, objetivo, origen, sueno, actividad, sintomas, alimentacion, mente, emociones, microcambio`. Cronología de comidas + hidratación + ventana de ingesta van en `alimentacion`. Si cambias el esquema, actualiza `FIELDS` y las instrucciones de `<dx>` en `BASE`.

## 4. Estado del demo (v1.3) — dónde quedó

Implementado y desplegado en `vita-demo-srb-3`, validado con Peter y probado end-to-end (incl. modo familia con un menor):

- Intro narrativa (explica el método antes de empezar).
- Captura cronológica estricta del día (despertar→dormir, con horas, en orden).
- Hidratación implícita: se detecta dentro de "¿comes o bebes algo?" en cada momento; nunca se pregunta "¿tomas agua?".
- No aconsejar durante la captura: Vita escucha, no corrige; la recomendación se reserva para el cierre.
- Robustez: timeout 45s + botón Reintentar (para webviews de apps / redes móviles inestables).

## 5. HITL — capture-only (decidido 4 ago 2026, en construcción)

Regla dura (`CONTEXT.md`): nada llega al padre sin aprobación de Peter (Human-in-the-Loop).
Arquitectura confirmada por Leonardo:

1. El chat pasa a ser SOLO captura. Vita nunca genera el plan/microcambio en el chat visible; cierra con algo como "tu información quedó registrada; Peter prepara tu primer paso y te contactamos", sin ninguna prescripción SRB en el texto visible.
2. El diagnóstico capturado (`dx`) se envía a un Sheet de revisión vía el Worker (endpoint nuevo `/log`), no directo desde el navegador (evita CORS/abuso, mantiene control de origen).
3. El plan real se genera aparte (con `srb_draft_generator.txt` del repo del sprint, mismo patrón que el caso Valentina), a partir de ese diagnóstico, después de la aprobación de Peter.
4. Guardado + revisión en Google Sheets vía Apps Script Web App (no Cloudflare KV): Peter ya vive en Sheets.
5. Entrega al padre: sin WhatsApp automatizado todavía. El humano (Leonardo/Peter) escribe por WhatsApp tras la aprobación.
6. Acceso a Cloudflare: NO se entrega la cuenta/dashboard a un agente. El agente escribe el cambio del Worker como código (`worker/`, wrangler); Leonardo hace `wrangler deploy` (o da un token de alcance mínimo: Workers Scripts Edit).
7. Proceso: se construye en una rama (`feat/hitl-capture-only`) y se muestra el diff antes de tocar `vita-demo-srb-3` en `main`.

Excepción para demo de VENTAS: si se necesita el "wow" de mostrar un primer paso, mantener una variante aparte que muestre un paso genérico y provisional, marcado "Peter revisará tu plan". Para todo lo que toque a Peter o a un padre real: capture-only, sin excepción.

## 6. Reglas de producto (mantener en cualquier edición)

- Captura cronológica estricta; no preguntar comidas en abstracto.
- Hidratación implícita (ver §4); nunca directa.
- No aconsejar durante la captura; con capture-only, NUNCA se aconseja, ni al cierre.
- Ventana de ingesta: anotarla, no empujar a reducirla (adultos). No patologizar el ayuno matinal (adultos). No asumir meriendas.
- El SRB es la fuente única de recomendaciones; si algo no está en el marco, márcalo, no lo rellenes.

## 7. Guardrails de seguridad (per CONTEXT.md — no negociables)

- Rango 2–20 años; versión conservadora del SRB para todos (sin ayuno ni restricción agresiva de carbohidratos en menores).
- No diagnostica, no prescribe, no reemplaza al médico. Nunca sugerir suspender/reducir medicación.
- Conducta alimentaria: ante señales, no dar consejos de dieta/calorías/peso/ayuno/ejercicio; validar y derivar.
- No prometer servicios inexistentes (Vita NO agenda/coordina/remite médicos).
- Registro doble: de cara a colegios/familias, NUNCA mencionar IA, stack, ni "sin medicamentos"/"revertir"/"epigenética". Esos términos técnicos solo en materiales de grant/inversión.

## 8. Deploy y pruebas

- Deploy frontend: commit del `index.html` en su carpeta → GitHub Pages publica en ~1-2 min.
- Deploy worker: `wrangler deploy` desde `worker/` (Leonardo, con su cuenta de Cloudflare).
- Probar en navegador real (Chrome/Safari). NO dentro de webviews de apps.
- En `file://` o `localhost` la UI carga, pero el chat no conecta (CORS a be360.app). Para probar la conversación hay que desplegar.
- Validar el JSX antes de entregar (Babel corre en el navegador; un error de sintaxis deja la pantalla en blanco).
- Guion de humo (adulto): "me levanto 6:30, un tinto, primera comida 1pm, última 7pm, duermo 11pm" → verificar orden cronológico, hidratación detectada sin preguntar, sin consejo a mitad NI al cierre, panel Diagnóstico llenándose, botón "Enviar a revisión" funcionando, y Reintentar si se corta la red.

## 9. Pendientes del demo (orden sugerido)

1. HITL capture-only (§5) — en construcción (rama `feat/hitl-capture-only`).
2. Franjas visuales del día · plan de acción inmediato (post-aprobación) · lista estructurada de patologías · menú (rutina/plan/patologías).
3. Persistencia por correo + panel · perfil dinámico.
4. Selector de idioma (EN base; FR/ET/FI/PL listos para habilitar).
5. Técnicos internos: versionado del SRB (snapshot inyectado por el worker) · endurecer el worker (rate limit / verificación de origen) · mover el worker a control de versiones (este repo, `worker/`).

## 10. Enlaces

- Demo v1.3: https://be360.app/vita-demo-srb-3/
- Repo: `github.com/ledelab2030/be360.app` · Worker: `vita-proxy.leonardo-751.workers.dev` · Modelo: `claude-sonnet-4-6`
- Proyecto (fuente de verdad): `CONTEXT.md` (carpeta del sprint) + Notion fundraising `app.notion.com/p/3907dac3d7cc81599f7fd27e1477d9bc`
- Plan de fondos: `app.notion.com/p/3917dac3d7cc81e1b832d13070d02a6b`
- Formulario de Peter (Sheets v3): `docs.google.com/spreadsheets/d/1WcWB4acYWq07gdKsUXiI8O232j7Ra64VwjfL7RSuPeA`

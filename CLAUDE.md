# CLAUDE.md — repo `be360.app`

Capa de **ejecución** del producto. Léelo antes de tocar código.

**Ritual de arranque, obligatorio:** leer `CHANGELOG.md` de este repo + `CONTEXT.md` de la carpeta del workspace, y hacer `git pull`, **antes de tocar nada**. La verdad vive en archivos, no en el transcript de un chat.

**Fuente de verdad del PROYECTO** (negocio, estrategia, sprint clínico, fondos, reglas duras, socios): `CONTEXT.md` en `iCloud/LedeLab/be360/` — repo privado `be360-workspace`. No dupliques negocio aquí. Si algo choca entre este archivo y `CONTEXT.md`, manda `CONTEXT.md`.

**Separación de canales — ELIMINADA el 27 oct 2026.** Hasta esa fecha, las decisiones de *qué* construir venían de un chat primario de estrategia aparte y este repo era solo ejecución. Leonardo quitó esa separación: este es ahora el único canal, estrategia y ejecución juntas. Las convenciones de disciplina de código (§4) siguen igual — eso nunca fue parte de la separación.

---

## 1. Dónde vive el código

- Repo: `github.com/ledelab2030/be360.app`, rama `main`, desplegado por GitHub Pages.
- Local: `iCloud/LedeLab/be360/be360.app/` (movido desde `~/Downloads` el 22 oct 2026, para que todo lo local de be360 viva bajo una carpeta). Es un repo aparte del privado que lo contiene, y está gitignored por este.
- **Producto del piloto:** `vita-demo-formulario/` (captura) + `panel/` (revisión de Peter) + `plan/` (lo que ve la familia).
- **`equipo/` (27 oct 2026, en construcción)** — panel nuevo, en paralelo a `panel/`, que NO toca ni reemplaza: pensado para que el equipo crezca más allá de un solo PIN. Mismo Worker, mismas rutas `/panel/*`, mismo `PANEL_SECRET` — a propósito, para que el SRB/prompt nunca se desincronice entre los dos (los dos leen el mismo Sheet). Hoy funcionan Pendientes, Aprobados y Equipo (solo lectura — lista en la pestaña "Equipo" del Sheet, se edita a mano ahí, no desde el panel); Comunidades (antes "Colegios" — un colegio es un tipo de comunidad, también habrá grupos de amigos/familias extendidas; ver CHANGELOG)/Familias/Reportes siguen marcados "Próximamente", sin backend.
- **`app/` (27 oct 2026, en construcción)** — la App Familia, en paralelo a `plan/`, que NO toca ni reemplaza: el link que ya reciben las familias por correo (`plan/?id=...`) sigue funcionando exactamente igual. Mismo backend (`GET /plan?id=`, `POST /escalar`, `POST /chat`, el passthrough de Claude), mismo `?id=` en la URL, mismos keys de `localStorage` para los Retos — toda la lógica de `plan/index.html` (prompt de seguimiento, consolidación de `dato_nuevo`, PDF, Retos de bienestar) está copiada, no reinventada. Lo que cambia es la forma: 4 pestañas persistentes (Hoy / Mi plan / Vita / Progreso) en vez de una página larga + chat como overlay. El chat de Vita se guarda completo en el Sheet (`chat_json`, mismo patrón que `novedades_json`) — la pestaña Vita recuerda la conversación entre sesiones. Progreso muestra la línea de tiempo de novedades (fecha + resumen) + los Retos si el piloto está activo; "Todavía no hay nada que mostrar" solo si no hay ninguna de las dos.
- **Enlace de validación:** `vita-demo-formulario-v2/` — copia casi idéntica de producción; difieren en 3 lugares (marcador de versión, un comentario, y el campo `producto`) más la clave de guardado. **Todo cambio de copy va a las dos**, o divergen.
- `worker/vita-proxy.js` — el Cloudflare Worker, en control de versiones. `worker/apps-script-formulario-v2.gs.txt` — el Apps Script, que se pega a mano.
- No tocar: `vita-demo-3k9x/` (red de seguridad), `vita-demo-srb-1/` y `-2/` (iteraciones viejas). `vita-demo-srb-3/` es el demo general anterior, no pediátrico — sigue en pie pero no es el producto del piloto.

## 2. Arquitectura

Sin backend propio. Páginas estáticas + un Worker en el borde + Google Sheets como persistencia.

```
Familia → vita-demo-formulario(-v2)/  [React + Babel en el navegador, sin build]
   → POST /log al Worker            [guarda la API key, exige Origin be360.app, rate limit]
   → Apps Script escribe la fila en el Sheet
   → Durable Object GeneradorBorradores: alarma → genera el borrador
   → revisión automática (reglas por código + verificador de grounding)
   → Apps Script guarda el borrador → el caso aparece en panel/
Peter revisa en panel/ → aprueba → Apps Script le manda el correo a la familia
Familia abre plan/?id=… → doGet responde 403 si el caso no está aprobado
```

- Modelo del generador: `claude-sonnet-4-6`. **No subirlo sin probar el camino real** — ver §5.
- La generación pediátrica vive en una **alarma de Durable Object**, no en `ctx.waitUntil`: ese tiene un techo de ~30 s y la generación tarda más (PR #90).

## 3. Reglas duras del producto (vienen de `reglas_duras_srb`, firmado por Peter el 28 jul 2026)

No son negociables desde este repo. Si algo las contradice, se escala, no se decide acá.

- **Siempre al padre o madre, nunca al niño.**
- **Prohibido para niños:** ayuno o ventanas restrictivas (ni la palabra), restricción agresiva de carbohidratos, dietas cetogénicas o carnívoras, déficit calórico. Rango de edad: **2 años en adelante, sin límite superior** (el tope de 20 se quitó en el PR #81).
- **Suero casero:** inicia en 2 g/L, objetivo ~6 g/L, máximo 9 g/L. Hoy el prompt solo codifica el inicio.
- **No diagnostica, no prescribe, no reemplaza al médico.** Nunca sugerir suspender o cambiar medicación. Silencio total sobre medicamentos o remedios que reporte la familia.
- **HITL obligatorio:** ningún plan llega sin aprobación de Peter. Está cableado: `doGet` responde 403 a lo no aprobado.
- **Fuente única:** solo el SRB aprobado manda; no se rellena con nutrición convencional. Es la regla que el prompt v4 y la revisión automática vinieron a hacer cumplir.
- **Registro doble:** de cara a familias y colegios, **nunca** mencionar IA, stack ni "sin medicamentos" / "revertir" / "epigenética". En materiales de grant o inversión sí se expone.

## 4. Convenciones de trabajo

- **Rama + PR siempre. Nunca commit directo a `main`.**
- **Cada PR registra su entrada en `CHANGELOG.md` dentro de la misma rama**, con qué cambió y por qué. No "después": entre agosto y octubre se acumularon 43 PRs sin registrar.
- **Verificar sintaxis antes de desplegar**, con herramienta, no a ojo: `node --check` para el Worker y el Apps Script, transformación con `@babel/standalone` para el JSX. Nace de un apagón real de producción por un backtick dentro de un template literal.
- **Ningún secreto en este repo, que es público** — ni PINs, ni códigos, ni de ejemplo. Van en Script Properties o en los secrets de Cloudflare.
- **Nunca un nombre de familia real** en el código, en un comentario o en el CHANGELOG.

## 5. Desplegar

| Qué | Cómo | Ojo |
| --- | --- | --- |
| Frontend | Merge a `main` → GitHub Pages publica en 1-2 min | Verificar con `curl` o en el navegador, no asumir |
| Worker | `wrangler deploy` desde `worker/`, **parado en `main` actualizado** | Desplegar desde una rama vieja fue la causa de varios bugs fantasma |
| Apps Script | Pegado manual completo + Implementar → **Nueva versión** | No automatizable por diseño. Entre el merge y el pegado el sistema corre con mitad nueva y mitad vieja |

**Al tocar la generación del borrador, probar el camino real de punta a punta** — llenar el formulario como lo llena un padre — no solo el prompt por separado. Dos fallas pasaron semanas escondidas por no hacerlo: el truncamiento del modelo nuevo y el techo de `waitUntil`. Esta parte del sistema **falla en silencio por diseño** y todavía no hay alerta cuando un caso queda sin borrador.

## 6. Estado y pendientes

Los pendientes con su detalle viven en `CHANGELOG.md`, sección "Pendientes conocidos". Los que condicionan cómo se trabaja hoy:

- **`MODO_PRUEBAS = true`** en el Apps Script: Peter puede aprobar sin verificación de colegio, no se manda el correo del código y no corre la purga de 72 h. Correcto para la validación; hay que apagarlo antes del primer colegio que cobre, configurando primero `CODIGOS_VALIDOS_COLEGIO` en Script Properties.
- **El SRB pediátrico (antes "v4"/"experimental") se promovió a producción el 27 oct 2026** — decisión de Leonardo, al encontrar que las reglas de la reunión del 26 oct con Peter (limón al gusto, sal en 2 g/L, quesos en el semáforo) solo vivían en el prompt del enlace de validación. Ahora es `SRB_DRAFT_PROMPT`, el único prompt de generación, usado por `vita-demo-formulario/` y `vita-demo-formulario-v2/` por igual. **Pendiente:** el addendum I de `reglas_duras_srb.md` (las reglas del 26 oct) sigue sin firma de Peter.
- **Falta la alerta** cuando un caso se queda sin borrador. Es el hueco de observabilidad más importante.

## 7. Enlaces

- Captura (producción): `https://be360.app/vita-demo-formulario/` · Validación: `https://be360.app/vita-demo-formulario-v2/`
- Panel de Peter: `https://be360.app/panel/` · Panel de colegio: `https://be360.app/panel-colegio/` · Panel Equipo (nuevo, en construcción): `https://be360.app/equipo/`
- App Familia (nueva, en construcción): `https://be360.app/app/?id=...` — mismo `id` que `plan/?id=...`
- Worker: `vita-proxy.leonardo-751.workers.dev`
- Historia técnica completa: `CHANGELOG.md` · Estado del proyecto: `CONTEXT.md` (repo privado) · Narrativa del sprint: `contexto-historico/bienestar360_sprint_diseno_reconstruccion_2026-10-22.md`

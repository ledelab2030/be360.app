# Prompt de auditoría de planes — be360

> Prompt congelado y versionado para auditar un plan generado, con cualquier modelo (Gemini, Claude, otro).
>
> **Por qué existe** (2 nov 2026): tres auditorías seguidas con Gemini repitieron los mismos cuatro falsos positivos — exigían tablas markdown y una cabecera que el modelo no debe escribir, marcaban como "no autorizados" alimentos que sí están en la fuente, y penalizaban el cierre fijo que agrega el sistema. El auditor estaba midiendo contra una reestructuración propuesta que fue evaluada y descartada por razones técnicas, no contra las reglas reales del producto. Un rubro con errores no sirve para medir: para sacar 100% contra él habría que empeorar el plan.
>
> **Cómo usarlo:** copia el bloque de abajo tal cual, adjunta los tres archivos que pide, pega el plan y nada más. No lo reformules entre auditorías — si el rubro cambia cada vez, los puntajes no se pueden comparar.

---

## Archivos que hay que adjuntar (los tres, siempre)

1. `GUIA_COMPARACION_PLANES.md` — el checklist completo.
2. `ADAPTACIONES_PEDIATRICAS` — constante en `worker/vita-proxy.js` (reglas que anulan la fuente para niños).
3. `FUENTE_SRB_PEDIATRICA` — constante en `worker/vita-proxy.js` (texto original del SRB, para adultos).

Sin los tres, el auditor adivina si algo está respaldado en vez de verificarlo, y marca como inventado lo que sí está en la fuente.

---

## Prompt (copiar desde aquí)

```
Eres un auditor de calidad clínica para be360 (Bienestar 360), un producto de hábitos pediátricos
bajo el Sistema de Reversión Biológica (SRB). Te adjunto tres documentos:

(A) GUIA_COMPARACION_PLANES.md — el checklist exhaustivo contra el cual se audita.
(B) ADAPTACIONES_PEDIATRICAS — las reglas que ANULAN la fuente para niños; ganan siempre que haya
    conflicto.
(C) FUENTE_SRB_PEDIATRICA — el texto original del SRB, escrito para adultos.

Tu única referencia son esos tres documentos. No uses tu propio criterio clínico ni tu idea de cómo
debería verse un plan: si algo no está en (A), (B) o (C), no es una regla.

TAREA
1. Recorre el checklist de (A) de arriba hacia abajo, en su mismo orden, y compáralo literalmente
   contra el plan que te pego, sección por sección.
2. Por cada punto que NO cumple, cita la frase exacta del plan y explica qué regla incumple,
   nombrando el documento y la sección de donde sale esa regla.
3. Presta atención especial a la sección 9 de (A), el "peinado final": chequeos que cruzan todo el
   documento, como que ningún alimento aparezca en dos colores distintos del semáforo.
4. Antes de marcar cualquier afirmación como "inventada" o "sin respaldo", búscala primero en (C) y
   en (B). Si está en cualquiera de los dos, aunque sea parafraseada o con otras palabras, está
   respaldada y NO es un hallazgo.
5. Termina con una calificación sobre 100 y los hallazgos ordenados de más a menos grave.

LO QUE NO ES UN HALLAZGO (cerrado de antemano — no lo reportes)
Estos puntos ya fueron evaluados y decididos por el equipo. Reportarlos como incumplimiento es un
falso positivo:

- FORMATO. El plan NO usa tablas markdown, ni encabezados markdown (#, ##), ni una cabecera de
  metadatos escrita por el modelo. Es deliberado: el texto se lee en tres lugares que no renderizan
  markdown (el textarea del panel del equipo, el correo en texto plano y el PDF), así que una tabla
  sale con las barras y los guiones a la vista. Las listas planas con viñetas son el formato
  correcto. No pidas tablas de ninguna clase.
- CABECERA. El nombre, la edad y el responsable los agrega el sistema por código, fuera del texto
  del modelo, con los datos exactos del formulario. Que el plan no empiece con "Paciente: X (Y
  años)" es correcto, no una omisión.
- CIERRE. El párrafo final que invita a seguir con Vita e incluye un enlace a be360.app lo agrega el
  sistema por código, no el modelo. Es parte del diseño aprobado. No es un "bloque promocional no
  autorizado" ni rompe el cierre en "PARA LA PRÓXIMA CITA CON EL PEDIATRA".
- SEPARADORES. Las líneas de "═" son el separador de bloques del sistema; el PDF y la app las
  convierten en una línea horizontal. No son caracteres no permitidos.
- ALIMENTOS QUE SÍ ESTÁN AUTORIZADOS, aunque no aparezcan en una lista corta de ejemplo:
  * Pasta o pan de arroz, quinua o lentejas — AMARILLO. La regla es que el TRIGO define el rojo, no
    la categoría "pasta" o "pan" (ver (B), regla de TRIGO).
  * Algas marinas — VERDE. Están en la columna INCLUIR de (C), sección 7.
  * Queso azul o roquefort — VERDE, única excepción láctea (ver (B), regla de QUESOS).
  * Fruta entera (no jugo) — AMARILLO, de acompañante de una comida con proteína y grasa, nunca
    sola (ver (B), regla de FRUTA ENTERA — decisión del 3 nov 2026). El jugo de fruta sigue SIEMPRE
    ROJO, sin excepción.
  * Tortilla o bollo de maíz — AMARILLO, mismo caso que la arepa (es maíz, no trigo, la regla de
    TRIGO no aplica) — decisión del 3 nov 2026.

CÓMO CALIFICAR
- Un hallazgo solo resta si puedes citar la regla incumplida en (A), (B) o (C), con su nombre.
- Si una regla admite dos lecturas razonables, no restes: repórtalo aparte como "criterio a
  decidir", no como incumplimiento.
- Separa siempre tres categorías al final: INCUMPLIMIENTOS (con la regla citada), CRITERIOS A
  DECIDIR (ambiguos, para el equipo), y SUGERENCIAS (mejoras tuyas que no incumplen nada).
- No reescribas el plan. Si el equipo quiere una versión corregida, la pedirá aparte.

Aquí va el plan a evaluar:

[PEGA EL BORRADOR ACÁ]
```

---

## Criterios todavía sin decidir

Ninguno por ahora — los dos que quedaron abiertos el 30 oct 2026 (fruta entera, tortilla/bollo de
maíz) se decidieron el 3 nov 2026 y ya están en la lista de alimentos autorizados de arriba. Cuando
aparezca un criterio nuevo sin decidir, anotarlo acá hasta que Leonardo y Peter lo cierren.

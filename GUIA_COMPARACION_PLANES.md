# Guía de comparación de planes — be360

> Checklist para comparar un plan generado/regenerado contra el "ideal" (lo que dicen `SRB_DRAFT_PROMPT`, `ADAPTACIONES_PEDIATRICAS`, `FUENTE_SRB_PEDIATRICA` y `revisarBorradorPediatrico` en `worker/vita-proxy.js`). Pensada para usarse literal, de arriba hacia abajo, siguiendo el mismo orden del plan — no de memoria.
>
> **Por qué existe este documento** (30 oct 2026): una revisión que solo verifica los cambios del día se queda corta — encontramos contradicciones del semáforo (un mismo alimento en dos colores) que venían de reglas mucho más viejas, pasadas por alto porque la revisión se enfocó solo en lo nuevo. El objetivo es que la IA sea el filtro de calidad primario en cada generación, y que el equipo humano revise solo al azar de vez en cuando — eso exige que esta lista sea literalmente completa, no un resumen de lo último que se tocó.
>
> **Cómo usarla:** recorre el plan sección por sección, en el orden en que aparece. Por cada ítem marca ✅ (cumple), ❌ (no cumple — anota la cita exacta) o — (no aplica a este caso). Al final, la sección 9 es un peinado transversal que vuelve a pasar por TODO el texto buscando patrones que no son propios de una sola sección (p. ej. un alimento repetido en dos colores del semáforo, aunque estén en distintas secciones).

---

## 0. Antes de empezar

- [ ] **Regla madre de todas:** cada afirmación clínica del plan (causa, consecuencia, mecanismo, cifra) debe rastrearse a `FUENTE_SRB_PEDIATRICA` o a `ADAPTACIONES_PEDIATRICAS`. Si no puedes señalar de dónde sale una frase, es una violación — no importa qué tan razonable suene.
- [ ] Nada de lo que diga el plan debe venir del conocimiento general de nutrición del modelo. "Suena plausible" no es lo mismo que "está en la fuente".
- [ ] Si el plan menciona algo que la fuente dice para adultos pero las adaptaciones pisan (ayuno, 5-7g de sal, metas de insulina, % de macros, fuerza estructurada, los 6 pasos de microbiota, BioEmoción/biodescodificación), confirma que se aplicó la versión PEDIÁTRICA, nunca la de adultos.

---

## 1. Encabezado (generado por código, no por el modelo)

- [ ] `{Niño/a}, {edad} años` — sin "años" duplicado (bug conocido: el campo `edad` del formulario a veces ya trae "años" incluido).
- [ ] `Responsable: {nombre del padre/madre}`.
- [ ] Esto lo arma `generarYVerificarBorrador` por código — si falta o está mal, el bug está en el código, no en el prompt.

---

## 2. CRONOLOGÍA ACTUAL

- [ ] Encabezado EXACTO "CRONOLOGÍA ACTUAL", en mayúsculas, sin parafrasear.
- [ ] Viñetas por hora, **sintetizado, no prosa** — tal como lo reportó el padre, sin opinar ni evaluar.
- [ ] Horas en formato de padre ("6:45 am", "7:00 pm") — nunca 24h, nunca flechas ("06:00 → 19:00").
- [ ] Cierra con "Ventana de alimentación actual: X horas" **solo si se puede calcular** — y si se puede, **sin la palabra "aproximadamente"**.
- [ ] El número de la ventana actual es exacto (horas y minutos reales, no redondeado) y coincide con las horas reportadas en las propias viñetas de arriba.
- [ ] **Deducir sí, suponer no**: si el formulario no da una hora exacta pero sí un límite explícito que la implica (ej. "después de las 8pm solo agua"), el plan debe deducir la ventana de ese límite — no debe decir "no calculable" cuando hay un dato del que deducir. Pero tampoco debe inventar una hora que el formulario no menciona ni implica de ninguna forma.
- [ ] Si de verdad no hay dato ni límite del que deducir, la línea de ventana se omite (no se calcula a ciegas).

---

## 3. DIAGNÓSTICO BREVE

- [ ] Encabezado EXACTO "DIAGNÓSTICO BREVE".
- [ ] Máximo 3 líneas, sin alarmismo.
- [ ] Todo lo que dice está respaldado por la FUENTE SRB **y** por lo que el formulario reporta — ninguna de las dos cosas sola basta.
- [ ] **"PARA LA PRÓXIMA CITA CON EL PEDIATRA" (antes "Paso 0") NO va acá** — se movió al final del plan (ver sección 6). Si aparece aquí, es un error de posición.
- [ ] Sin lenguaje psicológico/neurológico sin base ("sistema nervioso", "rigidez", "necesidad de control", "ceder sola/solo") — la fuente solo respalda recuperación metabólica/hepática (desintoxicación nocturna del hígado), nunca nada sobre el sistema nervioso o control psicológico.
- [ ] Si el formulario reporta un diagnóstico médico activo, los hábitos no se presentan como tratamiento ni reemplazo de ese seguimiento — se enmarcan como apoyo general.

---

## 4. HÁBITOS Y VENTANA NUTRICIONAL PROPUESTA

- [ ] Encabezado EXACTO "HÁBITOS Y VENTANA NUTRICIONAL PROPUESTA".
- [ ] Formato: **agenda por momento del día** (mañana, lonchera, almuerzo, tarde, cena) — NUNCA una lista numerada que repite los títulos del array `habitos` uno por uno ("1. <título>: <texto>", "2. ..."). Dos o más ítems numerados en el mensaje es casi siempre este problema.
- [ ] Se entiende por sí sola, sin asumir que el padre ya leyó el diagnóstico o los pilares — cada viñeta dice qué cambia y por qué, en una frase corta, sin repetir el razonamiento completo de los pilares.
- [ ] **Sin colores ni emoji del semáforo** (ROJO/AMARILLO/VERDE, 🔴🟡🟢) en esta sección — esos van solo dentro del Pilar de Alimentación, más abajo.
- [ ] Para alimentos: dice **qué comer y cómo**, no qué NO comer ni cómo lo está haciendo mal la familia hoy (salvo que omitirlo deje la instrucción incompleta o ambigua) — para eso está el semáforo.
- [ ] Si una comida tiene variantes reportadas por el formulario (a veces come X, a veces Y), el plan recomienda **una sola opción consistente**, prefiriendo el alimento entero/real sobre la versión procesada (huevo sobre batido de proteína) — nunca combina las dos en una misma frase.
- [ ] Receta del suero: **NO se repite completa acá** — solo se nombra "suero casero"; la receta completa (agua + sal + limón con medida) va una sola vez, en el Pilar 1.
- [ ] El suero nunca se narra como si se tomara durante una comida — se lleva en termo para tomar FUERA de la comida (contradeciría "sin líquidos durante las comidas").
- [ ] Carbohidratos (arroz, papa, pasta de arroz/lentejas, plátano, arepa) siempre "de acompañante", nunca como base ni solos ni como merienda aparte.
- [ ] Sin temperatura especificada ("frío", "caliente") salvo necesidad clínica.
- [ ] Proteína y grasa no se presentan como alternativas intercambiables con "o" — ni en pares ("pollo o aguacate") ni en listas más largas ("huevo, pollo, aguacate o nueces"). Si se nombran varias, el rol de cada una queda explícito ("proteína: X; de acompañante: Y").
- [ ] Ningún alimento de proteína/grasa se presenta como si tuviera ambas cuando solo tiene una (aguacate/aceitunas/nueces NO tienen proteína, solo grasa).
- [ ] Nunca describe el hábito deseado como si ya estuviera pasando cuando el formulario reporta lo contrario ("no son la base" cuando sí lo son hoy) — usa lenguaje prescriptivo ("no deben ser", "debe ser", "va de acompañante").
- [ ] Nunca usa el nombre del padre/madre para dirigirse a él/ella en tercera persona ("Leonardo ajusta...") — siempre segunda persona, o sin nombre.
- [ ] Sin "el más importante"/"lo más importante"/"el cambio clave" salvo que la FUENTE lo diga explícito para ese caso — los hábitos son un conjunto integral.
- [ ] Ventana de alimentación propuesta: calculada con cuidado (ver sección 8.3 — cálculos), nunca con "aproximadamente".
- [ ] Fin de semana: la ventana queda **más corta**, nunca igual o más larga que la de semana (desayuno más tarde, cena igual de temprano) — sin narrar el mecanismo interno (la palabra que lo explica está prohibida).

---

## 5. PLAN BAJO EL SISTEMA DE REVERSIÓN BIOLÓGICA (SRB)

- [ ] Encabezado EXACTO "PLAN BAJO EL SISTEMA DE REVERSIÓN BIOLÓGICA (SRB)" — **nunca** "TE DEJO EL MAPA" (nombre retirado).
- [ ] Entre 2 y 4 pilares — solo los que el formulario respalda con datos reales **y** que están en la fuente adaptada.
- [ ] El semáforo va SIEMPRE dentro del Pilar de Alimentación — nunca como bloque aparte.

### 5.1 Pilar 1 — Hidratación real
- [ ] Suero casero: **2 g de sal por litro** (nunca los 5-7g de la fuente de adultos).
- [ ] Receta escrita como "**Por cada litro** de agua..." — nunca "1 litro de agua..." a secas (es una proporción, no un lote fijo).
- [ ] Medición de la sal concreta y aterrizada (sobre de 1g x2, cuchara medidora, o gramera) — nunca "una pizca generosa".
- [ ] Limón "al gusto" — **sin cantidad fija**, nunca "1 unidad de limón".
- [ ] El suero reemplaza el agua, **nunca "puede" tomarse** — es obligatorio, no una opción.
- [ ] Ninguna alternativa a "suero o agua con electrolitos" ofrece agua SOLA — "agua" nunca aparece como alternativa suelta.
- [ ] Regla de no tomar líquidos durante las comidas presente y consistente con cómo se describe el suero en otras secciones.
- [ ] Receta completa (con medida) aparece **una sola vez en todo el plan**, acá.

### 5.2 Pilar 2 — Proteína y grasa, siempre
- [ ] Título EXACTO "Proteína y grasa, siempre" — nunca "Proteína primero" ni "Proteína de calidad" sola.
- [ ] El mecanismo se atribuye a la carne (proteína + grasa juntas) — nunca a "proteína de calidad" o "proteína" sola.
- [ ] Carbohidrato (si lo hay) va de acompañante en porción pequeña, nunca como base.

**Semáforo** (dentro de este mismo pilar):
- [ ] Antes de los tres colores, una frase breve que introduce la subsección en general.
- [ ] Encabezados EXACTOS: "🔴 ROJO (eliminar por completo mientras equilibramos tu organismo)" / "🟡 AMARILLO (con moderación)" / "🟢 VERDE (prioridad en cada comida)".
- [ ] Justo después de ROJO: "Más adelante miraremos si algunos se pueden agregar al grupo de alimentos de la sección AMARILLO."
- [ ] Justo después de AMARILLO: una sola aclaración general de que son alimentos de acompañante — **sin repetir "(de acompañante)" en cada ítem**.
- [ ] **El color de cada alimento es FIJO según la fuente — no cambia según su rol en esa comida.** La regla "de acompañante = amarillo" es SOLO para carbohidratos (arroz, papa, pasta de arroz/lentejas, plátano, arepa) — nunca para grasas.
- [ ] Grasas (aguacate, aceitunas, nueces, pistacho, marañón, queso azul/roquefort) van SIEMPRE en VERDE, sean plato principal o acompañante.
- [ ] Huevo va SIEMPRE en VERDE, escrito "Huevos (clara y yema)" — nunca en AMARILLO.
- [ ] **Ningún alimento aparece en más de un color** — revisa cada alimento mencionado en CUALQUIER parte del plan (no solo dentro del semáforo) contra su color asignado.
- [ ] Verdura CRUDA/ensalada (pepino, tomate, lechuga, cualquier vegetal fresco, solanáceas crudas) — SIEMPRE ROJO.
- [ ] Verdura BIEN COCIDA — AMARILLO, sin restricción de cómo se sirve (plato aparte o acompañante, da igual).
- [ ] Las verduras NUNCA van en VERDE.
- [ ] Quesos: solo "queso azul" o "roquefort" nombrados específicamente (nunca "queso madurado/envejecido" genérico) — van en VERDE. Cualquier otro queso (parmesano, manchego, etc.) es ROJO, igual que el resto de lácteos no madurados (leche, queso fresco, yogur).
- [ ] Trigo decide el color, no "pasta"/"pan" genérico — ROJO solo cuando es de trigo; pasta/pan de arroz, quinua o lentejas es AMARILLO.
- [ ] Helados y salchipapas — SIEMPRE ROJO si el formulario los menciona.
- [ ] Lonchera/merienda: regla de oro — si hace 3 comidas completas, NO merienda; si hace falta, solo huevo duro, pollo, queso azul/roquefort, aguacate, aceitunas o nueces (set completo, no solo nueces) — CERO harinas, CERO carbohidratos, CERO galletas, siempre con suero/electrolitos.

### 5.3 Pilar 3 — Ritmo y ventana de alimentación
- [ ] Cena mínimo 3 horas antes de la hora real de dormir reportada — regla dura, misma cifra sin importar edad.
- [ ] Sin narrar el cálculo interno ("mínimo de 12 horas", "por encima del máximo", "corrección de ventana", "margen seguro", "mínimo de 3 horas", etc.) — el padre nunca ve la regla, solo el resultado ya correcto.
- [ ] Sin las palabras "ayuno", "ayunar", "ayuno nocturno", "autofagia" — aunque la fuente las use, están prohibidas (incluso citando o entre comillas).
- [ ] La recuperación nocturna se explica en términos metabólicos/hepáticos ("le da al cuerpo la noche para recuperarse") — nunca en términos de sistema nervioso o psicología.
- [ ] Pantallas: corte 1 hora antes de dormir (celular, tablet, TV, videojuegos) — hora calculada, no "reducir" vago. Alternativa: lectura en papel, juego libre, conversación.
- [ ] "No comer después de las 6pm" de la fuente NO es un horario fijo para todos los casos — se calcula desde la hora real de dormir de cada niño/a, restando 3 horas.

### 5.4 Pilar 4 — Movimiento como juego
- [ ] Se trata como juego/actividad que el niño/a ya disfruta — nunca como rutina estructurada con minutos o repeticiones (eso es el Pilar 5 de la fuente, prohibido en pediatría).
- [ ] No inventa condiciones que el formulario no reportó — cada sugerencia se ancla a algo concreto que el formulario sí dijo.

---

## 6. PARA LA PRÓXIMA CITA CON EL PEDIATRA (antes "Paso 0")

- [ ] Encabezado EXACTO "PARA LA PRÓXIMA CITA CON EL PEDIATRA".
- [ ] **Posición: al final del plan**, después de los pilares de la sección 5 — nunca dentro de "Diagnóstico breve".
- [ ] Si no aplica, la sección se omite por completo (no se inventa una para rellenar).
- [ ] Solo consultivo — nunca mediciones en casa (% de grasa corporal, tirillas de pH, básculas).
- [ ] Máximo 2 preguntas, formuladas como "si ya tienes un examen reciente de X, compártelo; si no, puedes preguntarle a tu pediatra si vale la pena".
- [ ] El indicador que menciona está genuinamente en la FUENTE SRB (ej. insulina en ayunas es el indicador explícito de la sección 6.2) — si el plan sugiere un examen distinto atado a un síntoma reportado (ej. electrolitos por dolor muscular), confirmar que hay base real, no es automático.
- [ ] Sin meta numérica de insulina en ayunas ni de ningún otro indicador (nunca "2.5 unidades", nunca "70-100g/día").

---

## 7. Cierre fijo (generado por código, no por el modelo)

- [ ] Después de "Para la próxima cita" (o después de los pilares si esa sección no aplica), el plan NO sigue generando nada más por su cuenta.
- [ ] El cierre fijo invita a seguimiento con Vita, preguntas, agregar información, o corregir/aclarar datos.
- [ ] Trae un link real y clicable al plan con `&tab=vita` (si `idPlan` existe en el momento de generar — en regeneraciones siempre existe; en generación nueva, existe desde que el Worker lo genera antes de llamar a Claude).

---

## 8. Reglas transversales (revisar sobre el texto completo, no por sección)

### 8.1 Tono y lenguaje
- [ ] Sin "debería" en ningún lado — "debe" (obligatorio) o "no requiere"/"no necesita" (condicional/opcional).
- [ ] Sin lenguaje celebratorio: "excelente", "perfecto"/"perfecta", "sigue así", "base sólida", "qué bueno que...", ninguna palabra de la familia "felicitar". El plan dice qué cambia, no evalúa lo que ya está bien.
- [ ] Sin contradicciones obvias (elogiar algo en una frase y corregirlo en la siguiente).
- [ ] Estructura de cada recomendación: explicación breve (causa → consecuencia, anclada a la fuente) + instrucción concreta — sin adornos ni introducciones largas.
- [ ] Español latinoamericano claro, nivel familiar/adolescente — sin jerga clínica cruda sin traducir, sin voseo.
- [ ] Sin "**negrilla**" (markdown) en ningún campo — énfasis real en MAYÚSCULAS (2-3 palabras, nunca una oración completa).
- [ ] Peso nunca es un objetivo, salvo que el padre lo plantee explícitamente o venga de un diagnóstico médico ya recibido. Nunca "dieta" ni imagen corporal.
- [ ] Si el formulario menciona un medicamento/pomada/suplemento que el niño/a usa: **silencio total** — ni para recomendar que lo deje, ni para decir que está bien seguirlo, ni para insinuar que ya no lo va a necesitar.
- [ ] La frase de escalamiento ("el equipo lo va a conversar contigo directamente") aparece SOLO si el formulario reporta señales reales de trastorno de conducta alimentaria, salud mental grave o algo médico agudo — nunca para horarios, rutinas o rituales de sueño, por más que falte información.

### 8.2 Formato
- [ ] Ninguna hora en formato de reloj de 24h ("19:00") ni con flechas ("06:00 → 19:00") en el texto visible — siempre "7:00 pm" como se le diría a un padre.
- [ ] Las 4 secciones fijas (+ la 5ª condicional) en el orden exacto, con encabezados exactos, sin parafrasear.

### 8.3 Cálculos (verificar con una calculadora, no a ojo)
- [ ] Ventana actual = hora de la primera comida reportada hasta la última comida/límite reportado o deducido — resta exacta en horas y minutos, nunca redondeada, nunca con "aproximadamente".
- [ ] Ventana propuesta ≤ 12 horas (máximo, no mínimo) — idealmente entre 11 y 12, nunca justo en el límite.
- [ ] Última comida propuesta ≥ 3 horas antes de la hora real de dormir reportada.
- [ ] Los 4 campos de reloj del JSON (`ventanaActual`, `ventanaPropuesta`, cada uno con `primeraComida`/`ultimaComida`, y `horaDormir`) coinciden exactamente con las horas escritas en el texto — si no coinciden, el texto o los campos están mal.
- [ ] Si falta un dato real (no deducible de ningún límite explícito), los campos de reloj correspondientes están en "00:00", no en una hora inventada.

### 8.4 Trazabilidad (la más importante de todas)
- [ ] Cada afirmación del plan se puede señalar en `FUENTE_SRB_PEDIATRICA` o `ADAPTACIONES_PEDIATRICAS` — si no, es una invención, sin importar qué tan razonable suene.
- [ ] Ninguna cifra de la fuente de ADULTOS se cuela sin adaptar: 1.5g de electrolitos/litro, 70-100g de carbohidratos/día, 60-80% de proteína, 2.5 unidades de insulina, 5-7g de sal — ninguna de estas va en un plan pediátrico.
- [ ] El texto NUNCA cita o nombra al SRB/la fuente/un documento — ni "(SRB — ...)", ni "según el SRB", ni "el SRB dice", ni "la fuente indica". Esa trazabilidad es interna, el padre no la ve.
- [ ] Sin lenguaje psicológico/neurológico sin base (ver 3. Diagnóstico breve) en NINGUNA sección, no solo en el diagnóstico — revisar también los pilares.

---

## 9. Peinado final — patrones que cruzan secciones

Después de revisar sección por sección, hacer una pasada más, buscando específicamente:

- [ ] **Cada alimento mencionado en todo el plan, con un único color asignado** — arma mentalmente (o en un borrador aparte) la lista de todos los alimentos nombrados en CUALQUIER sección (cronología, hábitos, pilares, semáforo) y confirma que el color que implican coincide en todas partes.
- [ ] **Ningún dato del encabezado (nombre, edad, responsable) se repite mal** en otra parte del texto (ej. el modelo narrando el nombre del padre en tercera persona en otra sección).
- [ ] **La receta del suero aparece una sola vez**, completa, en Pilar 1 — en cualquier otra mención, solo el nombre "suero casero".
- [ ] **Ninguna hora aparece dos veces con valores distintos** para el mismo evento (ej. la cena a las 6pm en una sección y a las 6:15pm en otra).
- [ ] **El "Para la próxima cita" no reaparece ni se duplica** en otra parte del plan bajo otro nombre.

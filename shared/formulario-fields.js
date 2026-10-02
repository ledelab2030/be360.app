// FUENTE ÚNICA de los campos del Formulario de Hábitos (2 oct 2026, pedido de
// Leonardo) — antes vivía triplicado (vita-demo-formulario, su copia
// vita-demo-formulario-v2, y una traducción a camelCase en panel) y se
// desincronizaba apenas alguien cambiaba un hint en un solo lugar. Ahora es
// el único archivo que define label/hint de cada campo; todo lo demás lo
// carga desde aquí.
//
// `var` a propósito (no `const`/`let`): necesita quedar accesible como
// identificador global en los `<script type="text/babel">` de cada página
// que lo cargan DESPUÉS con un <script src="..."> normal — `var` lo cuelga
// de `window` sin ambigüedad, el patrón más robusto para esto sin bundler.
//
// Si cambias un hint o una etiqueta acá, se refleja solo en las 3 páginas
// que lo usan (vita-demo-formulario, vita-demo-formulario-v2, panel) — no
// hay que tocar nada más.
var FIELDS = [
  { key:"nombre_padre", label:"Nombre del padre/madre" },
  { key:"email_padre", label:"Correo de contacto", hint:"Para enviarte el plan cuando esté listo." },
  { key:"nombre_nino", label:"Nombre del hijo/a" },
  { key:"edad", label:"Edad", hint:"2 años en adelante, sin límite superior." },
  { key:"que_deseas_lograr", label:"Qué desea lograr el padre", hint:"¿Qué te gustaría lograr con el programa para tu hijo/a?" },
  { key:"preocupacion_principal", label:"Preocupación principal", hint:"¿Qué es lo que MÁS te preocupa hoy de tu hijo/a?" },
  { key:"origen", label:"Origen (parto · lactancia)", hint:"Parto natural o cesárea, y cuánto tiempo tomó leche materna (o si no tomó)." },
  { key:"sueno_y_movimiento", label:"Sueño y movimiento", hint:"A qué hora se duerme y se levanta, cómo despierta, si se despierta en la noche, qué actividad física hace, si algo le duele al moverse." },
  { key:"senales_observables", label:"Señales observadas", hint:"Dolor o ardor de estómago, dolores de cabeza, gases, estreñimiento, ansiedad, fatiga, dificultad para concentrarse, sueño inquieto, piel irritada, infecciones frecuentes — lo que aplique." },
  { key:"diagnosticos_y_atencion_medica", label:"Diagnósticos y atención médica", hint:"Diagnósticos ya dados por un médico, medicación o tratamiento, especialistas que lo atienden." },
  { key:"cronologia_del_dia", label:"Cronología del día", hint:"Un día típico CON HORA APROXIMADA en cada momento (aunque sea \"como a las 7\"): qué come y bebe al levantarse, desayuno, media mañana, almuerzo, media tarde, cena, antes de dormir. La hora de la cena es especialmente importante para el equipo. En media mañana, indica si la lonchera es de casa o la compra en el colegio. Si varía el fin de semana." },
  { key:"finde_y_gustos", label:"Fin de semana y gustos", hint:"Qué suele comer los fines de semana, si algo le cae mal, qué alimentos le gustan y valdría la pena conservar." },
  { key:"mente_y_pantallas", label:"Mente y pantallas", hint:"Tipo de contenido y horas de pantalla al día, si las usa antes de dormir, si practica algo de relajación o respiración." },
  { key:"emociones", label:"Emociones", hint:"Emociones que observas con frecuencia (alegría, rabietas, ansiedad, frustración) — vale describirlo como comportamiento." },
];

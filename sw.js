// Service worker mínimo, solo para que Android ofrezca el aviso
// automático de instalación ("Agregar be360 a pantalla de inicio") en
// vez de depender de que alguien busque la opción en el menú del
// navegador — ver manifest.json e index.html (23 nov 2026).
//
// A PROPÓSITO NO CACHEA NADA: un service worker que cachea páginas y
// falla al invalidar el caché es la forma más común de que un sitio le
// sirva contenido viejo a alguien sin que nadie se entere — justo el
// tipo de falla silenciosa que este proyecto ya sufrió antes en otras
// partes del sistema. Este solo existe para cumplir el requisito técnico
// de instalabilidad de Chrome (un service worker activo con un listener
// de "fetch"); cada fetch pasa derecho a la red, nunca al caché.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});

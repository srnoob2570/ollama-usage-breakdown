# Ollama Usage Breakdown

Userscript de Tampermonkey que hace los medidores de uso de [ollama.com/settings](https://ollama.com/settings) mucho más legibles, con un desglose por modelo de tu uso de Ollama Cloud.

![Medidor de sesión con desglose por modelo de peticiones y porcentajes](./docs/session.png) ![Medidor semanal con porcentajes por modelo](./docs/weekly.png)

> English version available: [README.md](./README.md)

> Este userscript está generado y actualizado con ayuda de IA. No está afiliado a Ollama ni cuenta con su respaldo. Consulta [el aviso completo](#aviso-generado-por-ia) más abajo.

## Qué hace

- **Desglose de sesión.** Añade una lista "Models used this session" debajo del medidor de sesión, con el mismo estilo que la lista nativa "Models used this week" de Ollama (punto de color, nombre del modelo, contador de peticiones) más una columna extra.
- **Porcentaje por modelo.** Ollama solo reporta el "X% used" global. La parte de cada modelo existe únicamente en el HTML de la página, codificada como anchos de los segmentos de la barra. El script lee esos anchos, los reescala contra el uso global y muestra cuánto de tu límite total consumió cada modelo. Entre todos suman el X% que reporta Ollama (p. ej. `84.2%` de una sesión al `10.7%` → `9.01%`).
- **Porcentajes también en la semanal.** Inyecta el mismo porcentaje reescalado en la lista nativa "Models used this week" de Ollama.
- **Hora exacta de reset.** Añade la fecha y hora absolutas junto al tiempo relativo, p. ej. "Resets in 2 hours. (August 27, 2026 at 2:00 AM)".
- Sobrevive a las actualizaciones de htmx y a la navegación SPA, y se limpia al salir de la página de ajustes.

## Instalación

1. Instala [Tampermonkey](https://www.tampermonkey.net/) en tu navegador.
2. Abre el script en crudo: <https://raw.githubusercontent.com/srnoob2570/ollama-usage-breakdown/main/ollama-usage-breakdown.user.js>
3. Tampermonkey ofrecerá instalarlo. Después visita <https://ollama.com/settings>.

### Manual

Abre el panel de Tampermonkey, crea un script nuevo, pega el contenido de [`ollama-usage-breakdown.user.js`](./ollama-usage-breakdown.user.js) y guarda. Después visita <https://ollama.com/settings>.

## Notas

- Los porcentajes se leen del HTML de Ollama (anchos de los segmentos de la barra), no de una API privada. Si Ollama cambia su estructura, puede hacer falta actualizar el script.
- Solo se ejecuta en `https://ollama.com/settings` (URL exacta, no en `/settings/keys`, `/settings/billing` ni `/settings/profile`) y no requiere permisos especiales (`@grant none`).

## Aviso: generado por IA

Este userscript está escrito y mantenido con ayuda de IA. No está afiliado a Ollama, ni respaldado por ella, ni conectado con ella de ninguna forma.

- La IA escribe el código y un humano lo revisa antes de cada publicación. Los dos pueden equivocarse, así que puede contener errores o dejar de funcionar si Ollama cambia su web.
- Úsalo bajo tu propia responsabilidad y revisa siempre un userscript antes de instalarlo.
- Los issues y pull requests son bienvenidos, incluidas las correcciones de todo aquello que la IA haya hecho mal.
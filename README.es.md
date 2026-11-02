# opencode-in-chrome

**Tu agente OpenCode local, viviendo dentro de Chrome.**

Una alternativa libre y abierta a "Claude in Chrome": una extensión MV3 con panel lateral donde
tu **propia instalación de OpenCode** (las mismas sesiones, skills, agentes y modelos que ya usas
en el CLI) puede leer páginas, navegar, hacer clic, escribir, llenar formularios y automatizar
tareas de varios pasos en **tu navegador, con tus logins**.

```
OpenCode (CLI o servidor local) ──MCP──▶ oc-chrome-bridge ──native messaging──▶ extensión Chrome
```

- **Modo A — agente**: tu OpenCode maneja el navegador a través del servidor MCP `oc-chrome`.
- **Modo B — chat**: un chat de OpenCode en el panel lateral de Chrome, compartiendo sesiones con tu CLI, en ambas direcciones.

Todo corre **en tu máquina**: sin intermediarios en la nube, sin Docker, sin scripts por uso
(Chrome lanza el bridge automáticamente; se instala una sola vez).

> **Estado:** `v0.1.0-alpha` — Modo A (MCP) operativo y Modo B (chat en el panel)
> compartiendo sesiones con tu CLI. El panel necesita el servicio de fondo local
> de OpenCode; ver [Chat del panel](#chat-del-panel).

## Chat del panel

El panel usa el mismo servicio de fondo local de OpenCode que tu CLI. Arráncalo
antes de abrir el panel (o mantén `opencode` abierto en una terminal).
Abre el panel desde el icono de la extensión en la pestaña a la que quieras atarlo:

```sh
opencode service status
opencode service start   # si no está corriendo
```

Si no está corriendo, el panel muestra un aviso neutro con ese comando — sin
error, y se reconecta solo cuando el servicio arranca.

Si usas `opencode --standalone` o desactivaste el servicio compartido
(`opencode service set disabled true`), el panel no puede conectarse.

El panel crea sus sesiones con un ruleset `oc-chrome_*` → `ask`, así que las
herramientas de navegador quedan gateadas sin editar tu configuración de
OpenCode. Si también usas el Modo A desde el CLI y quieres un gate global, mira
el snippet de permisos en [packages/bridge/README.md](packages/bridge/README.md).

## Requisitos

| | Versión |
|---|---|
| [Bun](https://bun.com) | ≥ 1.4 (fijado en `.bun-version`) |
| Chrome / Chromium / Edge / Brave | MV3 (Chrome ≥ 116) |
| OpenCode | V2, con el servicio de fondo compartido ([cómo arrancarlo](#chat-del-panel)) |

## Desarrollo

```sh
bun install
bun test
```

Política de seguridad: [SECURITY.md](SECURITY.md) · Guía para contribuir: [CONTRIBUTING.md](CONTRIBUTING.md)

## Licencia

[MIT](LICENSE) — donado a todo el mundo.

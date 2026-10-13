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

> **Estado:** `v0.0.1` — andamio de Fase 0 (toolchain, esqueleto MV3, spike de native messaging).
> Las herramientas de navegador llegan en la Fase 1; la integración MCP en la Fase 2; el chat del
> panel en la Fase 3.

## Requisitos

| | Versión |
|---|---|
| [Bun](https://bun.com) | ≥ 1.4 (fijado en `.bun-version`) |
| Chrome / Chromium / Edge / Brave | MV3 (Chrome ≥ 116) |
| OpenCode | V2, con `opencode serve` / servicio de fondo |

## Desarrollo

```sh
bun install
bun test
```

Política de seguridad: [SECURITY.md](SECURITY.md) · Guía para contribuir: [CONTRIBUTING.md](CONTRIBUTING.md)

## Licencia

[MIT](LICENSE) — donado a todo el mundo.

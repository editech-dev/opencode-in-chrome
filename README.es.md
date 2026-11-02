# opencode-in-chrome

[![CI](https://github.com/editech-dev/opencode-in-chrome/actions/workflows/ci.yml/badge.svg)](https://github.com/editech-dev/opencode-in-chrome/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Tu agente [OpenCode](https://opencode.ai) local, viviendo dentro de Chrome.**

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
> Ver [CHANGELOG.md](CHANGELOG.md) para los cambios.

## Instalar desde el código

Requisitos: Bun ≥ 1.4, Chrome/Chromium/Edge/Brave ≥ 116 y OpenCode V2 con el
servicio de fondo compartido.

```sh
git clone https://github.com/editech-dev/opencode-in-chrome.git
cd opencode-in-chrome
bun install --frozen-lockfile
bun run build:ext
```

Luego carga la extensión:

1. Abre `chrome://extensions` y activa **Modo de desarrollador**.
2. Pulsa **Cargar descomprimida** y elige `packages/extension/.output/chrome-mv3`.
3. Copia el **ID** de la extensión desde la tarjeta.

Empareja la extensión con el bridge nativo y registra el servidor MCP:

```sh
bun run packages/bridge/src/cli.ts install --ext-id <id-de-chrome://extensions>
bun run packages/bridge/src/cli.ts mcp
```

Por último, arranca el servicio de OpenCode que usa el panel:

```sh
opencode service status
opencode service start   # si no está corriendo
```

El build desde código fija el ID con una clave de desarrollo
(`cbhldfhcghehekoofhncmimmngmdmjog`). Si Chrome muestra otro ID, usa el que
aparezca en `chrome://extensions`.

> **Builds de Chrome Web Store:** la tienda asigna su propio ID. El ZIP de tienda
> se genera con `bun run build:store`, que omite intencionalmente el `key` de
> desarrollo. Usa el ID del listing al ejecutar `install --ext-id`.

## Usar con OpenCode (Modo A)

Después de `oc-chrome-bridge mcp`, cualquier sesión de OpenCode puede pedir
`oc-chrome_tabs_context`, `oc-chrome_navigate`, `oc-chrome_get_page_text`,
`oc-chrome_computer`, etc. Cada acción corre en **un grupo de pestañas dedicado a
esa sesión** — aislado de tus pestañas, y desaparece al terminar la sesión.

Puedes gatear las herramientas como quieras (snippet de permisos en
[packages/bridge/README.md](packages/bridge/README.md); la clave de permiso
conserva el guion del servidor: `oc-chrome_*`).

## Chat del panel

El panel usa el mismo servicio de fondo local de OpenCode que tu CLI. Arráncalo
antes de abrir el panel (o mantén `opencode` abierto en una terminal):

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

## Permisos y privacidad

La extensión pide los permisos mínimos de Chrome para ser una mano del agente.
No pide host permissions ni inyecta content scripts en todas las páginas.

| Permiso | Para qué se usa |
|---|---|
| `nativeMessaging` | Hablar con `oc-chrome-bridge`, el host local que Chrome lanza en tu máquina. |
| `sidePanel` | Mostrar el chat de OpenCode en el panel lateral. |
| `storage` | Guardar ajustes locales, IDs de sesiones del panel y estado de conexión. |
| `alarms` | Mantener vivo el service worker MV3 y reconectar el bridge con backoff. |
| `tabs` | Leer URL/título de la pestaña activa y gestionar los grupos por sesión. |
| `tabGroups` | Aislar cada sesión de OpenCode en su propio grupo de pestañas. |
| `debugger` | Adjuntarse a la pestaña activa vía DevTools Protocol para clic, escritura, scroll, capturas y texto. |

Lo que se queda local:

- Sin telemetría, analytics, anuncios ni código remoto. La extensión solo habla
  con el bridge nativo local por native messaging.
- El bridge escucha solo en loopback y nunca expone el navegador a tu LAN.
- Las credenciales del servicio de OpenCode viven en el proceso host; la
  extensión nunca las ve.
- El contenido de las páginas se trata como **datos, no instrucciones**, y los
  patrones de secretos se redactan antes de llegar al modelo.
- Las herramientas de navegador están gateadas por los permisos de OpenCode
  (`ask` por defecto en las sesiones del panel).

Una excepción honesta: cuando le pides al agente leer una página, ese contenido
va al **proveedor de modelos configurado en OpenCode**. Si ese proveedor es
cloud, aplica su política de privacidad. El proyecto no añade un intermediario
en la nube.

Ver [PRIVACY.md](PRIVACY.md) para la política completa.

## Requisitos

| | Versión |
|---|---|
| [Bun](https://bun.com) | ≥ 1.4.4 (fijado en `.bun-version`) |
| Chrome / Chromium / Edge / Brave | MV3 (Chrome ≥ 116) |
| OpenCode | V2, con el servicio de fondo compartido ([cómo arrancarlo](#chat-del-panel)) |

## Desarrollo

```sh
bun install
bun test
bun run typecheck
bun run build:ext     # build dev/unpacked (conserva la clave de desarrollo)
bun run build:store   # ZIP de tienda (sin la clave dev; listo para Chrome Web Store)
```

El ZIP de tienda se escribe en `packages/extension/.output/` con
`manifest.json` en la raíz del archivo. Nunca subas el directorio de desarrollo
unpacked tal cual.

Documentación en inglés: [README.md](README.md) · Contribuir: [CONTRIBUTING.md](CONTRIBUTING.md) ·
Seguridad: [SECURITY.md](SECURITY.md) · Privacidad: [PRIVACY.md](PRIVACY.md)

## Construido con

Construido con [OpenCode](https://opencode.ai) usando **GLM 5.3 Flash** y
**DeepSeek V4.1 Flash**.

## Licencia

[MIT](LICENSE) — libre para todo el mundo.

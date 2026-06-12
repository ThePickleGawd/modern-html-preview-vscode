# Browser SSH Preview

VS Code extension for opening workspace HTML files and remote-only HTTP/HTTPS URLs inside VS Code.

## Commands

- `Browser SSH: Open HTML in VS Code Browser`
- `Browser SSH: Open URL in Remote Browser`
- `Browser SSH: Open URL at Cursor in Remote Browser`

HTML files can also be opened from the Explorer context menu.

## How Remote URL Viewing Works

For URL previews, this extension uses a remote reverse proxy instead of a remote screenshot stream:

1. The extension runs on the workspace extension host. In Remote SSH, that is the SSH server.
2. It starts a loopback-only HTTP proxy on the extension host.
3. The VS Code webview opens that proxy through VS Code's remote URI bridge.
4. The proxy fetches `http://127.0.0.1:3000` and other private URLs from the server side.
5. The VS Code webview renders the returned HTML/CSS/JS normally in an iframe.

This is designed to feel much closer to VS Code's built-in browser than screenshot streaming. There is no Chrome/Chromium requirement on the remote host.

This does not create a user-managed local port forward. It does use VS Code's existing remote URI bridge so the local webview can render the proxied page.

## Requirements

Install the extension on the workspace extension host. In Remote SSH, that means the remote side.

No browser binary is required on the remote host.

## Current Limits

The proxy handles same-origin development apps best. It strips frame-blocking headers, rewrites common HTML/CSS URLs, follows normal same-origin relative requests, and forwards WebSocket upgrades for development servers.

Some production sites with heavy CSP, service workers, unusual cross-origin bootstrapping, or JavaScript that hardcodes absolute external URLs may still need more proxy rewriting.

## HTML Files

Workspace `.html` files are still rendered directly in a webview. Local resource links are rewritten through VS Code's remote-aware file APIs so relative CSS, scripts, and images can load.

## Development

```sh
npm install
npm run compile
```

Then press `F5` in VS Code to launch an Extension Development Host.

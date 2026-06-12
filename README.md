# Browser SSH Remote Browser

VS Code extension for opening workspace HTML files and remote-only HTTP/HTTPS URLs inside VS Code.

## Commands

- `Browser SSH: Open HTML in VS Code Browser`
- `Browser SSH: Open URL in Remote Browser`
- `Browser SSH: Open URL at Cursor in Remote Browser`

HTML files can also be opened from the Explorer context menu.

## How Remote URL Viewing Works

For URL previews, this extension does not embed the URL in a normal VS Code webview iframe. Instead:

1. The extension runs on the workspace extension host. In Remote SSH, that is the SSH server.
2. It launches headless Chrome or Chromium on that host with Playwright Core.
3. Chrome navigates to the URL from the server, so `http://127.0.0.1:3000` means the server's loopback address.
4. The extension streams rendered JPEG frames to the VS Code webview.
5. Mouse, wheel, keyboard, back, forward, reload, and resize events are sent back to the remote browser.

This is closer to a tiny browser-specific remote desktop than a web proxy. HTTP traffic stays on the remote host. Rendered pixels and input events still cross the VS Code extension channel because they are needed to display and control the browser locally.

This is not X11 forwarding. It does not require an X server on your local machine.

## Requirements

Chrome or Chromium must be installed on the extension host.

Auto-detection checks common Linux, macOS, Windows, and `PATH` locations. If needed, set:

```json
{
  "vscode-browser-ssh.browserExecutablePath": "/usr/bin/chromium"
}
```

Useful Debian/Ubuntu install:

```sh
sudo apt-get update
sudo apt-get install -y chromium
```

No-sudo install using Playwright's browser cache:

```sh
node ~/.vscode-server/extensions/local.vscode-browser-ssh-0.0.1/node_modules/playwright-core/cli.js install chromium
```

That downloads Chromium under your user account, usually in `~/.cache/ms-playwright`. The extension auto-detects this Playwright-managed browser. On VS Code Insiders or other remote extension layouts, adjust the extension directory path accordingly.

## Settings

- `vscode-browser-ssh.browserExecutablePath`: absolute path to Chrome/Chromium on the extension host.
- `vscode-browser-ssh.frameRate`: streamed frame rate, default `6`.
- `vscode-browser-ssh.jpegQuality`: streamed JPEG quality, default `72`.
- `vscode-browser-ssh.launchArgs`: launch flags for the remote browser, default includes `--no-sandbox` and `--disable-dev-shm-usage`.

## HTML Files

Workspace `.html` files are still rendered directly in a webview. Local resource links are rewritten through VS Code's remote-aware file APIs so relative CSS, scripts, and images can load.

## Development

```sh
npm install
npm run compile
```

Then press `F5` in VS Code to launch an Extension Development Host.

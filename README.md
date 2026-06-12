# Modern HTML Preview

Open an `.html` or `.htm` file and press `cmd+shift+v` on macOS or `ctrl+shift+v` elsewhere.

## Why Not HTML Preview?

Traditional HTML preview injects HTML into a webview. Modern HTML Preview serves the file from an HTTP origin, so inline scripts, ES modules, relative `fetch()`, CSS, images, fonts, anchors, forms, unsaved edits, and asset reloads behave much more like a real browser.

## Why Not Live Server?

Live Server needs a forwarded port in remote workspaces. In some setups, like Remote Tunnels, you cannot do that. Modern HTML Preview works from the editor shortcut without managing a server or port.

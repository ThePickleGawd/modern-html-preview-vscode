# Improved HTML Preview

Browser-like HTML preview for VS Code.

## Why This Is Better

Traditional HTML preview extensions often inject HTML into a VS Code webview and rewrite asset URLs. That breaks pages that rely on normal browser behavior.

This extension serves workspace HTML from a loopback HTTP origin, so it supports:

- Inline scripts, including reveal/animation code
- ES modules and relative `fetch()`
- Relative and root-relative CSS, JS, images, fonts, anchors, and forms
- Unsaved editor contents and reloads when related assets change
- Remote SSH localhost/private URLs through VS Code's remote URI bridge

## Commands

- `Improved HTML Preview: Open HTML Preview`
- `Improved HTML Preview: Open URL Preview`
- `Improved HTML Preview: Open URL at Cursor`

HTML preview also binds `cmd+shift+v` / `ctrl+shift+v` for `.html` and `.htm` files. The extension intentionally adds no context menu items.

## Development

```sh
npm install
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host.

import * as vscode from 'vscode';
import { createServer } from 'http';
import type { IncomingMessage, Server, ServerResponse } from 'http';
import { connect as netConnect } from 'net';
import type { AddressInfo } from 'net';
import * as path from 'path';
import type { Duplex } from 'stream';
import { connect as tlsConnect } from 'tls';

const HTTP_URL_RE = /^https?:\/\//i;
const URL_LIKE_RE = /\bhttps?:\/\/[^\s<>"']+/i;
const htmlPreviewPanels = new Map<string, HtmlPreviewEntry>();
const MIME_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.cjs': 'text/javascript',
  '.css': 'text/css',
  '.gif': 'image/gif',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.mjs': 'text/javascript',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml',
};
const TEXT_MIME_TYPES = new Set([
  '.cjs',
  '.css',
  '.htm',
  '.html',
  '.js',
  '.json',
  '.map',
  '.mjs',
  '.svg',
  '.txt',
  '.xml',
]);

interface HtmlPreviewEntry {
  readonly panel: vscode.WebviewPanel;
  readonly session: LocalHtmlPreviewSession;
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('improved-html-preview.openHtml', (resource?: vscode.Uri) => openHtmlPreview(context, resource)),
    vscode.commands.registerCommand('improved-html-preview.openUrl', (url?: string) => openUrlPreview(context, url)),
    vscode.commands.registerCommand('improved-html-preview.openUrlAtCursor', () => openUrlAtCursor(context)),
  );
}

export function deactivate(): void {
  // No-op.
}

async function openHtmlPreview(context: vscode.ExtensionContext, resource?: vscode.Uri): Promise<void> {
  const uri = resource ?? vscode.window.activeTextEditor?.document.uri;

  if (!uri) {
    void vscode.window.showWarningMessage('Open an HTML file first, or run this command from an HTML file context menu.');
    return;
  }

  const title = `Preview: ${basename(uri)}`;
  const existingEntry = htmlPreviewPanels.get(uri.toString());

  if (existingEntry) {
    existingEntry.panel.reveal(vscode.ViewColumn.Active);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'improvedHtmlPreview',
    title,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );
  const session = new LocalHtmlPreviewSession(uri);
  let disposed = false;

  const reload = debounce(async () => {
    if (disposed) {
      return;
    }

    try {
      await panel.webview.postMessage({
        type: 'htmlReload',
        frameSrc: await session.frameSrcForDocument(),
      } satisfies ExtensionToWebviewMessage);
    } catch (error) {
      panel.webview.html = buildErrorPage(panel.webview, `Could not open ${uri.toString()}`, error);
    }
  }, 150);

  try {
    const frameSrc = await session.start();
    panel.webview.html = buildLocalHtmlPreview(panel.webview, uri, frameSrc);
  } catch (error) {
    panel.webview.html = buildErrorPage(panel.webview, `Could not open ${uri.toString()}`, error);
  }

  const messageSub = panel.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
    if (message.type !== 'htmlReload') {
      return;
    }

    try {
      await panel.webview.postMessage({
        type: 'htmlReload',
        frameSrc: await session.frameSrcForDocument(),
      } satisfies ExtensionToWebviewMessage);
    } catch (error) {
      await panel.webview.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      } satisfies ExtensionToWebviewMessage);
    }
  }, null, context.subscriptions);

  const changeSub = vscode.workspace.onDidChangeTextDocument((event) => {
    if (session.containsUri(event.document.uri)) {
      reload();
    }
  });

  const saveSub = vscode.workspace.onDidSaveTextDocument((document) => {
    if (session.containsUri(document.uri)) {
      reload();
    }
  });

  const watcher = createPreviewWatcher(session.rootUri);

  watcher?.onDidCreate(reload, null, context.subscriptions);
  watcher?.onDidChange(reload, null, context.subscriptions);
  watcher?.onDidDelete(reload, null, context.subscriptions);

  panel.onDidDispose(() => {
    disposed = true;
    htmlPreviewPanels.delete(uri.toString());
    void session.dispose();
    messageSub.dispose();
    changeSub.dispose();
    saveSub.dispose();
    watcher?.dispose();
  }, null, context.subscriptions);

  htmlPreviewPanels.set(uri.toString(), { panel, session });
}

async function openUrlPreview(context: vscode.ExtensionContext, initialUrl?: string): Promise<void> {
  const url = await resolveUrlInput(initialUrl);

  if (!url) {
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'improvedHtmlPreviewUrl',
    `Browser: ${url}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );
  const session = new RemoteProxyBrowserSession(panel, url);
  const frameSrc = await session.start();

  panel.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
    await session.handleMessage(message);
  }, null, context.subscriptions);

  panel.onDidDispose(() => {
    void session.dispose();
  }, null, context.subscriptions);

  panel.webview.html = buildProxyBrowserPreview(panel.webview, url, frameSrc);
}

async function openUrlAtCursor(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const selected = editor?.document.getText(editor.selection).trim();
  const match = selected?.match(URL_LIKE_RE) ?? editor?.document.lineAt(editor.selection.active.line).text.match(URL_LIKE_RE);
  await openUrlPreview(context, match?.[0]);
}

class LocalHtmlPreviewSession {
  readonly rootUri: vscode.Uri;

  private server: Server | undefined;
  private port = 0;

  constructor(private readonly documentUri: vscode.Uri) {
    this.rootUri = vscode.workspace.getWorkspaceFolder(documentUri)?.uri ?? dirname(documentUri);
  }

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      void this.handleFileRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(0, '127.0.0.1', () => resolve());
    });

    const address = this.server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Could not start local preview server.');
    }

    this.port = (address as AddressInfo).port;
    return this.frameSrcForDocument();
  }

  async frameSrcForDocument(): Promise<string> {
    if (!this.port) {
      throw new Error('Local preview server is not running.');
    }

    const route = this.virtualPathForUri(this.documentUri);
    const localUri = vscode.Uri.parse(`http://127.0.0.1:${this.port}${route}`);
    return (await vscode.env.asExternalUri(localUri)).toString();
  }

  containsUri(uri: vscode.Uri): boolean {
    if (uri.scheme !== this.rootUri.scheme || uri.authority !== this.rootUri.authority) {
      return false;
    }

    const rootPath = trimTrailingSlash(this.rootUri.path);
    const filePath = trimTrailingSlash(uri.path);
    return filePath === rootPath || filePath.startsWith(`${rootPath}/`);
  }

  async dispose(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
      if (!this.server) {
        resolve();
      }
    });
    this.server = undefined;
  }

  private async handleFileRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const resourceUri = await this.resourceUriForRequest(request);

      if (!resourceUri || !this.containsUri(resourceUri)) {
        respondText(response, 404, 'Not found');
        return;
      }

      const bytes = await this.readPreviewBytes(resourceUri);
      const contentType = contentTypeForPath(resourceUri.path);
      const range = parseRangeHeader(request.headers.range, bytes.byteLength);

      if (range) {
        response.writeHead(206, {
          'accept-ranges': 'bytes',
          'cache-control': 'no-cache',
          'content-length': String(range.end - range.start + 1),
          'content-range': `bytes ${range.start}-${range.end}/${bytes.byteLength}`,
          'content-type': contentType,
        });

        if (request.method === 'HEAD') {
          response.end();
          return;
        }

        response.end(bytes.subarray(range.start, range.end + 1));
        return;
      }

      response.writeHead(200, {
        'accept-ranges': 'bytes',
        'cache-control': 'no-cache',
        'content-length': String(bytes.byteLength),
        'content-type': contentType,
      });

      if (request.method === 'HEAD') {
        response.end();
        return;
      }

      response.end(bytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes('FileNotFound')) {
        respondText(response, 404, 'Not found');
        return;
      }

      respondText(response, 500, message);
    }
  }

  private async resourceUriForRequest(request: IncomingMessage): Promise<vscode.Uri | undefined> {
    const parsed = new URL(request.url ?? '/', 'http://127.0.0.1');
    const pathSegments = safeRequestSegments(parsed.pathname);
    let resourceUri = pathSegments.length === 0
      ? vscode.Uri.joinPath(this.rootUri, 'index.html')
      : vscode.Uri.joinPath(this.rootUri, ...pathSegments);

    try {
      const stat = await vscode.workspace.fs.stat(resourceUri);

      if (stat.type === vscode.FileType.Directory) {
        resourceUri = vscode.Uri.joinPath(resourceUri, 'index.html');
      }
    } catch {
      // The read path will produce the final 404. Keeping stat optional also lets
      // unsaved text documents be served from VS Code memory.
    }

    return resourceUri;
  }

  private async readPreviewBytes(uri: vscode.Uri): Promise<Buffer> {
    const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());

    if (openDocument) {
      return Buffer.from(openDocument.getText(), 'utf8');
    }

    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes);
  }

  private virtualPathForUri(uri: vscode.Uri): string {
    const rootPath = trimTrailingSlash(this.rootUri.path);
    const filePath = trimTrailingSlash(uri.path);
    const relativePath = filePath === rootPath
      ? ''
      : filePath.startsWith(`${rootPath}/`)
        ? filePath.slice(rootPath.length + 1)
        : basename(uri);

    const encoded = relativePath
      .split('/')
      .filter(Boolean)
      .map(encodeURIComponent)
      .join('/');

    return `/${encoded}`;
  }
}

class RemoteProxyBrowserSession {
  private server: Server | undefined;
  private port = 0;
  private currentOrigin: string;

  constructor(
    private readonly panel: vscode.WebviewPanel,
    initialUrl: string,
  ) {
    const parsed = new URL(initialUrl);
    this.currentOrigin = parsed.origin;
  }

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      void this.handleHttpRequest(request, response);
    });
    this.server.on('upgrade', (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(0, '127.0.0.1', () => resolve());
    });

    const address = this.server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Could not start URL preview server.');
    }

    this.port = (address as AddressInfo).port;
    return this.frameSrcFor(new URL(this.currentOrigin));
  }

  async handleMessage(message: WebviewMessage): Promise<void> {
    if (message.type !== 'proxyNavigate') {
      return;
    }

    const url = normalizeUrl(message.url);

    if (!url) {
      await this.panel.webview.postMessage({
        type: 'error',
        message: 'Enter a valid http:// or https:// URL.',
      } satisfies ExtensionToWebviewMessage);
      return;
    }

    const parsed = new URL(url);
    this.currentOrigin = parsed.origin;
    const frameSrc = await this.frameSrcFor(parsed);
    this.panel.title = `Browser: ${url}`;
    await this.panel.webview.postMessage({
      type: 'proxyNavigate',
      frameSrc,
      url,
    } satisfies ExtensionToWebviewMessage);
  }

  async dispose(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
      if (!this.server) {
        resolve();
      }
    });
    this.server = undefined;
  }

  private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const target = this.targetUrlForRequest(request);
      const body = await readRequestBody(request);
      const upstream = await fetch(target, {
        method: request.method,
        headers: requestHeadersForTarget(request, target),
        body,
        redirect: 'manual',
      });

      if (isHtmlRequest(request, upstream)) {
        this.currentOrigin = upstream.url ? new URL(upstream.url).origin : target.origin;
      }

      response.writeHead(upstream.status, responseHeadersForClient(upstream.headers, this.port, this.currentOrigin));

      const contentType = upstream.headers.get('content-type') ?? '';

      if (isRedirect(upstream.status)) {
        response.end();
        return;
      }

      if (contentType.includes('text/html')) {
        const html = await upstream.text();
        response.end(rewriteHtmlForProxy(html, upstream.url || target.toString(), this.currentOrigin));
        return;
      }

      if (contentType.includes('text/css')) {
        const css = await upstream.text();
        response.end(rewriteCssForProxy(css, upstream.url || target.toString(), this.currentOrigin));
        return;
      }

      const bytes = Buffer.from(await upstream.arrayBuffer());
      response.end(bytes);
    } catch (error) {
      response.writeHead(502, {
        'content-type': 'text/plain; charset=utf-8',
      });
      response.end(error instanceof Error ? error.message : String(error));
    }
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    let target: URL;

    try {
      target = this.targetUrlForRequest(request);
      target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    } catch {
      socket.destroy();
      return;
    }

    const isSecure = target.protocol === 'wss:';
    const port = Number(target.port || (isSecure ? 443 : 80));
    const upstream = isSecure
      ? tlsConnect({ host: target.hostname, port, servername: target.hostname })
      : netConnect({ host: target.hostname, port });

    upstream.on('connect', () => {
      const path = `${target.pathname}${target.search}`;
      const headers = upgradeHeadersForTarget(request, target);
      upstream.write(`${request.method ?? 'GET'} ${path || '/'} HTTP/${request.httpVersion}\r\n${headers}\r\n`);

      if (head.length > 0) {
        upstream.write(head);
      }

      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  }

  private targetUrlForRequest(request: IncomingMessage): URL {
    const rawUrl = request.url ?? '/';
    const local = new URL(rawUrl, 'http://127.0.0.1');

    if (local.pathname.startsWith('/__vscode_browser_ssh__/abs/')) {
      const encoded = local.pathname.slice('/__vscode_browser_ssh__/abs/'.length);
      return new URL(decodeBase64Url(encoded));
    }

    return new URL(`${local.pathname}${local.search}`, this.currentOrigin);
  }

  private async frameSrcFor(target: URL): Promise<string> {
    const localUri = vscode.Uri.parse(`http://127.0.0.1:${this.port}${target.pathname}${target.search}${target.hash}`);
    return (await vscode.env.asExternalUri(localUri)).toString();
  }
}

function buildLocalHtmlPreview(webview: vscode.Webview, fileUri: vscode.Uri, frameSrc: string): string {
  const nonce = getNonce();
  const title = basename(fileUri);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http: https:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      --border: color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
      --button-bg: var(--vscode-button-secondaryBackground);
      --button-fg: var(--vscode-button-secondaryForeground);
      --button-hover: var(--vscode-button-secondaryHoverBackground);
    }

    * {
      box-sizing: border-box;
    }

    body {
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
      height: 100vh;
      margin: 0;
      overflow: hidden;
    }

    .toolbar {
      align-items: center;
      border-bottom: 1px solid var(--border);
      display: grid;
      gap: 8px;
      grid-template-columns: minmax(120px, 1fr) auto;
      height: 36px;
      padding: 5px 8px;
    }

    .path {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    button {
      background: var(--button-bg);
      border: 0;
      color: var(--button-fg);
      cursor: pointer;
      font: inherit;
      height: 26px;
      padding: 0 10px;
    }

    button:hover {
      background: var(--button-hover);
    }

    iframe {
      background: white;
      border: 0;
      display: block;
      height: calc(100vh - 36px);
      width: 100vw;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <div class="path" title="${escapeAttr(fileUri.fsPath || fileUri.toString())}">${escapeHtml(fileUri.fsPath || fileUri.toString())}</div>
    <button id="reload" type="button" title="Reload preview">Reload</button>
  </div>
  <iframe id="frame" src="${escapeAttr(frameSrc)}" sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"></iframe>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let frame = document.getElementById('frame');
    const reload = document.getElementById('reload');

    function loadFrame(src) {
      const next = frame.cloneNode(false);
      next.src = src;
      frame.replaceWith(next);
      frame = next;
    }

    reload.addEventListener('click', () => {
      vscode.postMessage({ type: 'htmlReload' });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;

      if (message && message.type === 'htmlReload') {
        loadFrame(message.frameSrc);
      }

      if (message && message.type === 'error') {
        console.error(message.message);
      }
    });
  </script>
</body>
</html>`;
}

function buildProxyBrowserPreview(webview: vscode.Webview, initialUrl: string, frameSrc: string): string {
  const nonce = getNonce();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http: https:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Improved HTML Preview</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      --border: color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --button-bg: var(--vscode-button-background);
      --button-fg: var(--vscode-button-foreground);
      --button-hover: var(--vscode-button-hoverBackground);
      --error: var(--vscode-errorForeground);
    }

    * {
      box-sizing: border-box;
    }

    body {
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
      height: 100vh;
      margin: 0;
      overflow: hidden;
    }

    form {
      align-items: center;
      border-bottom: 1px solid var(--border);
      display: grid;
      gap: 8px;
      grid-template-columns: minmax(160px, 1fr) auto minmax(120px, auto);
      height: 42px;
      padding: 6px 8px;
    }

    input {
      background: var(--input-bg);
      border: 1px solid var(--border);
      color: var(--input-fg);
      font: inherit;
      height: 28px;
      min-width: 0;
      padding: 0 8px;
    }

    button {
      background: var(--button-bg);
      border: 0;
      color: var(--button-fg);
      cursor: pointer;
      font: inherit;
      height: 28px;
      padding: 0 10px;
    }

    button:hover {
      background: var(--button-hover);
    }

    #status {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #status.is-error {
      color: var(--error);
    }

    iframe {
      border: 0;
      display: block;
      height: calc(100vh - 42px);
      width: 100vw;
    }
  </style>
</head>
<body>
  <form id="toolbar">
    <input id="address" type="url" spellcheck="false" value="${escapeAttr(initialUrl)}" aria-label="URL">
    <button type="submit">Go</button>
    <span id="status">URL preview</span>
  </form>
  <iframe id="frame" src="${escapeAttr(frameSrc)}" sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"></iframe>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const form = document.getElementById('toolbar');
    const input = document.getElementById('address');
    const frame = document.getElementById('frame');
    const status = document.getElementById('status');

    function normalize(value) {
      const trimmed = value.trim();
      return /^https?:\\/\\//i.test(trimmed) ? trimmed : 'http://' + trimmed;
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      status.textContent = 'Navigating...';
      status.classList.remove('is-error');
      vscode.postMessage({ type: 'proxyNavigate', url: normalize(input.value) });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;

      if (message && message.__improvedHtmlPreviewProxy === true && message.url) {
        input.value = message.url;
        status.textContent = 'URL preview';
      }

      if (message.type === 'proxyNavigate') {
        input.value = message.url;
        frame.src = message.frameSrc;
        status.textContent = 'URL preview';
        status.classList.remove('is-error');
      }

      if (message.type === 'error') {
        status.textContent = message.message;
        status.classList.add('is-error');
      }
    });
  </script>
</body>
</html>`;
}

function buildErrorPage(webview: vscode.Webview, heading: string, error: unknown): string {
  const nonce = getNonce();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style nonce="${nonce}">
    body {
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
      padding: 24px;
    }

    pre {
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <h1>${escapeHtml(heading)}</h1>
  <pre>${escapeHtml(String(error instanceof Error ? error.message : error))}</pre>
</body>
</html>`;
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') {
    return undefined;
  }

  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function requestHeadersForTarget(request: IncomingMessage, target: URL): Headers {
  const headers = new Headers();

  for (const [name, value] of Object.entries(request.headers)) {
    if (!value || shouldDropRequestHeader(name)) {
      continue;
    }

    const text = Array.isArray(value) ? value.join(', ') : value;
    headers.set(name, text);
  }

  headers.set('host', target.host);
  headers.set('origin', target.origin);
  return headers;
}

function upgradeHeadersForTarget(request: IncomingMessage, target: URL): string {
  const lines: string[] = [];

  for (const [name, value] of Object.entries(request.headers)) {
    if (!value || name.toLowerCase() === 'host') {
      continue;
    }

    lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`);
  }

  lines.push(`host: ${target.host}`);
  return `${lines.join('\r\n')}\r\n`;
}

function responseHeadersForClient(headers: Headers, proxyPort: number, currentOrigin: string): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {};

  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();

    if (shouldDropResponseHeader(lower)) {
      continue;
    }

    if (lower === 'location') {
      output[name] = proxyPathForUrl(new URL(value, currentOrigin).toString());
      continue;
    }

    if (lower === 'set-cookie') {
      output[name] = rewriteSetCookie(value);
      continue;
    }

    output[name] = value;
  }

  output['access-control-allow-origin'] = '*';
  output['x-improved-html-preview-proxy-port'] = String(proxyPort);
  return output;
}

function rewriteHtmlForProxy(html: string, documentUrl: string, currentOrigin: string): string {
  const rewritten = html
    .replace(/\b(src|href|action|poster)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi, (match, attr: string, raw: string, doubleQuoted?: string, singleQuoted?: string, unquoted?: string) => {
      const value = doubleQuoted ?? singleQuoted ?? unquoted ?? '';
      const next = rewriteBrowserUrl(value, documentUrl, currentOrigin);

      if (next === value) {
        return match;
      }

      const quote = raw.startsWith("'") ? "'" : '"';
      return `${attr}=${quote}${escapeAttr(next)}${quote}`;
    })
    .replace(/\bsrcset\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi, (match, raw: string, doubleQuoted?: string, singleQuoted?: string, unquoted?: string) => {
      const value = doubleQuoted ?? singleQuoted ?? unquoted ?? '';
      const next = value
        .split(',')
        .map((candidate) => {
          const trimmed = candidate.trim();
          const firstSpace = trimmed.search(/\s/);

          if (firstSpace === -1) {
            return rewriteBrowserUrl(trimmed, documentUrl, currentOrigin);
          }

          return `${rewriteBrowserUrl(trimmed.slice(0, firstSpace), documentUrl, currentOrigin)}${trimmed.slice(firstSpace)}`;
        })
        .join(', ');

      const quote = raw.startsWith("'") ? "'" : '"';
      return `srcset=${quote}${escapeAttr(next)}${quote}`;
    });

  const script = `<script>try{parent.postMessage({__improvedHtmlPreviewProxy:true,url:${JSON.stringify(documentUrl)}},'*')}catch(_){}</script>`;

  if (/<head[^>]*>/i.test(rewritten)) {
    return rewritten.replace(/<head([^>]*)>/i, `<head$1>${script}`);
  }

  return `${script}${rewritten}`;
}

function rewriteCssForProxy(css: string, documentUrl: string, currentOrigin: string): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote: string, value: string) => {
    const next = rewriteBrowserUrl(value.trim(), documentUrl, currentOrigin);
    return next === value ? match : `url(${quote}${next}${quote})`;
  });
}

function rewriteBrowserUrl(value: string, documentUrl: string, currentOrigin: string): string {
  if (!value || /^(?:#|data:|blob:|mailto:|tel:|javascript:)/i.test(value)) {
    return value;
  }

  try {
    const absolute = new URL(value, documentUrl);

    if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') {
      return value;
    }

    if (absolute.origin === currentOrigin) {
      return `${absolute.pathname}${absolute.search}${absolute.hash}`;
    }

    return proxyPathForUrl(absolute.toString());
  } catch {
    return value;
  }
}

function proxyPathForUrl(url: string): string {
  return `/__vscode_browser_ssh__/abs/${encodeBase64Url(url)}`;
}

function createPreviewWatcher(rootUri: vscode.Uri): vscode.FileSystemWatcher | undefined {
  if (rootUri.scheme !== 'file') {
    return undefined;
  }

  return vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(
      rootUri.fsPath,
      '**/*.{html,htm,css,js,mjs,cjs,json,svg,png,jpg,jpeg,gif,webp,avif,ico,txt,xml,wasm,woff,woff2,ttf,otf,mp4,webm,mp3,wav}',
    ),
  );
}

function safeRequestSegments(pathname: string): string[] {
  const segments: string[] = [];

  for (const rawSegment of pathname.split('/')) {
    if (!rawSegment) {
      continue;
    }

    let segment: string;

    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      segment = rawSegment;
    }

    if (segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\')) {
      continue;
    }

    segments.push(segment);
  }

  return segments;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '') || '/';
}

function contentTypeForPath(filePath: string): string {
  const ext = path.posix.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
  return TEXT_MIME_TYPES.has(ext) ? `${contentType}; charset=utf-8` : contentType;
}

function parseRangeHeader(value: string | undefined, size: number): { start: number; end: number } | undefined {
  if (!value) {
    return undefined;
  }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());

  if (!match) {
    return undefined;
  }

  const [, rawStart, rawEnd] = match;
  let start = rawStart ? Number(rawStart) : 0;
  let end = rawEnd ? Number(rawEnd) : size - 1;

  if (!rawStart && rawEnd) {
    const suffixLength = Number(rawEnd);
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) {
    return undefined;
  }

  return {
    start,
    end: Math.min(end, size - 1),
  };
}

function respondText(response: ServerResponse, status: number, message: string): void {
  const bytes = Buffer.from(message, 'utf8');
  response.writeHead(status, {
    'cache-control': 'no-cache',
    'content-length': String(bytes.byteLength),
    'content-type': 'text/plain; charset=utf-8',
  });
  response.end(bytes);
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function shouldDropRequestHeader(name: string): boolean {
  return ['host', 'connection', 'content-length', 'accept-encoding'].includes(name.toLowerCase());
}

function shouldDropResponseHeader(name: string): boolean {
  return [
    'content-encoding',
    'content-length',
    'content-security-policy',
    'content-security-policy-report-only',
    'cross-origin-embedder-policy',
    'cross-origin-opener-policy',
    'cross-origin-resource-policy',
    'transfer-encoding',
    'x-frame-options',
  ].includes(name.toLowerCase());
}

function rewriteSetCookie(value: string): string {
  return value
    .replace(/;\s*domain=[^;]*/gi, '')
    .replace(/;\s*secure/gi, '');
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function isHtmlRequest(request: IncomingMessage, response: Response): boolean {
  const accept = request.headers.accept ?? '';
  const contentType = response.headers.get('content-type') ?? '';
  return contentType.includes('text/html') || String(accept).includes('text/html');
}

async function resolveUrlInput(initialUrl?: string): Promise<string | undefined> {
  const candidate = normalizeUrl(initialUrl?.trim());

  if (candidate) {
    return candidate;
  }

  const clipboard = normalizeUrl((await vscode.env.clipboard.readText()).trim());
  const value = await vscode.window.showInputBox({
    title: 'Open URL Preview',
    prompt: 'Enter an http:// or https:// URL. If no scheme is provided, http:// is used.',
    value: clipboard,
    validateInput: (input) => normalizeUrl(input.trim()) ? undefined : 'Enter a valid http:// or https:// URL.',
  });

  return normalizeUrl(value?.trim());
}

function normalizeUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const withScheme = HTTP_URL_RE.test(value) ? value : `http://${value}`;

  try {
    const parsed = new URL(withScheme);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function dirname(uri: vscode.Uri): vscode.Uri {
  const path = uri.path.replace(/\/[^/]*$/, '') || '/';
  return uri.with({ path });
}

function basename(uri: vscode.Uri): string {
  const raw = uri.path.split('/').filter(Boolean).at(-1) ?? uri.toString();

  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function debounce(callback: () => void, delayMs: number): () => void {
  let timer: NodeJS.Timeout | undefined;

  return () => {
    if (timer) {
      clearTimeout(timer);
    }

    timer = setTimeout(callback, delayMs);
  };
}

function getNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';

  for (let index = 0; index < 32; index += 1) {
    text += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }

  return text;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

type WebviewMessage =
  | { type: 'htmlReload' }
  | { type: 'proxyNavigate'; url?: string };

type ExtensionToWebviewMessage =
  | { type: 'htmlReload'; frameSrc: string }
  | { type: 'proxyNavigate'; frameSrc: string; url: string }
  | { type: 'error'; message: string };

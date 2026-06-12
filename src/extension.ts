import * as vscode from 'vscode';
import { createServer } from 'http';
import type { IncomingMessage, Server, ServerResponse } from 'http';
import { connect as netConnect } from 'net';
import type { AddressInfo } from 'net';
import type { Duplex } from 'stream';
import { connect as tlsConnect } from 'tls';

const HTTP_URL_RE = /^https?:\/\//i;
const URL_LIKE_RE = /\bhttps?:\/\/[^\s<>"']+/i;
const htmlPreviewPanels = new Map<string, vscode.WebviewPanel>();

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('vscode-browser-ssh.openHtml', (resource?: vscode.Uri) => openHtmlPreview(context, resource)),
    vscode.commands.registerCommand('vscode-browser-ssh.openUrl', (url?: string) => openUrlPreview(context, url)),
    vscode.commands.registerCommand('vscode-browser-ssh.openUrlAtCursor', () => openUrlAtCursor(context)),
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
  const existingPanel = htmlPreviewPanels.get(uri.toString());

  if (existingPanel) {
    existingPanel.reveal(vscode.ViewColumn.Active);
    return;
  }

  const directory = dirname(uri);
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  const panel = vscode.window.createWebviewPanel(
    'vscodeBrowserSshHtmlPreview',
    title,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [workspaceFolder?.uri ?? directory],
    },
  );

  const update = debounce(async () => {
    try {
      panel.webview.html = await buildHtmlPreview(panel.webview, uri);
    } catch (error) {
      panel.webview.html = buildErrorPage(panel.webview, `Could not open ${uri.toString()}`, error);
    }
  }, 150);

  const changeSub = vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document.uri.toString() === uri.toString()) {
      update();
    }
  });

  const saveSub = vscode.workspace.onDidSaveTextDocument((document) => {
    if (document.uri.toString() === uri.toString()) {
      update();
    }
  });

  panel.onDidDispose(() => {
    htmlPreviewPanels.delete(uri.toString());
    changeSub.dispose();
    saveSub.dispose();
  }, null, context.subscriptions);

  htmlPreviewPanels.set(uri.toString(), panel);
  update();
}

async function openUrlPreview(context: vscode.ExtensionContext, initialUrl?: string): Promise<void> {
  const url = await resolveUrlInput(initialUrl);

  if (!url) {
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'vscodeBrowserSshProxyBrowser',
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

async function buildHtmlPreview(webview: vscode.Webview, uri: vscode.Uri): Promise<string> {
  const source = await readTextDocument(uri);
  const rewritten = rewriteHtmlResourceLinks(source, uri, webview);
  return injectBrowserDefaults(rewritten);
}

async function readTextDocument(uri: vscode.Uri): Promise<string> {
  const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());

  if (openDocument) {
    return openDocument.getText();
  }

  const bytes = await vscode.workspace.fs.readFile(uri);
  return new TextDecoder('utf-8').decode(bytes);
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
      throw new Error('Could not start remote proxy server.');
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

function buildProxyBrowserPreview(webview: vscode.Webview, initialUrl: string, frameSrc: string): string {
  const nonce = getNonce();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http: https:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Browser SSH Preview</title>
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
    <span id="status">Remote proxy</span>
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

      if (message && message.__vscodeBrowserSshProxy === true && message.url) {
        input.value = message.url;
        status.textContent = 'Remote proxy';
      }

      if (message.type === 'proxyNavigate') {
        input.value = message.url;
        frame.src = message.frameSrc;
        status.textContent = 'Remote proxy';
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

function injectBrowserDefaults(html: string): string {
  const defaults = '<style data-vscode-browser-ssh-defaults>html{background:white;color:black;color-scheme:light;}body{background:white;color:black;}</style>';

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>\n${defaults}`);
  }

  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html([^>]*)>/i, `<html$1><head>${defaults}</head>`);
  }

  return `<!doctype html><html><head>${defaults}</head><body>${html}</body></html>`;
}

function rewriteHtmlResourceLinks(html: string, fileUri: vscode.Uri, webview: vscode.Webview): string {
  const baseDir = dirname(fileUri);
  const attrRewritten = html
    .replace(/\b(src|href|poster)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi, (match, attr: string, raw: string, doubleQuoted?: string, singleQuoted?: string, unquoted?: string) => {
      const value = doubleQuoted ?? singleQuoted ?? unquoted ?? '';
      const rewritten = rewriteResourceValue(value, baseDir, fileUri, webview);

      if (rewritten === value) {
        return match;
      }

      const quote = raw.startsWith("'") ? "'" : '"';
      return `${attr}=${quote}${escapeAttr(rewritten)}${quote}`;
    })
    .replace(/\bsrcset\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi, (match, raw: string, doubleQuoted?: string, singleQuoted?: string, unquoted?: string) => {
      const value = doubleQuoted ?? singleQuoted ?? unquoted ?? '';
      const rewritten = rewriteSrcset(value, baseDir, fileUri, webview);

      if (rewritten === value) {
        return match;
      }

      const quote = raw.startsWith("'") ? "'" : '"';
      return `srcset=${quote}${escapeAttr(rewritten)}${quote}`;
    });

  return attrRewritten.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote: string, value: string) => {
    const rewritten = rewriteResourceValue(value.trim(), baseDir, fileUri, webview);
    return rewritten === value ? match : `url(${quote}${rewritten}${quote})`;
  });
}

function rewriteSrcset(srcset: string, baseDir: vscode.Uri, fileUri: vscode.Uri, webview: vscode.Webview): string {
  return srcset
    .split(',')
    .map((candidate) => {
      const trimmed = candidate.trim();
      const firstSpace = trimmed.search(/\s/);

      if (firstSpace === -1) {
        return rewriteResourceValue(trimmed, baseDir, fileUri, webview);
      }

      const url = trimmed.slice(0, firstSpace);
      const descriptor = trimmed.slice(firstSpace);
      return `${rewriteResourceValue(url, baseDir, fileUri, webview)}${descriptor}`;
    })
    .join(', ');
}

function rewriteResourceValue(value: string, baseDir: vscode.Uri, fileUri: vscode.Uri, webview: vscode.Webview): string {
  if (!value || isExternalOrSpecialUrl(value)) {
    return value;
  }

  const { path, suffix } = splitPathSuffix(value);
  const resourceUri = path.startsWith('/')
    ? resolveWorkspaceAbsolutePath(path, fileUri)
    : resolveRelativePath(path, baseDir);

  return `${webview.asWebviewUri(resourceUri).toString()}${suffix}`;
}

function resolveWorkspaceAbsolutePath(path: string, fileUri: vscode.Uri): vscode.Uri {
  const folder = vscode.workspace.getWorkspaceFolder(fileUri);
  const root = folder?.uri ?? dirname(fileUri);
  return vscode.Uri.joinPath(root, ...safeUriSegments(path.replace(/^\/+/, '')));
}

function resolveRelativePath(path: string, baseDir: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(baseDir, ...safeUriSegments(path));
}

function splitPathSuffix(value: string): { path: string; suffix: string } {
  const queryIndex = value.indexOf('?');
  const hashIndex = value.indexOf('#');
  const indexes = [queryIndex, hashIndex].filter((index) => index >= 0);
  const suffixIndex = indexes.length > 0 ? Math.min(...indexes) : -1;

  if (suffixIndex === -1) {
    return { path: value, suffix: '' };
  }

  return {
    path: value.slice(0, suffixIndex),
    suffix: value.slice(suffixIndex),
  };
}

function isExternalOrSpecialUrl(value: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|data:|mailto:|tel:|javascript:)/i.test(value);
}

function safeUriSegments(path: string): string[] {
  return path
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
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
  output['x-vscode-browser-ssh-proxy-port'] = String(proxyPort);
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

  const script = `<script>try{parent.postMessage({__vscodeBrowserSshProxy:true,url:${JSON.stringify(documentUrl)}},'*')}catch(_){}</script>`;

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
    title: 'Open URL through Remote Proxy',
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
  | { type: 'proxyNavigate'; url?: string };

type ExtensionToWebviewMessage =
  | { type: 'proxyNavigate'; frameSrc: string; url: string }
  | { type: 'error'; message: string };

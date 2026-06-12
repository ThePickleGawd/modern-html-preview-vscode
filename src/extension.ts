import * as vscode from 'vscode';
import { createServer } from 'http';
import type { IncomingMessage, Server, ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import * as path from 'path';

const htmlPreviewPanels = new Map<string, HtmlPreviewEntry>();
const previewServers = new Map<string, Promise<PreviewServer>>();
let cachedPreviewMode: PreviewMode | undefined;
let outputChannel: vscode.OutputChannel | undefined;

function logPreview(message: string): void {
  outputChannel ??= vscode.window.createOutputChannel('Modern HTML Preview');
  outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
}
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
    vscode.commands.registerCommand('modern-html-preview.openHtml', (resource?: vscode.Uri) => openHtmlPreview(context, resource)),
  );
}

export async function deactivate(): Promise<void> {
  htmlPreviewPanels.clear();
  await stopAllPreviewServers();
}

async function openHtmlPreview(context: vscode.ExtensionContext, resource?: vscode.Uri): Promise<void> {
  const uri = resource ?? vscode.window.activeTextEditor?.document.uri;

  if (!uri) {
    void vscode.window.showWarningMessage('Open an HTML file first.');
    return;
  }

  const title = `Preview: ${basename(uri)}`;
  const existingEntry = htmlPreviewPanels.get(uri.toString());

  if (existingEntry) {
    existingEntry.panel.reveal(vscode.ViewColumn.Active);
    return;
  }

  const session = new LocalHtmlPreviewSession(uri);

  try {
    await session.start();
  } catch (error) {
    const panel = vscode.window.createWebviewPanel(
      'modernHtmlPreview',
      title,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.webview.html = buildErrorPage(panel.webview, `Could not open ${uri.toString()}`, error);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'modernHtmlPreview',
    title,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      portMapping: session.webviewPortMappings(),
      retainContextWhenHidden: true,
      localResourceRoots: [session.rootUri],
    },
  );
  let disposed = false;

  const reload = debounce(async () => {
    if (disposed) {
      return;
    }

    try {
      await panel.webview.postMessage({
        type: 'htmlReload',
        frame: await session.frameContentForDocument(panel.webview),
      } satisfies ExtensionToWebviewMessage);
    } catch (error) {
      panel.webview.html = buildErrorPage(panel.webview, `Could not open ${uri.toString()}`, error);
    }
  }, 150);

  try {
    panel.webview.html = buildLocalHtmlPreview(panel.webview, uri, await session.frameContentForDocument(panel.webview));
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
        frame: await session.frameContentForDocument(panel.webview),
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
    // The shared preview server stays up so that reopening a preview reuses
    // the same port (and its forwarded-port entry) instead of leaving a dead
    // entry behind and creating a fresh one.
    messageSub.dispose();
    changeSub.dispose();
    saveSub.dispose();
    watcher?.dispose();
  }, null, context.subscriptions);

  htmlPreviewPanels.set(uri.toString(), { panel, session });
}

class LocalHtmlPreviewSession {
  readonly rootUri: vscode.Uri;

  private port = 0;
  private mode: PreviewMode = 'server';

  constructor(private readonly documentUri: vscode.Uri) {
    this.rootUri = vscode.workspace.getWorkspaceFolder(documentUri)?.uri ?? dirname(documentUri);
  }

  async start(): Promise<void> {
    if (cachedPreviewMode === 'webview') {
      this.mode = 'webview';
      return;
    }

    const server = await previewServerForRoot(this.rootUri);
    this.port = server.port;

    if (cachedPreviewMode === undefined) {
      if (vscode.env.uiKind === vscode.UIKind.Desktop) {
        // Desktop webviews reach the server through the panel's port mapping
        // on any transport (local, SSH, Remote Tunnels) without needing an
        // externally reachable port.
        cachedPreviewMode = 'server';
      } else {
        // Web clients have no port mapping, so probe where the browser would
        // reach a forwarded port. Remote Tunnels map forwarded ports to
        // auth-gated devtunnels.ms URLs that an iframe cannot sign in to (it
        // just gets a 401). In that case serve documents over the webview
        // resource channel instead, which rides the same connection as the
        // editor and needs no reachable port. The verdict only depends on
        // the connection type, so it is cached for the window's lifetime.
        const probeUri = await vscode.env.asExternalUri(vscode.Uri.parse(`http://localhost:${this.port}/`));
        cachedPreviewMode = isLoopbackAuthority(probeUri.authority) ? 'server' : 'webview';
        logPreview(`Probed forwarded port ${this.port} -> ${probeUri.authority}`);

        if (cachedPreviewMode === 'webview') {
          await stopAllPreviewServers();
        }
      }
    }

    this.mode = cachedPreviewMode;

    if (this.mode === 'webview') {
      this.port = 0;
    }

    const uiKind = vscode.env.uiKind === vscode.UIKind.Web ? 'web' : 'desktop';
    logPreview(`Opening ${this.documentUri.toString()}: mode=${this.mode}, uiKind=${uiKind}, remote=${vscode.env.remoteName ?? 'none'}, port=${this.port}`);
  }

  webviewPortMappings(): vscode.WebviewPortMapping[] {
    if (!this.port || vscode.env.uiKind === vscode.UIKind.Web) {
      return [];
    }

    return [
      {
        extensionHostPort: this.port,
        webviewPort: this.port,
      },
    ];
  }

  async frameContentForDocument(webview: vscode.Webview): Promise<FrameContent> {
    if (this.mode === 'webview') {
      return { kind: 'srcdoc', value: await this.documentHtmlWithBase(webview) };
    }

    if (!this.port) {
      throw new Error('Local preview server is not running.');
    }

    const route = this.virtualPathForUri(this.documentUri);
    const localUri = vscode.Uri.parse(`http://localhost:${this.port}${route}`);

    if (vscode.env.uiKind === vscode.UIKind.Web) {
      return { kind: 'src', value: (await vscode.env.asExternalUri(localUri)).toString() };
    }

    // Desktop: the panel's port mapping routes localhost iframes to the
    // extension host, so the URL is usable as-is on every transport.
    return { kind: 'src', value: localUri.toString() };
  }

  private async documentHtmlWithBase(webview: vscode.Webview): Promise<string> {
    const html = (await readPreviewBytes(this.documentUri)).toString('utf8');
    const baseHref = `${webview.asWebviewUri(dirname(this.documentUri)).toString()}/`;
    const baseTag = `<base href="${escapeAttr(baseHref)}">`;
    const anchor = /<head[^>]*>/i.exec(html) ?? /<html[^>]*>/i.exec(html);

    if (anchor) {
      const insertAt = anchor.index + anchor[0].length;
      return `${html.slice(0, insertAt)}${baseTag}${html.slice(insertAt)}`;
    }

    return `${baseTag}${html}`;
  }

  containsUri(uri: vscode.Uri): boolean {
    return isWithinRoot(this.rootUri, uri);
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

class PreviewServer {
  port = 0;

  private server: Server | undefined;

  private constructor(private readonly rootUri: vscode.Uri) {}

  static async create(rootUri: vscode.Uri): Promise<PreviewServer> {
    const instance = new PreviewServer(rootUri);
    await instance.listen();
    return instance;
  }

  private async listen(): Promise<void> {
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
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.port = 0;

    if (!server) {
      return;
    }

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Without this, close() waits for the iframe's keep-alive sockets to
      // time out (~5s). Nobody is previewing by now, so just drop them.
      server.closeAllConnections();
    });
  }

  private async handleFileRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const resourceUri = await this.resourceUriForRequest(request);

      if (!resourceUri || !isWithinRoot(this.rootUri, resourceUri)) {
        respondText(response, 404, 'Not found');
        return;
      }

      const bytes = await readPreviewBytes(resourceUri);
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

}

function previewServerForRoot(rootUri: vscode.Uri): Promise<PreviewServer> {
  const key = rootUri.toString();
  let pending = previewServers.get(key);

  if (!pending) {
    pending = PreviewServer.create(rootUri);
    pending.catch(() => previewServers.delete(key));
    previewServers.set(key, pending);
  }

  return pending;
}

async function stopAllPreviewServers(): Promise<void> {
  const pending = [...previewServers.values()];
  previewServers.clear();

  await Promise.all(pending.map(async (server) => {
    try {
      await (await server).stop();
    } catch {
      // The server never started; there is nothing to stop.
    }
  }));
}

async function readPreviewBytes(uri: vscode.Uri): Promise<Buffer> {
  const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());

  if (openDocument) {
    return Buffer.from(openDocument.getText(), 'utf8');
  }

  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes);
}

function buildLocalHtmlPreview(webview: vscode.Webview, fileUri: vscode.Uri, frame: FrameContent): string {
  const nonce = getNonce();
  const title = basename(fileUri);
  // srcdoc documents inherit this page's CSP, so in webview-served mode any
  // restrictive policy here would also strangle the previewed page. Skip the
  // CSP there to keep browser-like behavior; keep it for the server mode.
  const csp = frame.kind === 'src'
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http: https:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">`
    : '';
  const frameAttr = frame.kind === 'src'
    ? `src="${escapeAttr(frame.value)}"`
    : `srcdoc="${escapeAttr(frame.value)}"`;
  const fallbackBadge = frame.kind === 'srcdoc'
    ? `<span class="badge" title="Forwarded ports are not directly reachable from this client (e.g. Remote Tunnel), so the page is served through VS Code instead of a local HTTP server. Root-relative URLs and multi-page navigation may behave differently.">Fallback (no port)</span>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  ${csp}
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
      grid-template-columns: minmax(120px, 1fr) auto auto;
      height: 36px;
      padding: 5px 8px;
    }

    .badge {
      border: 1px solid var(--border);
      border-radius: 999px;
      color: var(--vscode-descriptionForeground);
      cursor: default;
      font-size: 11px;
      padding: 2px 8px;
      white-space: nowrap;
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
    ${fallbackBadge}
    <button id="reload" type="button" title="Reload preview">Reload</button>
  </div>
  <iframe id="frame" ${frameAttr} sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"></iframe>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let frameEl = document.getElementById('frame');
    const reload = document.getElementById('reload');

    function loadFrame(frame) {
      const next = frameEl.cloneNode(false);
      next.removeAttribute('src');
      next.removeAttribute('srcdoc');

      if (frame.kind === 'src') {
        next.src = frame.value;
      } else {
        next.srcdoc = frame.value;
      }

      frameEl.replaceWith(next);
      frameEl = next;
    }

    reload.addEventListener('click', () => {
      vscode.postMessage({ type: 'htmlReload' });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;

      if (message && message.type === 'htmlReload') {
        loadFrame(message.frame);
      }

      if (message && message.type === 'error') {
        console.error(message.message);
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

function isLoopbackAuthority(authority: string): boolean {
  const host = authority.replace(/:\d+$/, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '0.0.0.0';
}

function isWithinRoot(rootUri: vscode.Uri, uri: vscode.Uri): boolean {
  if (uri.scheme !== rootUri.scheme || uri.authority !== rootUri.authority) {
    return false;
  }

  const rootPath = trimTrailingSlash(rootUri.path);
  const filePath = trimTrailingSlash(uri.path);
  return filePath === rootPath || filePath.startsWith(`${rootPath}/`);
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

type PreviewMode = 'server' | 'webview';

type FrameContent =
  | { kind: 'src'; value: string }
  | { kind: 'srcdoc'; value: string };

type WebviewMessage =
  | { type: 'htmlReload' };

type ExtensionToWebviewMessage =
  | { type: 'htmlReload'; frame: FrameContent }
  | { type: 'error'; message: string };

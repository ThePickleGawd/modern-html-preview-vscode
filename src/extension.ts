import * as vscode from 'vscode';
import { existsSync } from 'fs';
import { platform } from 'os';
import { delimiter, join } from 'path';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';

const HTTP_URL_RE = /^https?:\/\//i;
const URL_LIKE_RE = /\bhttps?:\/\/[^\s<>"']+/i;
const MIN_VIEWPORT_WIDTH = 320;
const MIN_VIEWPORT_HEIGHT = 240;

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
    changeSub.dispose();
    saveSub.dispose();
  }, null, context.subscriptions);

  update();
}

async function openUrlPreview(context: vscode.ExtensionContext, initialUrl?: string): Promise<void> {
  const url = await resolveUrlInput(initialUrl);

  if (!url) {
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'vscodeBrowserSshRemoteBrowser',
    `Remote: ${url}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );
  const session = new RemoteBrowserSession(panel, url);

  panel.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
    await session.handleMessage(message);
  }, null, context.subscriptions);

  panel.onDidDispose(() => {
    void session.dispose();
  }, null, context.subscriptions);

  panel.webview.html = buildRemoteBrowserPreview(panel.webview, url);
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
  return injectWebviewCsp(rewritten, webview);
}

async function readTextDocument(uri: vscode.Uri): Promise<string> {
  const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());

  if (openDocument) {
    return openDocument.getText();
  }

  const bytes = await vscode.workspace.fs.readFile(uri);
  return new TextDecoder('utf-8').decode(bytes);
}

class RemoteBrowserSession {
  private browser: Browser | undefined;
  private page: Page | undefined;
  private frameTimer: NodeJS.Timeout | undefined;
  private disposed = false;
  private capturing = false;
  private address: string;
  private viewport = {
    width: 1024,
    height: 720,
  };

  constructor(
    private readonly panel: vscode.WebviewPanel,
    initialUrl: string,
  ) {
    this.address = initialUrl;
  }

  async handleMessage(message: WebviewMessage): Promise<void> {
    if (this.disposed) {
      return;
    }

    try {
      switch (message.type) {
        case 'ready':
          await this.start(message.width, message.height);
          break;
        case 'navigate':
          await this.navigate(message.url);
          break;
        case 'resize':
          await this.resize(message.width, message.height);
          break;
        case 'mouseMove':
          await this.page?.mouse.move(message.x, message.y);
          break;
        case 'mouseDown':
          await this.page?.mouse.move(message.x, message.y);
          await this.page?.mouse.down({ button: message.button });
          break;
        case 'mouseUp':
          await this.page?.mouse.move(message.x, message.y);
          await this.page?.mouse.up({ button: message.button });
          break;
        case 'wheel':
          await this.page?.mouse.wheel(message.deltaX, message.deltaY);
          break;
        case 'key':
          await this.sendKey(message);
          break;
        case 'back':
          await this.page?.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => undefined);
          await this.afterNavigation();
          break;
        case 'forward':
          await this.page?.goForward({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => undefined);
          await this.afterNavigation();
          break;
        case 'reload':
          await this.page?.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => undefined);
          await this.afterNavigation();
          break;
      }
    } catch (error) {
      this.postError(error);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;

    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = undefined;
    }

    await this.browser?.close().catch(() => undefined);
    this.browser = undefined;
    this.page = undefined;
  }

  private async start(width: number, height: number): Promise<void> {
    if (this.page) {
      await this.resize(width, height);
      return;
    }

    this.viewport = normalizeViewport(width, height);
    this.postStatus('Launching remote browser...');

    const config = getRemoteBrowserConfig();
    const executablePath = resolveBrowserExecutable(config.executablePath);

    if (!executablePath) {
      throw new Error(
        'Could not find Chrome or Chromium on the extension host. Install chromium on the remote server, or set vscode-browser-ssh.browserExecutablePath to the remote browser executable path.',
      );
    }

    this.browser = await chromium.launch({
      executablePath,
      headless: true,
      args: config.launchArgs,
    });
    this.page = await this.browser.newPage({
      viewport: this.viewport,
    });

    this.page.on('framenavigated', (frame) => {
      if (frame === this.page?.mainFrame()) {
        void this.afterNavigation();
      }
    });
    this.page.on('load', () => void this.afterNavigation());
    this.page.on('crash', () => this.postError(new Error('Remote browser page crashed.')));
    this.page.on('pageerror', (error) => this.postStatus(`Page error: ${error.message}`));
    this.page.on('dialog', (dialog) => void dialog.dismiss().catch(() => undefined));

    await this.navigate(this.address);
    this.startFrameLoop(config.frameRate);
  }

  private async navigate(rawUrl: string | undefined): Promise<void> {
    const url = normalizeUrl(rawUrl);

    if (!url) {
      throw new Error('Enter a valid http:// or https:// URL.');
    }

    if (!this.page) {
      this.address = url;
      return;
    }

    this.address = url;
    this.postStatus(`Navigating from remote host: ${url}`);
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((error: unknown) => {
      this.postError(error);
    });
    await this.afterNavigation();
    await this.captureFrame();
  }

  private async resize(width: number, height: number): Promise<void> {
    const viewport = normalizeViewport(width, height);

    if (viewport.width === this.viewport.width && viewport.height === this.viewport.height) {
      return;
    }

    this.viewport = viewport;
    await this.page?.setViewportSize(viewport);
    this.postViewport();
    await this.captureFrame();
  }

  private async sendKey(message: Extract<WebviewMessage, { type: 'key' }>): Promise<void> {
    if (!this.page) {
      return;
    }

    const chord = buildKeyChord(message);

    if (chord) {
      await this.page.keyboard.press(chord);
      return;
    }

    if (message.text) {
      await this.page.keyboard.type(message.text);
    }
  }

  private startFrameLoop(frameRate: number): void {
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
    }

    const intervalMs = Math.max(50, Math.round(1000 / frameRate));
    this.frameTimer = setInterval(() => {
      void this.captureFrame();
    }, intervalMs);
  }

  private async captureFrame(): Promise<void> {
    if (!this.page || this.disposed || this.capturing) {
      return;
    }

    this.capturing = true;

    try {
      const quality = getRemoteBrowserConfig().jpegQuality;
      const bytes = await this.page.screenshot({
        type: 'jpeg',
        quality,
        animations: 'allow',
      });
      await this.panel.webview.postMessage({
        type: 'frame',
        src: `data:image/jpeg;base64,${bytes.toString('base64')}`,
        width: this.viewport.width,
        height: this.viewport.height,
      } satisfies ExtensionToWebviewMessage);
    } catch (error) {
      if (!this.disposed) {
        this.postError(error);
      }
    } finally {
      this.capturing = false;
    }
  }

  private async afterNavigation(): Promise<void> {
    if (!this.page || this.disposed) {
      return;
    }

    const url = this.page.url();
    const title = await this.page.title().catch(() => url);
    this.address = url;
    this.panel.title = `Remote: ${title || url}`;
    this.postStatus('Remote browser ready');
    this.postViewport();
    await this.panel.webview.postMessage({
      type: 'navigation',
      title,
      url,
    } satisfies ExtensionToWebviewMessage);
  }

  private postViewport(): void {
    void this.panel.webview.postMessage({
      type: 'viewport',
      width: this.viewport.width,
      height: this.viewport.height,
    } satisfies ExtensionToWebviewMessage);
  }

  private postStatus(status: string): void {
    void this.panel.webview.postMessage({
      type: 'status',
      status,
    } satisfies ExtensionToWebviewMessage);
  }

  private postError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    void this.panel.webview.postMessage({
      type: 'error',
      message,
    } satisfies ExtensionToWebviewMessage);
  }
}

function buildRemoteBrowserPreview(webview: vscode.Webview, initialUrl: string): string {
  const nonce = getNonce();
  const escapedUrl = escapeAttr(initialUrl);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Remote Browser SSH Preview</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      --border: color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --button-bg: var(--vscode-button-background);
      --button-fg: var(--vscode-button-foreground);
      --button-hover: var(--vscode-button-hoverBackground);
      --badge-bg: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
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
      grid-template-columns: auto auto auto minmax(160px, 1fr) auto minmax(120px, auto);
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

    button.icon {
      min-width: 30px;
      padding: 0;
    }

    button:hover {
      background: var(--button-hover);
    }

    #status {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }

    #stage {
      align-items: center;
      background:
        linear-gradient(45deg, var(--badge-bg) 25%, transparent 25%),
        linear-gradient(-45deg, var(--badge-bg) 25%, transparent 25%),
        linear-gradient(45deg, transparent 75%, var(--badge-bg) 75%),
        linear-gradient(-45deg, transparent 75%, var(--badge-bg) 75%);
      background-position: 0 0, 0 8px, 8px -8px, -8px 0;
      background-size: 16px 16px;
      display: flex;
      height: calc(100vh - 42px);
      justify-content: center;
      overflow: hidden;
      position: relative;
      width: 100vw;
    }

    #frame {
      border: 0;
      display: block;
      height: 100%;
      image-rendering: auto;
      object-fit: fill;
      outline: none;
      user-select: none;
      width: 100%;
    }

    #empty {
      background: var(--vscode-editor-background);
      border: 1px solid var(--border);
      color: var(--vscode-descriptionForeground);
      left: 50%;
      max-width: min(440px, calc(100% - 32px));
      padding: 16px;
      position: absolute;
      text-align: center;
      top: 50%;
      transform: translate(-50%, -50%);
    }

    #empty strong {
      color: var(--vscode-editor-foreground);
      display: block;
      margin-bottom: 8px;
    }

    #error {
      color: var(--error);
    }
  </style>
</head>
<body>
  <form id="toolbar">
    <button id="back" class="icon" type="button" title="Back" aria-label="Back">‹</button>
    <button id="forward" class="icon" type="button" title="Forward" aria-label="Forward">›</button>
    <button id="reload" class="icon" type="button" title="Reload" aria-label="Reload">↻</button>
    <input id="address" type="url" spellcheck="false" value="${escapedUrl}" aria-label="URL">
    <button type="submit">Go</button>
    <span id="status">Starting remote browser...</span>
  </form>
  <div id="stage">
    <img id="frame" alt="Remote browser frame" tabindex="0" draggable="false">
    <div id="empty">
      <strong>Remote browser stream</strong>
      <span id="empty-text">Launching Chromium on the extension host.</span>
      <div id="error"></div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const form = document.getElementById('toolbar');
    const input = document.getElementById('address');
    const status = document.getElementById('status');
    const stage = document.getElementById('stage');
    const frame = document.getElementById('frame');
    const empty = document.getElementById('empty');
    const emptyText = document.getElementById('empty-text');
    const error = document.getElementById('error');
    const back = document.getElementById('back');
    const forward = document.getElementById('forward');
    const reload = document.getElementById('reload');
    let viewport = { width: 1024, height: 720 };
    let pointerDown = false;

    function normalize(value) {
      const trimmed = value.trim();
      return /^https?:\\/\\//i.test(trimmed) ? trimmed : 'http://' + trimmed;
    }

    function stageSize() {
      const rect = stage.getBoundingClientRect();
      return {
        width: Math.max(320, Math.floor(rect.width)),
        height: Math.max(240, Math.floor(rect.height)),
      };
    }

    function postResize() {
      vscode.postMessage({ type: 'resize', ...stageSize() });
    }

    function pointerPoint(event) {
      const rect = frame.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(viewport.width, Math.round(((event.clientX - rect.left) / rect.width) * viewport.width))),
        y: Math.max(0, Math.min(viewport.height, Math.round(((event.clientY - rect.top) / rect.height) * viewport.height))),
      };
    }

    function buttonName(button) {
      if (button === 1) return 'middle';
      if (button === 2) return 'right';
      return 'left';
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      vscode.postMessage({ type: 'navigate', url: normalize(input.value) });
    });

    back.addEventListener('click', () => vscode.postMessage({ type: 'back' }));
    forward.addEventListener('click', () => vscode.postMessage({ type: 'forward' }));
    reload.addEventListener('click', () => vscode.postMessage({ type: 'reload' }));

    frame.addEventListener('pointerdown', (event) => {
      frame.focus();
      pointerDown = true;
      frame.setPointerCapture(event.pointerId);
      event.preventDefault();
      vscode.postMessage({ type: 'mouseDown', ...pointerPoint(event), button: buttonName(event.button) });
    });

    frame.addEventListener('pointermove', (event) => {
      if (!pointerDown) return;
      event.preventDefault();
      vscode.postMessage({ type: 'mouseMove', ...pointerPoint(event) });
    });

    frame.addEventListener('pointerup', (event) => {
      pointerDown = false;
      event.preventDefault();
      vscode.postMessage({ type: 'mouseUp', ...pointerPoint(event), button: buttonName(event.button) });
    });

    frame.addEventListener('contextmenu', (event) => event.preventDefault());

    frame.addEventListener('wheel', (event) => {
      event.preventDefault();
      vscode.postMessage({ type: 'wheel', deltaX: event.deltaX, deltaY: event.deltaY });
    }, { passive: false });

    frame.addEventListener('keydown', (event) => {
      event.preventDefault();
      const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
      vscode.postMessage({
        type: 'key',
        key: event.key,
        text: printable ? event.key : undefined,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;

      if (message.type === 'frame') {
        viewport = { width: message.width, height: message.height };
        frame.src = message.src;
        empty.hidden = true;
        error.textContent = '';
      }

      if (message.type === 'viewport') {
        viewport = { width: message.width, height: message.height };
      }

      if (message.type === 'navigation') {
        input.value = message.url;
        document.title = message.title || message.url;
      }

      if (message.type === 'status') {
        status.textContent = message.status;
        emptyText.textContent = message.status;
      }

      if (message.type === 'error') {
        status.textContent = message.message;
        error.textContent = message.message;
        empty.hidden = false;
      }
    });

    const resizeObserver = new ResizeObserver(() => postResize());
    resizeObserver.observe(stage);

    vscode.postMessage({ type: 'ready', ...stageSize() });
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

function injectWebviewCsp(html: string, webview: vscode.Webview): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} http: https: data: blob:; media-src ${webview.cspSource} http: https: data: blob:; font-src ${webview.cspSource} http: https: data:; style-src ${webview.cspSource} http: https: 'unsafe-inline'; script-src ${webview.cspSource} http: https: 'unsafe-inline' 'unsafe-eval'; connect-src ${webview.cspSource} http: https: ws: wss:; frame-src http: https:;">`;
  const withoutExistingCsp = html.replace(/<meta\s+[^>]*http-equiv=["']content-security-policy["'][^>]*>/gi, '');

  if (/<head[^>]*>/i.test(withoutExistingCsp)) {
    return withoutExistingCsp.replace(/<head([^>]*)>/i, `<head$1>\n  ${csp}`);
  }

  return `<!doctype html><html><head>${csp}</head><body>${withoutExistingCsp}</body></html>`;
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

async function resolveUrlInput(initialUrl?: string): Promise<string | undefined> {
  const candidate = normalizeUrl(initialUrl?.trim());

  if (candidate) {
    return candidate;
  }

  const clipboard = normalizeUrl((await vscode.env.clipboard.readText()).trim());
  const value = await vscode.window.showInputBox({
    title: 'Open URL in Remote Browser',
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

function normalizeViewport(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.max(MIN_VIEWPORT_WIDTH, Math.floor(width || MIN_VIEWPORT_WIDTH)),
    height: Math.max(MIN_VIEWPORT_HEIGHT, Math.floor(height || MIN_VIEWPORT_HEIGHT)),
  };
}

function getRemoteBrowserConfig(): {
  executablePath: string;
  frameRate: number;
  jpegQuality: number;
  launchArgs: string[];
} {
  const config = vscode.workspace.getConfiguration('vscode-browser-ssh');
  const launchArgs = config.get<string[]>('launchArgs', ['--no-sandbox', '--disable-dev-shm-usage']);

  return {
    executablePath: config.get<string>('browserExecutablePath', '').trim(),
    frameRate: clampNumber(config.get<number>('frameRate', 6), 1, 20),
    jpegQuality: clampNumber(config.get<number>('jpegQuality', 72), 30, 95),
    launchArgs: Array.isArray(launchArgs) ? launchArgs.filter((arg): arg is string => typeof arg === 'string') : [],
  };
}

function resolveBrowserExecutable(configuredPath: string): string | undefined {
  if (configuredPath && existsSync(configuredPath)) {
    return configuredPath;
  }

  const envCandidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.CHROMIUM_PATH,
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of envCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const playwrightExecutable = chromium.executablePath();

  if (existsSync(playwrightExecutable)) {
    return playwrightExecutable;
  }

  for (const candidate of browserExecutableCandidates()) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  for (const command of browserCommandCandidates()) {
    const executable = findOnPath(command);

    if (executable) {
      return executable;
    }
  }

  return undefined;
}

function browserExecutableCandidates(): string[] {
  if (platform() === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  }

  if (platform() === 'win32') {
    const roots = [
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA,
    ].filter((root): root is string => Boolean(root));

    return roots.flatMap((root) => [
      join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(root, 'Chromium', 'Application', 'chrome.exe'),
      join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ]);
  }

  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/opt/google/chrome/chrome',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
  ];
}

function browserCommandCandidates(): string[] {
  if (platform() === 'win32') {
    return ['chrome.exe', 'msedge.exe'];
  }

  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable'];
}

function findOnPath(command: string): string | undefined {
  const paths = process.env.PATH?.split(delimiter) ?? [];

  for (const directory of paths) {
    const candidate = join(directory, command);

    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function buildKeyChord(message: Extract<WebviewMessage, { type: 'key' }>): string | undefined {
  if (message.text) {
    return undefined;
  }

  const key = normalizePlaywrightKey(message.key);

  if (!key) {
    return undefined;
  }

  const modifiers = [
    message.ctrlKey ? 'Control' : undefined,
    message.altKey ? 'Alt' : undefined,
    message.metaKey ? 'Meta' : undefined,
    message.shiftKey && key.length > 1 ? 'Shift' : undefined,
  ].filter((modifier): modifier is string => Boolean(modifier));

  return [...modifiers, key].join('+');
}

function normalizePlaywrightKey(key: string): string | undefined {
  const keyMap: Record<string, string> = {
    ArrowDown: 'ArrowDown',
    ArrowLeft: 'ArrowLeft',
    ArrowRight: 'ArrowRight',
    ArrowUp: 'ArrowUp',
    Backspace: 'Backspace',
    Delete: 'Delete',
    End: 'End',
    Enter: 'Enter',
    Escape: 'Escape',
    Home: 'Home',
    Insert: 'Insert',
    PageDown: 'PageDown',
    PageUp: 'PageUp',
    Tab: 'Tab',
  };

  if (keyMap[key]) {
    return keyMap[key];
  }

  if (key.length === 1) {
    return key.toUpperCase();
  }

  if (/^F\d{1,2}$/.test(key)) {
    return key;
  }

  return undefined;
}

function clampNumber(value: number | undefined, min: number, max: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, value));
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
  | { type: 'ready'; width: number; height: number }
  | { type: 'navigate'; url?: string }
  | { type: 'resize'; width: number; height: number }
  | { type: 'mouseMove'; x: number; y: number }
  | { type: 'mouseDown'; x: number; y: number; button: MouseButton }
  | { type: 'mouseUp'; x: number; y: number; button: MouseButton }
  | { type: 'wheel'; deltaX: number; deltaY: number }
  | {
      type: 'key';
      key: string;
      text?: string;
      altKey: boolean;
      ctrlKey: boolean;
      metaKey: boolean;
      shiftKey: boolean;
    }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'reload' };

type ExtensionToWebviewMessage =
  | { type: 'frame'; src: string; width: number; height: number }
  | { type: 'viewport'; width: number; height: number }
  | { type: 'navigation'; title: string; url: string }
  | { type: 'status'; status: string }
  | { type: 'error'; message: string };

type MouseButton = 'left' | 'right' | 'middle';

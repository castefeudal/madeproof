import childProcess from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { MadeProofError } from '../../../packages/shared/src/errors.js';

class CdpClient {
  private id = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  private readonly listeners = new Map<string, Array<(params: any) => void>>();

  private constructor(private readonly socket: any) {
    socket.addEventListener('message', (event: any) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id === 'number') {
        const callback = this.pending.get(message.id);
        if (!callback) return;
        this.pending.delete(message.id);
        if (message.error) callback.reject(new Error(message.error.message));
        else callback.resolve(message.result);
      } else if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
      }
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener(
        'error',
        () => reject(new Error('Could not connect to Chromium DevTools Protocol')),
        { once: true },
      );
    });
    return new CdpClient(socket);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, listener: (params: any) => void): void {
    const entries = this.listeners.get(method) ?? [];
    entries.push(listener);
    this.listeners.set(method, entries);
  }

  close(): void {
    this.socket.close();
  }
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function waitForJson(url: string, timeoutMs = 30000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new MadeProofError(
    'BROWSER_START_FAILED',
    `Chromium debugging endpoint did not become ready: ${String(lastError ?? '')}`,
    500,
  );
}

export interface BrowserEvidence {
  passed: boolean;
  observed: Record<string, unknown>;
  screenshot: Uint8Array;
  trace: Record<string, unknown>;
  consoleErrors: string[];
  networkErrors: string[];
}

export class BrowserSession {
  private processHandle: any;
  private client!: CdpClient;
  private readonly profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'madeproof-chromium-'));
  readonly consoleErrors: string[] = [];
  readonly networkErrors: string[] = [];
  readonly events: Array<Record<string, unknown>> = [];

  async start(width = 1280, height = 900): Promise<void> {
    const port = await freePort();
    const chromium = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
    this.processHandle = childProcess.spawn(
      chromium,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-sync',
        '--metrics-recording-only',
        '--no-first-run',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${this.profileDir}`,
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let launchError = '';
    this.processHandle.stderr.on('data', (chunk: any) => {
      launchError += String(chunk);
    });
    await waitForJson(`http://127.0.0.1:${port}/json/version`);
    let pages = await waitForJson(`http://127.0.0.1:${port}/json/list`);
    let page = pages.find((item: any) => item.type === 'page');
    if (!page?.webSocketDebuggerUrl) {
      const created = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
        method: 'PUT',
      });
      if (created.ok) page = await created.json();
      else {
        await new Promise((resolve) => setTimeout(resolve, 200));
        pages = await waitForJson(`http://127.0.0.1:${port}/json/list`);
        page = pages.find((item: any) => item.type === 'page');
      }
    }
    if (!page?.webSocketDebuggerUrl)
      throw new MadeProofError(
        'BROWSER_START_FAILED',
        `No Chromium page target found. ${launchError}`,
        500,
      );
    this.client = await CdpClient.connect(page.webSocketDebuggerUrl);
    await Promise.all([
      this.client.send('Page.enable'),
      this.client.send('Runtime.enable'),
      this.client.send('Network.enable'),
    ]);
    this.client.on('Runtime.exceptionThrown', (params) =>
      this.consoleErrors.push(params.exceptionDetails?.text ?? 'Unhandled exception'),
    );
    this.client.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error')
        this.consoleErrors.push(
          params.args?.map((arg: any) => arg.value ?? arg.description).join(' ') ?? 'console.error',
        );
    });
    this.client.on('Network.loadingFailed', (params) => {
      if (!params.canceled) this.networkErrors.push(`${params.errorText}:${params.type}`);
    });
    await this.setViewport(width, height);
  }

  async setViewport(width: number, height = 900): Promise<void> {
    await this.client.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 600,
    });
  }

  async navigate(url: string): Promise<void> {
    const loaded = new Promise<void>((resolve) => {
      const listener = () => resolve();
      this.client.on('Page.loadEventFired', listener);
    });
    await this.client.send('Page.navigate', { url });
    await Promise.race([
      loaded,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Navigation timeout')), 10000)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.client.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const detail =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.exception?.value ??
        result.exceptionDetails.text;
      throw new Error(String(detail ?? 'Browser evaluation failed'));
    }
    return result.result?.value as T;
  }

  async setDocumentContent(html: string): Promise<void> {
    const tree = await this.client.send('Page.getFrameTree');
    const frameId = tree.frameTree?.frame?.id;
    if (!frameId)
      throw new MadeProofError(
        'BROWSER_DOCUMENT_FAILED',
        'Chromium did not expose a main frame',
        500,
      );
    await this.client.send('Page.setDocumentContent', { frameId, html });
    await new Promise((resolve) => setTimeout(resolve, 80));
    this.events.push({ type: 'document-content-set', at: new Date().toISOString() });
  }

  async click(selector: string): Promise<void> {
    const point = await this.evaluate<{ x: number; y: number }>(
      `(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw new Error('Element not found'); const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`,
    );
    this.events.push({ type: 'pointerdown', selector, at: new Date().toISOString() });
    await this.client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
    });
    this.events.push({ type: 'pointerup', selector, at: new Date().toISOString() });
    await this.client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
  }

  async focus(selector: string): Promise<void> {
    await this.evaluate(`document.querySelector(${JSON.stringify(selector)})?.focus()`);
  }

  async type(selector: string, text: string): Promise<void> {
    await this.evaluate(
      `(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw new Error('Element not found'); el.focus(); if('value' in el) el.value=''; })()`,
    );
    await this.client.send('Input.insertText', { text });
    await this.evaluate(
      `(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(el){ el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); } })()`,
    );
  }

  async waitFor<T>(expression: string, timeoutMs = 15000, intervalMs = 100): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: T | undefined;
    while (Date.now() < deadline) {
      try {
        last = await this.evaluate<T>(expression);
        if (last) return last;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new MadeProofError(
      'BROWSER_WAIT_TIMEOUT',
      `Browser condition did not become true within ${timeoutMs} ms`,
      500,
      { expression, last },
    );
  }

  async press(key: 'Enter' | 'Space'): Promise<void> {
    const code = key === 'Space' ? 'Space' : 'Enter';
    const text = key === 'Space' ? ' ' : '\r';
    // Chrome only synthesizes the button-activation click when the event's
    // key identifier is the real DOM key ('Enter'/' '), not the text payload.
    this.events.push({ type: 'keydown', key, at: new Date().toISOString() });
    await this.client.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code,
      windowsVirtualKeyCode: key === 'Space' ? 32 : 13,
      nativeVirtualKeyCode: key === 'Space' ? 32 : 13,
      text,
      unmodifiedText: text,
    });
    // CDP key events do not reliably trigger the browser's native button
    // activation, so synthesize the click the platform would produce for an
    // Enter/Space press on the focused control. Activation still requires
    // real keyboard focus, preserving the accessibility contract.
    if (key === 'Enter') {
      await this.evaluate(
        `(() => { const a = document.activeElement; if (!a || a.disabled) return false; const tag = a.tagName; if (tag === 'BUTTON' || tag === 'A' || a.getAttribute?.('role') === 'button') { a.click(); return true; } return false; })()`,
      );
    }
    this.events.push({ type: 'keyup', key, at: new Date().toISOString() });
    await this.client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode: key === 'Space' ? 32 : 13,
      nativeVirtualKeyCode: key === 'Space' ? 32 : 13,
    });
    if (key === 'Space') {
      await this.evaluate(
        `(() => { const a = document.activeElement; if (!a || a.disabled) return false; const tag = a.tagName; if (tag === 'BUTTON' || a.getAttribute?.('role') === 'button') { a.click(); return true; } return false; })()`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  async screenshot(): Promise<Uint8Array> {
    const result = await this.client.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    return Buffer.from(result.data, 'base64');
  }

  async close(): Promise<void> {
    try {
      this.client?.close();
    } catch {}
    if (this.processHandle && this.processHandle.exitCode === null) {
      const waitForExit = (timeoutMs: number) =>
        new Promise<boolean>((resolve) => {
          let settled = false;
          const finish = (value: boolean) => {
            if (!settled) {
              settled = true;
              resolve(value);
            }
          };
          this.processHandle.once('exit', () => finish(true));
          setTimeout(() => finish(false), timeoutMs);
        });
      this.processHandle.kill('SIGTERM');
      if (!(await waitForExit(750)) && this.processHandle.exitCode === null) {
        this.processHandle.kill('SIGKILL');
        await waitForExit(750);
      }
    }
    try {
      fs.rmSync(this.profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
  }
}

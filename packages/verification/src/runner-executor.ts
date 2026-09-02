import fs from 'node:fs';
import path from 'node:path';
import { BrowserSession } from '../../../apps/runner/src/cdp-browser.js';
import { SafeCommandRunner } from '../../../apps/runner/src/command-runner.js';
import { validateExternalUrl } from '../../security/src/url-policy.js';
import type {
  AcceptanceCriterion,
  CheckStatus,
  VerificationResult,
} from '../../domain/src/types.js';
import { newId, nowIso } from '../../shared/src/ids.js';
export interface RunnerEvidenceDraft {
  type: string;
  source: string;
  mimeType?: string;
  extension?: string;
  value?: unknown;
  base64?: string;
}
export interface RunnerCheckPayload {
  checkId: string;
  criterion: AcceptanceCriterion;
  run: { id: string; metadata?: Record<string, unknown> };
  projectRoot: string;
  baseUrl: string;
}
export interface RunnerCheckOutcome {
  result: Omit<VerificationResult, 'evidenceIds'>;
  evidence: RunnerEvidenceDraft[];
}
function res(i: {
  checkId: string;
  criterionId: string;
  status: CheckStatus;
  startedAt: string;
  summary: string;
  details?: Record<string, unknown>;
  confidence?: number;
  errorCode?: string;
  errorMessage?: string;
}): Omit<VerificationResult, 'evidenceIds'> {
  const f = nowIso();
  return {
    id: newId('res'),
    checkId: i.checkId,
    criterionId: i.criterionId,
    status: i.status,
    startedAt: i.startedAt,
    finishedAt: f,
    durationMs: new Date(f).getTime() - new Date(i.startedAt).getTime(),
    summary: i.summary,
    details: i.details ?? {},
    confidence: i.confidence ?? (i.status === 'PASSED' || i.status === 'FAILED' ? 1 : 0),
    errorCode: i.errorCode,
    errorMessage: i.errorMessage,
  };
}
function url(p: RunnerCheckPayload) {
  return `${p.baseUrl}/demo-target/?fixed=${Boolean(p.run.metadata?.demoFixed) ? '1' : '0'}`;
}
async function doc(p: RunnerCheckPayload, b: BrowserSession) {
  const target = url(p),
    [h, c, s] = await Promise.all([
      fetch(target),
      fetch(`${p.baseUrl}/demo-target/styles.css`),
      fetch(`${p.baseUrl}/demo-target/app.js`),
    ]);
  if (!h.ok || !c.ok || !s.ok)
    throw new Error(`Demo target fetch failed ${h.status}/${c.status}/${s.status}`);
  let html = await h.text();
  const css = await c.text(),
    script = await s.text();
  html = html
    .replace(
      /<link[^>]+href=["']\/demo-target\/styles\.css["'][^>]*>/i,
      `<style>${css.replaceAll('</style>', '<\\/style>')}</style>`,
    )
    .replace(/<script[^>]+src=["']\/demo-target\/app\.js["'][^>]*><\/script>/i, '');
  await b.setDocumentContent(html);
  await b.evaluate(
    `globalThis.__MADEPROOF_DEMO_FIXED__=${Boolean(p.run.metadata?.demoFixed) ? 'true' : 'false'}`,
  );
  await b.evaluate(`(()=>{${script}\n//# sourceURL=madeproof-demo-target.js})()`);
  return { targetUrl: target, transport: 'runner-http-fetch-plus-chromium-document' };
}
function ev(
  b: BrowserSession,
  o: Record<string, unknown>,
  shot: Uint8Array,
): RunnerEvidenceDraft[] {
  return [
    {
      type: 'SCREENSHOT',
      source: 'chromium-cdp',
      mimeType: 'image/png',
      extension: 'png',
      base64: Buffer.from(shot).toString('base64'),
    },
    {
      type: 'TRACE',
      source: 'chromium-cdp',
      value: {
        events: b.events,
        observed: o,
        consoleErrors: b.consoleErrors,
        networkErrors: b.networkErrors,
      },
    },
  ];
}
export class RunnerCheckExecutor {
  constructor(private readonly commandRunner: SafeCommandRunner) {}
  async execute(p: RunnerCheckPayload): Promise<RunnerCheckOutcome> {
    const t = p.criterion.verificationType;
    if (['command', 'build', 'test_suite'].includes(t)) return this.command(p);
    if (t === 'browser_interaction') return this.browser(p);
    if (t === 'aria_snapshot') return this.aria(p);
    if (t === 'accessibility') return this.accessibility(p);
    if (t === 'file_exists') return this.file(p);
    if (t === 'http') return this.http(p);
    const a = nowIso();
    return {
      result: res({
        checkId: p.checkId,
        criterionId: p.criterion.id,
        status: 'ERROR',
        startedAt: a,
        summary: 'Runner does not support this verification type.',
        errorCode: 'RUNNER_CAPABILITY_UNSUPPORTED',
      }),
      evidence: [],
    };
  }
  private async command(p: RunnerCheckPayload) {
    const a = nowIso(),
      x = p.criterion.expected,
      command = typeof x.command === 'string' ? x.command : '',
      args = Array.isArray(x.args) ? x.args.map(String) : [];
    if (!command)
      return {
        result: res({
          checkId: p.checkId,
          criterionId: p.criterion.id,
          status: 'ERROR',
          startedAt: a,
          summary: 'Command check configuration is invalid.',
          errorCode: 'CHECK_CONFIG_INVALID',
        }),
        evidence: [],
      };
    try {
      const e = await this.commandRunner.execute({
          command,
          args,
          cwd: p.projectRoot,
          timeoutMs: p.criterion.timeoutSeconds * 1000,
          network: x.network === 'enabled' ? 'enabled' : 'disabled',
          envAllowlist: Array.isArray(x.envAllowlist) ? x.envAllowlist.map(String) : [],
        }),
        ok = e.exitCode === 0 && !e.timedOut;
      return {
        result: res({
          checkId: p.checkId,
          criterionId: p.criterion.id,
          status: ok ? 'PASSED' : 'FAILED',
          startedAt: a,
          summary: ok
            ? `${p.criterion.verificationType} completed with exit code 0.`
            : `${p.criterion.verificationType} did not complete successfully.`,
          details: {
            command,
            args,
            exitCode: e.exitCode,
            signal: e.signal,
            timedOut: e.timedOut,
            isolation: e.isolation,
            stdout: e.stdout.slice(-8000),
            stderr: e.stderr.slice(-8000),
          },
        }),
        evidence: [
          {
            type: p.criterion.verificationType === 'test_suite' ? 'TEST_REPORT' : 'COMMAND_OUTPUT',
            source: `runner:${p.criterion.verificationType}`,
            value: e,
          },
        ],
      };
    } catch (error) {
      return {
        result: res({
          checkId: p.checkId,
          criterionId: p.criterion.id,
          status: 'ERROR',
          startedAt: a,
          summary: 'Runner could not execute the command.',
          errorCode: 'RUNNER_EXECUTION_ERROR',
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
        evidence: [],
      };
    }
  }
  private async browser(p: RunnerCheckPayload) {
    const a = nowIso(),
      b = new BrowserSession();
    try {
      await b.start(1280, 900);
      const transport = await doc(p, b),
        mode = String(p.criterion.expected.mode ?? 'pointer');
      if (mode === 'responsive') {
        const widths = Array.isArray(p.criterion.expected.widths)
            ? p.criterion.expected.widths.map(Number)
            : [320, 375, 390, 430],
          checks: any[] = [];
        for (const width of widths) {
          await b.setViewport(width, 900);
          checks.push({
            width,
            ...(await b.evaluate<any>(
              '({overflow:document.documentElement.scrollWidth>window.innerWidth,scrollWidth:document.documentElement.scrollWidth,innerWidth:window.innerWidth})',
            )),
          });
        }
        const o = { checks, transport },
          shot = await b.screenshot(),
          ok = checks.every((i) => !i.overflow);
        return {
          result: res({
            checkId: p.checkId,
            criterionId: p.criterion.id,
            status: ok ? 'PASSED' : 'FAILED',
            startedAt: a,
            summary: ok
              ? 'No horizontal overflow was observed at representative mobile widths.'
              : 'Horizontal overflow was observed.',
            details: o,
          }),
          evidence: ev(b, o, shot),
        };
      }
      if (mode === 'keyboard') {
        await b.focus('#scenario-b');
        await b.press('Enter');
      } else await b.click('#scenario-b');
      const o: any = await b.evaluate(
        `(()=>{const e=document.querySelector('#scenario-b');return{active:document.body.dataset.active,ariaPressed:e?.getAttribute('aria-pressed'),focused:document.activeElement?.id}})()`,
      );
      o.transport = transport;
      const shot = await b.screenshot(),
        ok = o.active === p.criterion.expected.active;
      return {
        result: res({
          checkId: p.checkId,
          criterionId: p.criterion.id,
          status: ok ? 'PASSED' : 'FAILED',
          startedAt: a,
          summary: ok
            ? `Scenario ${p.criterion.expected.active} activated through ${mode}.`
            : `Scenario ${p.criterion.expected.active} did not activate through ${mode}.`,
          details: {
            expected: p.criterion.expected,
            observed: o,
            consoleErrors: b.consoleErrors,
            networkErrors: b.networkErrors,
          },
        }),
        evidence: ev(b, o, shot),
      };
    } catch (error) {
      return {
        result: res({
          checkId: p.checkId,
          criterionId: p.criterion.id,
          status: 'ERROR',
          startedAt: a,
          summary: 'Browser verification could not run.',
          errorCode: 'BROWSER_CHECK_ERROR',
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
        evidence: [],
      };
    } finally {
      await b.close();
    }
  }
  private async aria(p: RunnerCheckPayload) {
    const a = nowIso(),
      b = new BrowserSession();
    try {
      await b.start();
      const transport = await doc(p, b);
      await b.focus('#scenario-b');
      await b.press('Enter');
      const o: any = await b.evaluate(
        `(()=>{const e=document.querySelector('#scenario-b');return{role:e?.getAttribute('role')||e?.tagName.toLowerCase(),name:e?.textContent?.trim(),ariaPressed:e?.getAttribute('aria-pressed'),active:document.body.dataset.active}})()`,
      );
      o.transport = transport;
      const ok = o.ariaPressed === p.criterion.expected.value;
      return {
        result: res({
          checkId: p.checkId,
          criterionId: p.criterion.id,
          status: ok ? 'PASSED' : 'FAILED',
          startedAt: a,
          summary: ok
            ? 'ARIA state reflects the active scenario.'
            : 'ARIA state does not reflect the expected active scenario.',
          details: { expected: p.criterion.expected, observed: o },
        }),
        evidence: [{ type: 'ARIA_SNAPSHOT', source: 'chromium-cdp', value: o }],
      };
    } catch (error) {
      return {
        result: res({
          checkId: p.checkId,
          criterionId: p.criterion.id,
          status: 'ERROR',
          startedAt: a,
          summary: 'ARIA snapshot could not be captured.',
          errorCode: 'ARIA_CHECK_ERROR',
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
        evidence: [],
      };
    } finally {
      await b.close();
    }
  }
  private async accessibility(p: RunnerCheckPayload) {
    const a = nowIso(),
      b = new BrowserSession();
    try {
      await b.start();
      const transport = await doc(p, b),
        audit = await b.evaluate<{ serious: string[] }>(
          `(()=>{const s=[];const ids=new Set();for(const e of document.querySelectorAll('[id]')){if(ids.has(e.id))s.push('duplicate-id:'+e.id);ids.add(e.id)}for(const e of document.querySelectorAll('button,input,select,textarea,a[href]')){const n=(e.getAttribute('aria-label')||e.getAttribute('aria-labelledby')||e.textContent||e.getAttribute('title')||'').trim();if(!n&&!(e instanceof HTMLInputElement&&e.labels?.length))s.push('missing-accessible-name:'+e.tagName.toLowerCase())}if(!document.querySelector('main'))s.push('missing-main-landmark');return{serious:s}})()`,
        ),
        d = { ...audit, transport },
        ok = audit.serious.length <= Number(p.criterion.expected.seriousOrCritical ?? 0);
      return {
        result: res({
          checkId: p.checkId,
          criterionId: p.criterion.id,
          status: ok ? 'PASSED' : 'FAILED',
          startedAt: a,
          summary: ok
            ? 'No serious defects were found by the automated accessibility smoke.'
            : 'Automated accessibility smoke found serious defects.',
          details: d,
        }),
        evidence: [{ type: 'JSON', source: 'chromium-cdp-accessibility-smoke', value: d }],
      };
    } catch (error) {
      return {
        result: res({
          checkId: p.checkId,
          criterionId: p.criterion.id,
          status: 'ERROR',
          startedAt: a,
          summary: 'Accessibility check could not run.',
          errorCode: 'ACCESSIBILITY_CHECK_ERROR',
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
        evidence: [],
      };
    } finally {
      await b.close();
    }
  }
  private file(p: RunnerCheckPayload) {
    const a = nowIso(),
      rel = String(p.criterion.expected.path ?? ''),
      root = path.resolve(p.projectRoot),
      target = path.resolve(root, rel),
      safe = target === root || target.startsWith(`${root}${path.sep}`),
      exists = safe && fs.existsSync(target);
    return {
      result: res({
        checkId: p.checkId,
        criterionId: p.criterion.id,
        status: exists ? 'PASSED' : 'FAILED',
        startedAt: a,
        summary: exists
          ? 'Required file exists.'
          : 'Required file is missing or escaped the project boundary.',
        details: { path: rel, safe, exists },
      }),
      evidence: [],
    };
  }
  private async http(p: RunnerCheckPayload) {
    const a = nowIso();
    try {
      const target = await validateExternalUrl(String(p.criterion.expected.url ?? '')),
        c = new AbortController(),
        timer = setTimeout(() => c.abort(), p.criterion.timeoutSeconds * 1000),
        r = await fetch(target, { redirect: 'manual', signal: c.signal });
      clearTimeout(timer);
      const bytes = new Uint8Array(await r.arrayBuffer()),
        expected = Number(p.criterion.expected.status ?? 200),
        ok = r.status === expected && bytes.byteLength <= 2 * 1024 * 1024;
      return {
        result: res({
          checkId: p.checkId,
          criterionId: p.criterion.id,
          status: ok ? 'PASSED' : 'FAILED',
          startedAt: a,
          summary: ok
            ? 'HTTP response matched the expectation.'
            : 'HTTP response did not match the expectation.',
          details: { status: r.status, expectedStatus: expected, bytes: bytes.byteLength },
        }),
        evidence: [
          {
            type: 'HTTP_RESPONSE',
            source: 'madeproof-runner',
            value: { status: r.status, expectedStatus: expected, bytes: bytes.byteLength },
          },
        ],
      };
    } catch (error) {
      return {
        result: res({
          checkId: p.checkId,
          criterionId: p.criterion.id,
          status: 'ERROR',
          startedAt: a,
          summary: 'HTTP check could not run safely.',
          errorCode: 'HTTP_CHECK_ERROR',
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
        evidence: [],
      };
    }
  }
}

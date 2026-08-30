import fs from 'node:fs';
import path from 'node:path';
import { BrowserSession } from '../../../apps/runner/src/cdp-browser.js';
import { newId, nowIso } from '../../shared/src/ids.js';
import { validateExternalUrl } from '../../security/src/url-policy.js';
import type { AcceptanceCriterion, CheckStatus, EvidenceItem, VerificationResult } from '../../domain/src/types.js';
import type { VerificationCheck, VerificationContext } from './types.js';

function result(input: {
  checkId: string;
  criterionId: string;
  status: CheckStatus;
  startedAt: string;
  summary: string;
  details?: Record<string, unknown>;
  evidenceIds?: string[];
  confidence?: number;
  errorCode?: string;
  errorMessage?: string;
}): VerificationResult {
  const finishedAt = nowIso();
  return {
    id: newId('res'),
    checkId: input.checkId,
    criterionId: input.criterionId,
    status: input.status,
    startedAt: input.startedAt,
    finishedAt,
    durationMs: new Date(finishedAt).getTime() - new Date(input.startedAt).getTime(),
    summary: input.summary,
    details: input.details ?? {},
    evidenceIds: input.evidenceIds ?? [],
    confidence: input.confidence ?? (input.status === 'PASSED' || input.status === 'FAILED' ? 1 : 0),
    errorCode: input.errorCode,
    errorMessage: input.errorMessage
  };
}

function findTrustedEvidence(evidence: EvidenceItem[], criterion: AcceptanceCriterion): EvidenceItem[] {
  const required = new Set(criterion.evidenceRequirements);
  return evidence.filter((item) => item.trustTier >= 2 && (!required.size || required.has(item.type)) && (!item.criterionId || item.criterionId === criterion.id));
}

export class EvidenceMatchCheck implements VerificationCheck {
  type = 'evidence_match';

  async execute(context: VerificationContext, criterion: AcceptanceCriterion, checkId: string): Promise<VerificationResult> {
    const startedAt = nowIso();
    const expected = criterion.expected;
    const items = findTrustedEvidence(context.evidence, criterion).filter((item) => !expected.type || item.type === expected.type);
    const match = items.find((item) => {
      const value = item.value as Record<string, unknown> | undefined;
      if (!value) return false;
      if (typeof expected.field === 'string') return value[expected.field] === expected.equals;
      if ('status' in expected) return value.status === expected.status;
      if ('exitCode' in expected) return value.exitCode === expected.exitCode;
      return true;
    });
    return result({
      checkId,
      criterionId: criterion.id,
      status: match ? 'PASSED' : 'FAILED',
      startedAt,
      summary: match ? 'Trusted evidence satisfies the expected value.' : 'No trusted evidence satisfies the expected value.',
      details: { expected, consideredEvidence: items.map((item) => ({ id: item.id, provenance: item.provenance, trustTier: item.trustTier })) },
      evidenceIds: match ? [match.id] : items.map((item) => item.id)
    });
  }
}

export class CommandCheck implements VerificationCheck {
  constructor(public type = 'command') {}

  async execute(context: VerificationContext, criterion: AcceptanceCriterion, checkId: string): Promise<VerificationResult> {
    const startedAt = nowIso();
    const expected = criterion.expected;
    const command = typeof expected.command === 'string' ? expected.command : '';
    const args = Array.isArray(expected.args) ? expected.args.map(String) : [];
    if (!command) return result({ checkId, criterionId: criterion.id, status: 'ERROR', startedAt, summary: 'Command check configuration is invalid.', errorCode: 'CHECK_CONFIG_INVALID' });
    try {
      const execution = await context.commandRunner.execute({
        command,
        args,
        cwd: context.projectRoot,
        timeoutMs: criterion.timeoutSeconds * 1000,
        network: expected.network === 'enabled' ? 'enabled' : 'disabled'
      });
      const evidence = context.evidenceService.createInline({
        workspaceId: context.workspaceId,
        runId: context.run.id,
        criterionId: criterion.id,
        type: this.type === 'test_suite' ? 'TEST_REPORT' : 'COMMAND_OUTPUT',
        value: execution,
        source: `runner:${this.type}`,
        sourceActor: 'madeproof-runner',
        provenance: 'EXECUTED_BY_MADEPROOF'
      });
      context.store.addEvidence(evidence);
      const passed = execution.exitCode === 0 && !execution.timedOut;
      return result({
        checkId,
        criterionId: criterion.id,
        status: passed ? 'PASSED' : 'FAILED',
        startedAt,
        summary: passed ? `${this.type} completed with exit code 0.` : `${this.type} did not complete successfully.`,
        details: { command, args, exitCode: execution.exitCode, signal: execution.signal, timedOut: execution.timedOut, isolation: execution.isolation, stdout: execution.stdout.slice(-8000), stderr: execution.stderr.slice(-8000) },
        evidenceIds: [evidence.id]
      });
    } catch (error) {
      return result({ checkId, criterionId: criterion.id, status: 'ERROR', startedAt, summary: 'Runner could not execute the command.', errorCode: 'RUNNER_EXECUTION_ERROR', errorMessage: error instanceof Error ? error.message : String(error) });
    }
  }
}

function demoUrl(context: VerificationContext): string {
  const fixed = Boolean(context.run.metadata?.demoFixed);
  return `${context.baseUrl}/demo-target/?fixed=${fixed ? '1' : '0'}`;
}

async function openDemoDocument(context: VerificationContext, browser: BrowserSession): Promise<Record<string, unknown>> {
  const targetUrl = demoUrl(context);
  const [htmlResponse, cssResponse, scriptResponse] = await Promise.all([
    fetch(targetUrl),
    fetch(`${context.baseUrl}/demo-target/styles.css`),
    fetch(`${context.baseUrl}/demo-target/app.js`)
  ]);
  if (!htmlResponse.ok || !cssResponse.ok || !scriptResponse.ok) {
    throw new Error(`Demo target could not be fetched: html=${htmlResponse.status} css=${cssResponse.status} js=${scriptResponse.status}`);
  }
  const [rawHtml, css, script] = await Promise.all([htmlResponse.text(), cssResponse.text(), scriptResponse.text()]);
  const html = rawHtml
    .replace(/<link[^>]+href=["']\/demo-target\/styles\.css["'][^>]*>/i, `<style>${css.replaceAll('</style>', '<\/style>')}</style>`)
    .replace(/<script[^>]+src=["']\/demo-target\/app\.js["'][^>]*><\/script>/i, '');
  await browser.setDocumentContent(html);
  await browser.evaluate(`globalThis.__MADEPROOF_DEMO_FIXED__=${Boolean(context.run.metadata?.demoFixed) ? 'true' : 'false'}`);
  await browser.evaluate(`(() => { ${script}
//# sourceURL=madeproof-demo-target.js
})()`);
  return {
    targetUrl,
    transport: 'http-fetched-document-injection',
    reason: 'The managed Chromium image blocks all navigated URLs by administrator policy; MADEPROOF still verifies real Chromium DOM, pointer and keyboard behavior after independently fetching the served target.'
  };
}

async function saveBrowserArtifacts(
  context: VerificationContext,
  criterion: AcceptanceCriterion,
  browser: BrowserSession,
  observed: Record<string, unknown>
): Promise<string[]> {
  const screenshot = context.evidenceService.createFile({
    workspaceId: context.workspaceId,
    runId: context.run.id,
    criterionId: criterion.id,
    type: 'SCREENSHOT',
    bytes: await browser.screenshot(),
    extension: 'png',
    source: 'chromium-cdp',
    sourceActor: 'madeproof-runner',
    provenance: 'EXECUTED_BY_MADEPROOF',
    mimeType: 'image/png'
  });
  const trace = context.evidenceService.createInline({
    workspaceId: context.workspaceId,
    runId: context.run.id,
    criterionId: criterion.id,
    type: 'TRACE',
    value: { events: browser.events, observed, consoleErrors: browser.consoleErrors, networkErrors: browser.networkErrors },
    source: 'chromium-cdp',
    sourceActor: 'madeproof-runner',
    provenance: 'EXECUTED_BY_MADEPROOF'
  });
  context.store.addEvidence(screenshot);
  context.store.addEvidence(trace);
  return [screenshot.id, trace.id];
}

export class BrowserInteractionCheck implements VerificationCheck {
  type = 'browser_interaction';

  async execute(context: VerificationContext, criterion: AcceptanceCriterion, checkId: string): Promise<VerificationResult> {
    const startedAt = nowIso();
    const mode = String(criterion.expected.mode ?? 'pointer');
    const browser = new BrowserSession();
    try {
      await browser.start(1280, 900);
      const browserTransport = await openDemoDocument(context, browser);
      let observed: Record<string, unknown>;
      if (mode === 'responsive') {
        const widths = Array.isArray(criterion.expected.widths) ? criterion.expected.widths.map(Number) : [320, 375, 390, 430];
        const checks: Array<{ width: number; overflow: boolean; scrollWidth: number; innerWidth: number }> = [];
        for (const width of widths) {
          await browser.setViewport(width, 900);
          const state = await browser.evaluate<{ overflow: boolean; scrollWidth: number; innerWidth: number }>(`({overflow:document.documentElement.scrollWidth>window.innerWidth,scrollWidth:document.documentElement.scrollWidth,innerWidth:window.innerWidth})`);
          checks.push({ width, ...state });
        }
        observed = { checks, browserTransport };
        const evidenceIds = await saveBrowserArtifacts(context, criterion, browser, observed);
        const passed = checks.every((item) => !item.overflow);
        return result({ checkId, criterionId: criterion.id, status: passed ? 'PASSED' : 'FAILED', startedAt, summary: passed ? 'No horizontal overflow was observed at representative mobile widths.' : 'Horizontal overflow was observed.', details: observed, evidenceIds });
      }
      if (mode === 'keyboard') {
        await browser.focus('#scenario-b');
        await browser.press('Enter');
      } else {
        await browser.click('#scenario-b');
      }
      observed = await browser.evaluate<Record<string, unknown>>(`(() => { const b=document.querySelector('#scenario-b'); return {active:document.body.dataset.active,ariaPressed:b?.getAttribute('aria-pressed'),focused:document.activeElement?.id}; })()`);
      observed.browserTransport = browserTransport;
      const evidenceIds = await saveBrowserArtifacts(context, criterion, browser, observed);
      const passed = observed.active === criterion.expected.active;
      return result({
        checkId,
        criterionId: criterion.id,
        status: passed ? 'PASSED' : 'FAILED',
        startedAt,
        summary: passed ? `Scenario ${criterion.expected.active} activated through ${mode}.` : `Scenario ${criterion.expected.active} did not activate through ${mode}.`,
        details: { expected: criterion.expected, observed, consoleErrors: browser.consoleErrors, networkErrors: browser.networkErrors },
        evidenceIds
      });
    } catch (error) {
      return result({ checkId, criterionId: criterion.id, status: 'ERROR', startedAt, summary: 'Browser verification could not run.', errorCode: 'BROWSER_CHECK_ERROR', errorMessage: error instanceof Error ? error.message : String(error) });
    } finally {
      await browser.close();
    }
  }
}

export class AriaSnapshotCheck implements VerificationCheck {
  type = 'aria_snapshot';

  async execute(context: VerificationContext, criterion: AcceptanceCriterion, checkId: string): Promise<VerificationResult> {
    const startedAt = nowIso();
    const browser = new BrowserSession();
    try {
      await browser.start();
      const browserTransport = await openDemoDocument(context, browser);
      await browser.focus('#scenario-b');
      await browser.press('Enter');
      const snapshot = await browser.evaluate<Record<string, unknown>>(`(() => { const el=document.querySelector('#scenario-b'); return {role:el?.getAttribute('role')||el?.tagName.toLowerCase(),name:el?.textContent?.trim(),ariaPressed:el?.getAttribute('aria-pressed'),active:document.body.dataset.active}; })()`);
      snapshot.browserTransport = browserTransport;
      const ariaEvidence = context.evidenceService.createInline({ workspaceId: context.workspaceId, runId: context.run.id, criterionId: criterion.id, type: 'ARIA_SNAPSHOT', value: snapshot, source: 'chromium-cdp', sourceActor: 'madeproof-runner', provenance: 'EXECUTED_BY_MADEPROOF' });
      context.store.addEvidence(ariaEvidence);
      const passed = snapshot.ariaPressed === criterion.expected.value;
      return result({ checkId, criterionId: criterion.id, status: passed ? 'PASSED' : 'FAILED', startedAt, summary: passed ? 'ARIA state reflects the active scenario.' : 'ARIA state does not reflect the expected active scenario.', details: { expected: criterion.expected, observed: snapshot }, evidenceIds: [ariaEvidence.id] });
    } catch (error) {
      return result({ checkId, criterionId: criterion.id, status: 'ERROR', startedAt, summary: 'ARIA snapshot could not be captured.', errorCode: 'ARIA_CHECK_ERROR', errorMessage: error instanceof Error ? error.message : String(error) });
    } finally { await browser.close(); }
  }
}

export class AccessibilityCheck implements VerificationCheck {
  type = 'accessibility';

  async execute(context: VerificationContext, criterion: AcceptanceCriterion, checkId: string): Promise<VerificationResult> {
    const startedAt = nowIso();
    const browser = new BrowserSession();
    try {
      await browser.start();
      const browserTransport = await openDemoDocument(context, browser);
      const audit = await browser.evaluate<{ serious: string[] }>(`(() => {
        const serious=[];
        const ids=new Set();
        for(const el of document.querySelectorAll('[id]')){ if(ids.has(el.id)) serious.push('duplicate-id:'+el.id); ids.add(el.id); }
        for(const el of document.querySelectorAll('button,input,select,textarea,a[href]')){
          const name=(el.getAttribute('aria-label')||el.getAttribute('aria-labelledby')||el.textContent||el.getAttribute('title')||'').trim();
          if(!name && !(el instanceof HTMLInputElement && el.labels?.length)) serious.push('missing-accessible-name:'+el.tagName.toLowerCase());
        }
        if(!document.querySelector('main')) serious.push('missing-main-landmark');
        return {serious};
      })()`);
      const auditWithTransport = { ...audit, browserTransport };
      const evidence = context.evidenceService.createInline({ workspaceId: context.workspaceId, runId: context.run.id, criterionId: criterion.id, type: 'JSON', value: auditWithTransport, source: 'chromium-cdp-accessibility-smoke', sourceActor: 'madeproof-runner', provenance: 'EXECUTED_BY_MADEPROOF' });
      context.store.addEvidence(evidence);
      const passed = audit.serious.length <= Number(criterion.expected.seriousOrCritical ?? 0);
      return result({ checkId, criterionId: criterion.id, status: passed ? 'PASSED' : 'FAILED', startedAt, summary: passed ? 'No serious defects were found by the automated accessibility smoke.' : 'Automated accessibility smoke found serious defects.', details: auditWithTransport, evidenceIds: [evidence.id] });
    } catch (error) {
      return result({ checkId, criterionId: criterion.id, status: 'ERROR', startedAt, summary: 'Accessibility check could not run.', errorCode: 'ACCESSIBILITY_CHECK_ERROR', errorMessage: error instanceof Error ? error.message : String(error) });
    } finally { await browser.close(); }
  }
}

export class FileExistsCheck implements VerificationCheck {
  type = 'file_exists';

  async execute(context: VerificationContext, criterion: AcceptanceCriterion, checkId: string): Promise<VerificationResult> {
    const startedAt = nowIso();
    const relative = String(criterion.expected.path ?? '');
    const root = path.resolve(context.projectRoot);
    const target = path.resolve(root, relative);
    const safe = target === root || target.startsWith(`${root}${path.sep}`);
    const exists = safe && fs.existsSync(target);
    return result({ checkId, criterionId: criterion.id, status: exists ? 'PASSED' : 'FAILED', startedAt, summary: exists ? 'Required file exists.' : 'Required file is missing or escaped the project boundary.', details: { path: relative, safe, exists } });
  }
}

export class HttpCheck implements VerificationCheck {
  type = 'http';

  async execute(_context: VerificationContext, criterion: AcceptanceCriterion, checkId: string): Promise<VerificationResult> {
    const startedAt = nowIso();
    try {
      const url = await validateExternalUrl(String(criterion.expected.url ?? ''));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), criterion.timeoutSeconds * 1000);
      const response = await fetch(url, { redirect: 'manual', signal: controller.signal });
      clearTimeout(timer);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const expectedStatus = Number(criterion.expected.status ?? 200);
      const passed = response.status === expectedStatus && bytes.byteLength <= 2 * 1024 * 1024;
      return result({ checkId, criterionId: criterion.id, status: passed ? 'PASSED' : 'FAILED', startedAt, summary: passed ? 'HTTP response matched the expectation.' : 'HTTP response did not match the expectation.', details: { status: response.status, expectedStatus, bytes: bytes.byteLength } });
    } catch (error) {
      return result({ checkId, criterionId: criterion.id, status: 'ERROR', startedAt, summary: 'HTTP check could not run safely.', errorCode: 'HTTP_CHECK_ERROR', errorMessage: error instanceof Error ? error.message : String(error) });
    }
  }
}

export class ManualReviewCheck implements VerificationCheck {
  type = 'manual';
  async execute(_context: VerificationContext, criterion: AcceptanceCriterion, checkId: string): Promise<VerificationResult> {
    return result({ checkId, criterionId: criterion.id, status: 'INCONCLUSIVE', startedAt: nowIso(), summary: 'This criterion requires human review.', confidence: 0 });
  }
}

export class SemanticCheck implements VerificationCheck {
  type = 'semantic';
  async execute(_context: VerificationContext, criterion: AcceptanceCriterion, checkId: string): Promise<VerificationResult> {
    return result({ checkId, criterionId: criterion.id, status: 'INCONCLUSIVE', startedAt: nowIso(), summary: 'No semantic verifier provider is configured; deterministic results remain preserved.', confidence: 0, errorCode: 'PROVIDER_UNAVAILABLE' });
  }
}

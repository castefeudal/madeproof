import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BrowserSession } from '../../apps/runner/src/cdp-browser.js';
import { startTestApplication } from '../helpers/runtime.js';

const runtime = await startTestApplication('browser-ui');
const browser = new BrowserSession();
try {
  await browser.start(1440, 1000);
  await browser.navigate(runtime.url);
  const hero = await browser.evaluate<string>(`document.querySelector('.hero h1')?.textContent || ''`);
  assert.match(hero, /MADEPROOF proves it/i);

  await browser.click('#theme-toggle');
  assert.equal(await browser.evaluate(`document.documentElement.dataset.theme`), 'light');
  await browser.click('#language-toggle');
  assert.match(await browser.evaluate<string>(`document.querySelector('[data-i18n="heroOne"]')?.textContent || ''`), /AI может сказать/);
  await browser.click('#language-toggle');

  await browser.click('#open-login');
  await browser.type('#email', 'owner@example.test');
  await browser.type('#password', 'correct horse battery staple');
  await browser.click('#login-form button[type="submit"]');
  await browser.waitFor(`document.querySelector('#app-shell') && !document.querySelector('#app-shell').classList.contains('hidden')`, 15000);
  assert.equal(await browser.evaluate(`document.querySelector('#route-view h1')?.textContent`), 'Needs your attention');

  await browser.focus('#run-demo');
  await browser.press('Enter');
  await browser.waitFor(`location.pathname.startsWith('/runs/') && document.querySelector('.result-hero h1')?.textContent.trim()==='FAILED'`, 120000, 250);
  const failures = await browser.evaluate<string[]>(`[...document.querySelectorAll('.failure h3')].map(x=>x.textContent||'')`);
  assert.ok(failures.some((item) => /keyboard/i.test(item)));
  assert.ok(failures.some((item) => /ARIA/i.test(item)));

  await browser.click('#retry-fixed');
  await browser.waitFor(`location.pathname.startsWith('/runs/') && document.querySelector('.result-hero h1')?.textContent.trim()==='VERIFIED'`, 120000, 250);
  const digest = await browser.evaluate<string>(`document.querySelector('.receipt-grid div:nth-child(2)')?.textContent?.replace('Digest','').trim() || ''`);
  assert.match(digest, /^[a-f0-9]{64}$/);

  fs.mkdirSync(path.resolve('artifacts/browser'), { recursive: true });
  fs.writeFileSync(path.resolve('artifacts/browser/desktop-verified.png'), await browser.screenshot());
  await browser.setViewport(390, 844);
  const overflow = await browser.evaluate<boolean>(`document.documentElement.scrollWidth > window.innerWidth`);
  assert.equal(overflow, false);
  fs.writeFileSync(path.resolve('artifacts/browser/mobile-verified.png'), await browser.screenshot());
  assert.deepEqual(browser.consoleErrors, []);
  assert.deepEqual(browser.networkErrors, []);
  const report = { verdict: 'VERIFIED', digest, failuresObserved: failures, desktop: 'artifacts/browser/desktop-verified.png', mobile: 'artifacts/browser/mobile-verified.png', consoleErrors: browser.consoleErrors, networkErrors: browser.networkErrors };
  fs.writeFileSync(path.resolve('artifacts/browser/ui-flow.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await runtime.close();
}

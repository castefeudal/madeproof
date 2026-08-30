const state = {
  csrf: null,
  actor: null,
  language: localStorage.getItem('madeproof-language') || 'en',
  theme: localStorage.getItem('madeproof-theme') || 'system',
  currentRunId: sessionStorage.getItem('madeproof-current-run') || null
};

const translations = {
  en: { trustLayer: 'TRUST LAYER FOR AI DELEGATION', heroOne: 'AI can say “done”.', heroTwo: 'MADEPROOF proves it.', heroCopy: 'Define what done means, collect evidence, verify the result, and review only exceptions.', verifyFirst: 'Verify your first task', seeHow: 'See how it works' },
  ru: { trustLayer: 'СЛОЙ ДОВЕРИЯ ДЛЯ AI-ДЕЛЕГИРОВАНИЯ', heroOne: 'AI может сказать «готово».', heroTwo: 'MADEPROOF это доказывает.', heroCopy: 'Определите, что значит «готово», соберите доказательства, проверьте результат и разбирайте только исключения.', verifyFirst: 'Проверить первую задачу', seeHow: 'Как это работает' }
};

const landing = document.querySelector('#landing');
const loginPanel = document.querySelector('#login-panel');
const appShell = document.querySelector('#app-shell');
const routeView = document.querySelector('#route-view');
const logoutButton = document.querySelector('#logout-button');
const toast = document.querySelector('#toast');

function applyPreferences() {
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.lang = state.language;
  document.querySelector('#theme-toggle').textContent = state.theme[0].toUpperCase() + state.theme.slice(1);
  document.querySelector('#language-toggle').textContent = state.language === 'en' ? 'RU' : 'EN';
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = translations[state.language][node.dataset.i18n] || node.textContent;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 5000);
}

async function api(path, options = {}) {
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(state.csrf && !['GET', 'HEAD'].includes(options.method || 'GET') ? { 'X-CSRF-Token': state.csrf } : {}),
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `HTTP ${response.status}`);
  return body;
}

function navigate(path) {
  history.pushState({}, '', path);
  renderRoute();
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('[data-nav]');
  if (!link) return;
  event.preventDefault();
  navigate(link.getAttribute('href'));
});
window.addEventListener('popstate', renderRoute);

document.querySelector('#open-login').addEventListener('click', () => {
  landing.classList.add('hidden');
  loginPanel.classList.remove('hidden');
  document.querySelector('#email').focus();
});
document.querySelector('#theme-toggle').addEventListener('click', () => {
  state.theme = state.theme === 'system' ? 'light' : state.theme === 'light' ? 'dark' : 'system';
  localStorage.setItem('madeproof-theme', state.theme);
  applyPreferences();
});
document.querySelector('#language-toggle').addEventListener('click', () => {
  state.language = state.language === 'en' ? 'ru' : 'en';
  localStorage.setItem('madeproof-language', state.language);
  applyPreferences();
});

document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  button.textContent = 'Signing in…';
  try {
    const result = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email: event.target.email.value, password: event.target.password.value }) });
    state.csrf = result.csrfToken;
    state.actor = result.user;
    await enterApp();
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; button.textContent = 'Sign in'; }
});

logoutButton.addEventListener('click', async () => {
  try { await api('/auth/logout', { method: 'POST', body: '{}' }); } catch {}
  state.actor = null; state.csrf = null;
  appShell.classList.add('hidden'); logoutButton.classList.add('hidden'); landing.classList.remove('hidden');
  history.replaceState({}, '', '/');
});

async function enterApp() {
  landing.classList.add('hidden');
  loginPanel.classList.add('hidden');
  appShell.classList.remove('hidden');
  logoutButton.classList.remove('hidden');
  if (location.pathname === '/') history.replaceState({}, '', '/app');
  await renderRoute();
}

function setActiveNav() {
  for (const item of document.querySelectorAll('.nav-item')) item.classList.toggle('active', location.pathname.startsWith(item.getAttribute('href')));
}

async function renderRoute() {
  if (!state.actor) return;
  setActiveNav();
  routeView.innerHTML = '<p class="loading">Loading workspace</p>';
  try {
    if (location.pathname.startsWith('/runs/')) return await renderRun(location.pathname.split('/')[2]);
    if (location.pathname === '/settings/api-keys') return await renderApiKeys();
    if (location.pathname === '/projects') return await renderProjects();
    if (location.pathname === '/tasks') return await renderTasks();
    if (location.pathname === '/settings/integrations') return renderIntegrations();
    return await renderDashboard();
  } catch (error) {
    routeView.innerHTML = `<div class="panel"><h1>Could not load this view</h1><p>${escapeHtml(error.message)}</p><button class="secondary" id="retry-view">Retry</button></div>`;
    document.querySelector('#retry-view').addEventListener('click', renderRoute);
  }
}

async function renderDashboard() {
  const data = await api('/dashboard');
  routeView.innerHTML = `
    <header class="page-head"><div><p class="eyebrow">EXCEPTION FIRST</p><h1>Needs your attention</h1><p class="muted">Review failures and ambiguity. Ignore completed work.</p></div></header>
    <section class="metrics" aria-label="Workspace status">
      <div class="metric"><strong>${data.counts.attention}</strong><span>Needs attention</span></div>
      <div class="metric"><strong>${data.counts.running}</strong><span>Running</span></div>
      <div class="metric"><strong>${data.counts.verified}</strong><span>Verified</span></div>
    </section>
    <section class="demo-panel">
      <div><p class="eyebrow">EXECUTABLE DEMO</p><h2>Prove a hidden interaction defect</h2><p class="muted">The agent claims completion. MADEPROOF executes pointer, keyboard, ARIA, tests, build, responsive and accessibility checks.</p></div>
      <button class="primary" id="run-demo">Run failing verification</button>
    </section>
    ${data.attention.length ? `<div class="table-wrap"><table><thead><tr><th>Task</th><th>Project</th><th>Status</th><th>Updated</th></tr></thead><tbody>${data.attention.map(task => `<tr><td><a href="/tasks/${task.id}">${escapeHtml(task.title)}</a></td><td>${escapeHtml(task.project_name)}</td><td>${status(task.status)}</td><td>${new Date(task.updated_at).toLocaleString()}</td></tr>`).join('')}</tbody></table></div>` : '<div class="panel" style="margin-top:2rem"><strong>No tasks need your attention.</strong><p class="muted">Create a task or run the executable demo.</p></div>'}
  `;
  document.querySelector('#run-demo').addEventListener('click', runFailingDemo);
}

async function runFailingDemo(event) {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = 'Creating outcome contract…';
  try {
    let projects = (await api('/projects')).items;
    const project = projects.find(item => item.name === 'MADEPROOF Demo') || await api('/projects', { method: 'POST', headers: { 'Idempotency-Key': `demo-project-${Date.now()}` }, body: JSON.stringify({ name: 'MADEPROOF Demo', projectType: 'web' }) });
    button.textContent = 'Starting independent checks…';
    const task = await api('/tasks', { method: 'POST', body: JSON.stringify({ projectId: project.id, title: 'Fix Scenario B interaction', intent: 'Fix Scenario B selector interaction. It must work with mouse and keyboard without breaking accessibility state.', template: 'frontend-bug-fix-demo' }) });
    await api(`/tasks/${task.id}/contracts`, { method: 'POST', body: '{}' });
    const run = await api(`/tasks/${task.id}/runs`, { method: 'POST', body: JSON.stringify({ metadata: { demoFixed: false }, artifactRef: 'demo-target@broken' }) });
    await api(`/runs/${run.id}/evidence`, { method: 'POST', body: JSON.stringify({ type: 'TEXT', value: { claim: 'Done. Everything works.' }, source: 'demo-agent' }) });
    state.currentRunId = run.id;
    sessionStorage.setItem('madeproof-current-run', run.id);
    button.textContent = 'Running browser and deterministic checks…';
    await api(`/runs/${run.id}/verify`, { method: 'POST', headers: { 'Idempotency-Key': `verify-${run.id}` }, body: '{}' });
    navigate(`/runs/${run.id}`);
  } catch (error) { showToast(error.message); button.disabled = false; button.textContent = 'Run failing verification'; }
}

async function renderRun(runId) {
  const [run, verification, receipt] = await Promise.all([
    api(`/runs/${runId}`),
    api(`/runs/${runId}/verification`),
    api(`/runs/${runId}/receipt`).catch(() => null)
  ]);
  const verdict = verification.verdict.machine_verdict;
  const results = verification.results;
  const failed = results.filter(item => item.status !== 'PASSED');
  const passed = results.filter(item => item.status === 'PASSED');
  routeView.innerHTML = `
    <header class="page-head"><div><p class="eyebrow">RUN ${run.attempt}</p><h1>Outcome verification</h1><p class="muted">${escapeHtml(run.artifact_ref || 'No artifact reference')}</p></div><button class="secondary" id="back-dashboard">Dashboard</button></header>
    <section class="result-hero">
      ${status(verdict)}
      <h1>${verdict.replace('_', ' ')}</h1>
      <p><strong>${passed.length}/${results.length} checks passed.</strong></p>
      <p>${escapeHtml(verification.verdict.reason)}</p>
      ${verdict !== 'VERIFIED' ? '<button class="primary" id="retry-fixed">Retry with fixed artifact</button>' : ''}
    </section>
    ${failed.length ? `<section><h2>Needs your attention</h2><div class="card-list">${failed.map((item, index) => `<article class="criterion failure"><div class="criterion-index">${String(index + 1).padStart(2, '0')}</div><div><h3>${escapeHtml(item.summary)}</h3><p>Expected and observed values are preserved in machine-readable result details.</p><details><summary>Technical evidence</summary><pre>${escapeHtml(JSON.stringify(item.details, null, 2))}</pre></details></div>${status(item.status)}</article>`).join('')}</div></section>` : ''}
    <section><h2>Passed checks</h2><div class="card-list">${passed.map((item, index) => `<article class="criterion"><div class="criterion-index">${String(index + 1).padStart(2, '0')}</div><div><h3>${escapeHtml(item.summary)}</h3><p>${item.durationMs} ms · confidence ${item.confidence}</p></div>${status(item.status)}</article>`).join('')}</div></section>
    ${receipt ? `<section style="margin-top:2rem"><h2>Verification receipt</h2><div class="receipt"><p>MADEPROOF / VERIFICATION RECEIPT</p><div class="receipt-grid"><div><small>Receipt</small><br>${receipt.id}</div><div><small>Digest</small><br>${receipt.digest}</div><div><small>Run</small><br>${run.id}</div><div><small>Created</small><br>${receipt.created_at}</div></div></div></section>` : ''}
  `;
  document.querySelector('#back-dashboard').addEventListener('click', () => navigate('/app'));
  document.querySelector('#retry-fixed')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Verifying fixed artifact…';
    try {
      const retry = await api(`/runs/${runId}/retry`, { method: 'POST', body: JSON.stringify({ metadata: { demoFixed: true }, artifactRef: 'demo-target@fixed' }) });
      await api(`/runs/${retry.id}/evidence`, { method: 'POST', body: JSON.stringify({ type: 'TEXT', value: { claim: 'Implemented keyboard and ARIA fix.' }, source: 'demo-agent' }) });
      await api(`/runs/${retry.id}/verify`, { method: 'POST', headers: { 'Idempotency-Key': `verify-${retry.id}` }, body: '{}' });
      state.currentRunId = retry.id;
      sessionStorage.setItem('madeproof-current-run', retry.id);
      navigate(`/runs/${retry.id}`);
    } catch (error) { showToast(error.message); button.disabled = false; button.textContent = 'Retry with fixed artifact'; }
  });
}

async function renderProjects() {
  const data = await api('/projects');
  routeView.innerHTML = `<header class="page-head"><div><p class="eyebrow">WORKSPACE</p><h1>Projects</h1></div></header><div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Repository</th><th>Created</th></tr></thead><tbody>${data.items.map(item => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.project_type)}</td><td>${escapeHtml(item.repository_url || '—')}</td><td>${new Date(item.created_at).toLocaleString()}</td></tr>`).join('')}</tbody></table></div>`;
}
async function renderTasks() {
  const data = await api('/tasks');
  routeView.innerHTML = `<header class="page-head"><div><p class="eyebrow">OUTCOME CONTRACTS</p><h1>Tasks</h1></div></header><div class="table-wrap"><table><thead><tr><th>Task</th><th>Status</th><th>Contract</th><th>Updated</th></tr></thead><tbody>${data.items.map(item => `<tr><td>${escapeHtml(item.title)}</td><td>${status(item.status)}</td><td>v${item.latest_contract_version}</td><td>${new Date(item.updated_at).toLocaleString()}</td></tr>`).join('')}</tbody></table></div>`;
}
async function renderApiKeys() {
  const data = await api('/api-keys');
  routeView.innerHTML = `<header class="page-head"><div><p class="eyebrow">AGENT ACCESS</p><h1>API keys</h1><p class="muted">Secrets are shown once. Stored values are cryptographic hashes.</p></div></header><form id="key-form" class="panel"><label>Name<input name="name" value="Hermes local" required></label><label>Scopes<select name="preset"><option value="agent">Agent verification</option><option value="read">Read only</option></select></label><button class="primary" type="submit">Create key</button></form><div class="table-wrap"><table><thead><tr><th>Name</th><th>Prefix</th><th>Scopes</th><th>Last used</th></tr></thead><tbody>${data.items.map(item => `<tr><td>${escapeHtml(item.name)}</td><td><code>${escapeHtml(item.prefix)}</code></td><td>${item.scopes.map(scope => `<span class="tag">${escapeHtml(scope)}</span>`).join(' ')}</td><td>${item.last_used_at ? new Date(item.last_used_at).toLocaleString() : 'Never'}</td></tr>`).join('')}</tbody></table></div><div id="new-key"></div>`;
  document.querySelector('#key-form').addEventListener('submit', async event => {
    event.preventDefault();
    const scopes = event.target.preset.value === 'read' ? ['projects:read', 'tasks:read', 'receipts:read'] : ['projects:read', 'projects:write', 'tasks:read', 'tasks:write', 'evidence:write', 'verification:run', 'receipts:read'];
    const created = await api('/api-keys', { method: 'POST', body: JSON.stringify({ name: event.target.name.value, scopes }) });
    document.querySelector('#new-key').innerHTML = `<div class="panel" style="margin-top:1rem"><h2>Copy this key now</h2><pre>${escapeHtml(created.secret)}</pre><p class="muted">It cannot be shown again.</p></div>`;
  });
}
function renderIntegrations() {
  routeView.innerHTML = `<header class="page-head"><div><p class="eyebrow">ADAPTERS</p><h1>Integrations</h1></div></header><div class="card-list"><article class="panel"><h2>MCP</h2><p class="muted">stdio and authenticated stateless HTTP are implemented.</p><span class="tag">Implemented</span></article><article class="panel"><h2>GitHub App</h2><p class="muted">Webhook verification, least-privilege permissions and Check Run adapter are included; live credentials are not configured in this environment.</p><span class="tag">Credential test pending</span></article><article class="panel"><h2>Semantic providers</h2><p class="muted">Deterministic checks continue when providers are unavailable. Semantic criteria conservatively require review.</p><span class="tag">Optional</span></article></div>`;
}

function status(value) {
  const normalized = String(value || 'ERROR');
  const cls = normalized === 'VERIFIED' || normalized === 'PASSED' ? 'verified' : normalized === 'FAILED' ? 'failed' : normalized === 'ERROR' ? 'error' : 'review';
  const icon = cls === 'verified' ? '✓' : cls === 'failed' ? '×' : cls === 'error' ? '?' : '!';
  return `<span class="status status-${cls}"><span aria-hidden="true">${icon}</span>${escapeHtml(normalized.replace('_', ' '))}</span>`;
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }

async function bootstrap() {
  applyPreferences();
  try {
    const me = await api('/auth/me');
    state.actor = me.actor;
    state.csrf = me.csrfToken;
    await enterApp();
  } catch {
    if (location.pathname !== '/') history.replaceState({}, '', '/');
    landing.classList.remove('hidden');
  }
}
bootstrap();

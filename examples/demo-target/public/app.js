const params = new URLSearchParams(location.search);
const fixed = globalThis.__MADEPROOF_DEMO_FIXED__ ?? params.get('fixed') === '1';
const buttons = [...document.querySelectorAll('.selector button')];
const output = document.querySelector('#active-state');

function setActive(value) {
  document.body.dataset.active = value;
  for (const button of buttons) button.setAttribute('aria-pressed', String(button.id === `scenario-${value.toLowerCase()}`));
  output.textContent = `Active: Scenario ${value}`;
}

document.querySelector('#scenario-a').addEventListener('click', () => setActive('A'));
const scenarioB = document.querySelector('#scenario-b');
if (fixed) {
  scenarioB.addEventListener('click', () => setActive('B'));
} else {
  scenarioB.addEventListener('pointerup', () => setActive('B'));
}

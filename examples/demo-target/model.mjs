export function activateScenario(current, next) {
  if (!['A', 'B'].includes(next)) throw new TypeError('Unknown scenario');
  return current === next ? current : next;
}

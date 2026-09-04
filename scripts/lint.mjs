import fs from 'node:fs';
import path from 'node:path';

const roots = ['apps', 'packages', 'tests', 'scripts'];
const forbidden = [
  { pattern: /console\.log\(process\.env/g, message: 'Never log process.env' },
  { pattern: /\b(?:describe|it|test)\.(?:skip|todo)\b/g, message: 'No skipped critical tests' },
  {
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    message: 'Private key detected',
  },
  { pattern: /AKIA[0-9A-Z]{16}/g, message: 'Possible AWS key detected' },
];
const files = [];
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(?:ts|js|mjs|json|ya?ml|md|html|css)$/.test(entry.name)) files.push(full);
  }
}
roots.forEach(walk);
let errors = 0;
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  for (const rule of forbidden) {
    if (rule.pattern.test(text)) {
      console.error(`${file}: ${rule.message}`);
      errors += 1;
    }
    rule.pattern.lastIndex = 0;
  }
}
if (errors) process.exit(1);
console.log(`lint PASS (${files.length} files scanned)`);

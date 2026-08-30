import fs from 'node:fs';
import path from 'node:path';

const roots = ['apps', 'packages', 'tests', 'scripts', 'docs'];
let errors = 0;
let files = 0;
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(?:ts|js|mjs|json|ya?ml|md|html|css|sql)$/.test(entry.name)) {
      files += 1;
      const text = fs.readFileSync(full, 'utf8');
      if (!text.endsWith('\n')) {
        console.error(`${full}: missing final newline`);
        errors += 1;
      }
      text.split('\n').forEach((line, index) => {
        if (/[ \t]+$/.test(line)) {
          console.error(`${full}:${index + 1}: trailing whitespace`);
          errors += 1;
        }
      });
    }
  }
}
roots.forEach(walk);
if (errors) process.exit(1);
console.log(`format check PASS (${files} files scanned)`);

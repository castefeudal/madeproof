import fs from 'node:fs';
import path from 'node:path';

const pairs = [
  ['apps/web/public', 'dist/apps/web/public'],
  ['examples/demo-target/public', 'dist/examples/demo-target/public'],
];
for (const [from, to] of pairs) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

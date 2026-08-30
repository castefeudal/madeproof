import childProcess from 'node:child_process';
import fs from 'node:fs';

const required = ['examples/demo-target/public/index.html', 'examples/demo-target/public/app.js', 'examples/demo-target/public/styles.css', 'examples/demo-target/model.mjs'];
for (const file of required) {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) throw new Error(`Missing build input: ${file}`);
}
const syntax = childProcess.spawnSync(process.execPath, ['--check', 'examples/demo-target/public/app.js'], { encoding: 'utf8' });
if (syntax.status !== 0) throw new Error(syntax.stderr || 'Demo target JavaScript syntax check failed');
console.log(JSON.stringify({ build: 'passed', files: required.length }));

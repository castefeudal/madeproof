import { createApplication } from './app.js';

const app = createApplication();
const started = await app.start();
console.error(JSON.stringify({ level: 'info', message: 'MADEPROOF API started', url: started.url, version: '0.1.0' }));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}

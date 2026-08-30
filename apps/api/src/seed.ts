import { createApplication } from './app.js';

const app = createApplication();
const actor = { id: app.service.owner.userId, workspaceId: app.service.owner.workspaceId, type: 'USER' as const, scopes: ['*'] };
if (!app.service.listProjects(actor).length) {
  const project = app.service.createProject(actor, { name: 'MADEPROOF Demo', projectType: 'web' });
  const task = app.service.createTask(actor, { projectId: project.id, title: 'Fix Scenario B interaction', intent: 'Fix Scenario B selector interaction. It must work with mouse and keyboard without breaking accessibility state.', template: 'frontend-bug-fix-demo' });
  app.service.generateContract(actor, task.id);
}
await app.close();
console.log('database seed PASS');

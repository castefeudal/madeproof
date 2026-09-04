import { createApplication } from './app.js';

const app = createApplication();
await app.service.initialize();
const actor = {
  id: app.service.owner.userId,
  workspaceId: app.service.owner.workspaceId,
  type: 'USER' as const,
  scopes: ['*'],
};
if (!(await app.service.listProjects(actor)).length) {
  const project = await app.service.createProject(actor, { name: 'MADEPROOF Demo', projectType: 'web' });
  const task = await app.service.createTask(actor, {
    projectId: project.id,
    title: 'Fix Scenario B interaction',
    intent:
      'Fix Scenario B selector interaction. It must work with mouse and keyboard without breaking accessibility state.',
    template: 'frontend-bug-fix-demo',
  });
  await app.service.generateContract(actor, task.id);
}
await app.close();
console.log('database seed PASS');

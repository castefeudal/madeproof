import { generateOutcomeContract } from '../../domain/src/contract-generator.js';
import { assertTaskTransition } from '../../domain/src/state-machine.js';
import type { AcceptanceCriterion, OutcomeContract, TaskStatus } from '../../domain/src/types.js';
import type { MadeProofStore } from '../../db/src/store.js';
import type { EvidenceService } from '../../evidence/src/evidence-service.js';
import type { RuntimeConfig } from '../../config/src/runtime.js';
import { canonicalJson, sha256 } from '../../shared/src/canonical.js';
import { MadeProofError } from '../../shared/src/errors.js';
import { newId } from '../../shared/src/ids.js';
import { hashPassword, hashToken, randomToken, verifyPassword } from '../../security/src/crypto.js';

export interface Actor {
  id: string;
  workspaceId: string;
  type: 'USER' | 'API_KEY' | 'MCP' | 'GITHUB' | 'SYSTEM';
  scopes: string[];
  email?: string;
}

export interface RunnerActor {
  id: string;
  workspaceId: string;
  version: string;
  capabilities: string[];
}

export class MadeProofService {
  owner!: { userId: string; workspaceId: string };
  private initialized = false;

  constructor(
    readonly store: MadeProofStore,
    readonly evidenceService: EvidenceService,
    readonly config: RuntimeConfig,
    readonly projectRoot: string
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.store.migrate();
    this.owner = await this.store.bootstrapOwner(this.config.adminEmail.toLowerCase(), hashPassword(this.config.adminPassword));
    this.initialized = true;
  }

  private ready(): void {
    if (!this.initialized) throw new MadeProofError('SERVICE_NOT_READY', 'MADEPROOF service is not initialized', 503);
  }

  async login(email: string, password: string): Promise<{ token: string; csrfToken: string; expiresAt: string; user: any; workspace: any }> {
    this.ready();
    const user = await this.store.getUserByEmail(email.toLowerCase());
    if (!user || !verifyPassword(password, user.password_hash)) throw new MadeProofError('AUTH_INVALID', 'Email or password is incorrect', 401);
    const token = randomToken();
    const csrfToken = randomToken(24);
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    await this.store.createSession(user.id, hashToken(token), csrfToken, expiresAt);
    const workspace = await this.store.getDefaultWorkspaceForUser(user.id);
    return { token, csrfToken, expiresAt, user: { id: user.id, email: user.email }, workspace };
  }

  async logout(token: string): Promise<void> { await this.store.revokeSession(hashToken(token)); }

  async authenticateSession(token: string): Promise<Actor> {
    this.ready();
    const session = await this.store.getSession(hashToken(token));
    if (!session) throw new MadeProofError('AUTH_REQUIRED', 'Session is invalid or expired', 401);
    const workspace = await this.store.getDefaultWorkspaceForUser(session.user_id);
    if (!workspace) throw new MadeProofError('WORKSPACE_REQUIRED', 'User has no accessible workspace', 403);
    return { id: session.user_id, workspaceId: workspace.id, type: 'USER', scopes: ['*'], email: session.email };
  }

  async authenticateApiKey(token: string, requiredScope?: string): Promise<Actor> {
    this.ready();
    const key = await this.store.getApiKey(hashToken(token));
    if (!key) throw new MadeProofError('AUTH_REQUIRED', 'API key is invalid, expired or revoked', 401);
    const scopes = Array.isArray(key.scopes) ? key.scopes : [];
    if (requiredScope && !scopes.includes(requiredScope) && !scopes.includes('*')) throw new MadeProofError('INSUFFICIENT_SCOPE', `API key requires scope ${requiredScope}`, 403);
    return { id: key.id, workspaceId: key.workspace_id, type: 'API_KEY', scopes };
  }

  async createApiKey(actor: Actor, input: { name: string; scopes: string[]; expiresAt?: string }): Promise<{ secret: string; key: any }> {
    this.requireUser(actor);
    const allowed = new Set(['tasks:read','tasks:write','evidence:write','verification:run','receipts:read','projects:write','projects:read']);
    const scopes = [...new Set(input.scopes)];
    if (!scopes.length || scopes.some((scope) => !allowed.has(scope))) throw new MadeProofError('VALIDATION_ERROR', 'One or more API key scopes are invalid', 422);
    const secret = `mp_${randomToken(32)}`;
    const prefix = secret.slice(0, 12);
    const key = await this.store.createApiKey({ workspaceId: actor.workspaceId, userId: actor.id, name: input.name, prefix, keyHash: hashToken(secret), scopes, expiresAt: input.expiresAt });
    await this.audit(actor, 'api_key.created', 'api_key', key.id, undefined, { name: input.name, scopes });
    return { secret, key: { id: key.id, name: key.name, prefix: key.prefix, scopes: key.scopes ?? scopes, expiresAt: key.expires_at ?? key.expiresAt ?? null, createdAt: key.created_at ?? key.createdAt } };
  }

  async listApiKeys(actor: Actor): Promise<any[]> { this.requireUser(actor); return await this.store.listApiKeys(actor.workspaceId); }
  async revokeApiKey(actor: Actor, keyId: string): Promise<boolean> { this.requireUser(actor); const revoked=await this.store.revokeApiKey(actor.workspaceId,keyId); if(revoked)await this.audit(actor,'api_key.revoked','api_key',keyId); return revoked; }

  async createProject(actor: Actor, input: { name: string; projectType?: string; repositoryUrl?: string }): Promise<any> {
    this.requireScope(actor,'projects:write'); const project=await this.store.createProject({workspaceId:actor.workspaceId,...input}); await this.audit(actor,'project.created','project',project.id,undefined,project); return project;
  }
  async listProjects(actor: Actor, limit=50, offset=0): Promise<any[]> { this.requireScope(actor,'projects:read'); return await this.store.listProjects(actor.workspaceId,Math.min(limit,100),Math.max(offset,0)); }
  async getProject(actor: Actor, projectId:string): Promise<any> { this.requireScope(actor,'projects:read'); return await this.store.getProject(actor.workspaceId,projectId); }

  async createTask(actor: Actor, input:{projectId:string;title:string;intent:string;template?:string}): Promise<any> { this.requireScope(actor,'tasks:write'); const task=await this.store.createTask({workspaceId:actor.workspaceId,actorId:actor.id,...input}); await this.audit(actor,'task.created','task',task.id,undefined,task); return task; }
  async listTasks(actor:Actor,filters:any={}):Promise<any[]>{this.requireScope(actor,'tasks:read');return await this.store.listTasks(actor.workspaceId,filters)}
  async getTask(actor:Actor,taskId:string):Promise<any>{this.requireScope(actor,'tasks:read');return await this.store.getTask(actor.workspaceId,taskId)}

  async generateContract(actor:Actor,taskId:string):Promise<OutcomeContract>{this.requireScope(actor,'tasks:write');const task=await this.store.getTask(actor.workspaceId,taskId),version=Number(task.latest_contract_version)+1,contract=generateOutcomeContract({taskId,version,intent:task.intent,template:task.template??undefined}),created=await this.store.createContract(actor.workspaceId,contract);await this.audit(actor,'contract.created','contract',contract.id,undefined,created);return created}
  async updateContract(actor:Actor,taskId:string,input:Partial<OutcomeContract>&{acceptanceCriteria?:AcceptanceCriterion[]}):Promise<OutcomeContract>{this.requireScope(actor,'tasks:write');const task=await this.store.getTask(actor.workspaceId,taskId),previous=await this.store.getContract(actor.workspaceId,taskId);if(previous.lockedAt)throw new MadeProofError('CONTRACT_LOCKED','This contract version is attached to a run. Create a retry instead.',409);const next:OutcomeContract={...previous,id:newId('contract'),version:Number(task.latest_contract_version)+1,goal:input.goal??previous.goal,expectedOutcome:input.expectedOutcome??previous.expectedOutcome,scope:input.scope??previous.scope,constraints:input.constraints??previous.constraints,forbiddenActions:input.forbiddenActions??previous.forbiddenActions,requiredEvidence:input.requiredEvidence??previous.requiredEvidence,risk:input.risk??previous.risk,verificationStrategy:input.verificationStrategy??previous.verificationStrategy,acceptanceCriteria:input.acceptanceCriteria??previous.acceptanceCriteria,createdAt:new Date().toISOString(),lockedAt:null};if(!next.acceptanceCriteria.length)throw new MadeProofError('VALIDATION_ERROR','Outcome contract requires at least one acceptance criterion',422);const created=await this.store.createContract(actor.workspaceId,next);await this.audit(actor,'contract.version_created','contract',next.id,previous,created);return created}
  async listContracts(actor:Actor,taskId:string):Promise<OutcomeContract[]>{this.requireScope(actor,'tasks:read');return await this.store.listContracts(actor.workspaceId,taskId)}

  async startRun(actor:Actor,taskId:string,input:{metadata?:Record<string,unknown>;artifactRef?:string;agentId?:string}={}):Promise<any>{this.requireScope(actor,'tasks:write');const task=await this.store.getTask(actor.workspaceId,taskId);if(!['READY','FAILED','REVIEW_REQUIRED','VERIFIED'].includes(task.status))throw new MadeProofError('TASK_NOT_RUNNABLE',`Task in ${task.status} cannot start a new run`,409);assertTaskTransition(task.status as TaskStatus,'IN_PROGRESS');await this.store.updateTaskStatus(actor.workspaceId,task.id,task.status,'IN_PROGRESS');const run=await this.store.startRun({workspaceId:actor.workspaceId,taskId,actorId:actor.id,...input});await this.audit(actor,'run.created','run',run.id,undefined,run);return run}

  async addEvidence(actor:Actor,runId:string,input:{criterionId?:string;type:string;value:unknown;source?:string;mimeType?:string}):Promise<any>{this.requireScope(actor,'evidence:write');const run=await this.store.getRun(actor.workspaceId,runId);if(!['AWAITING_EVIDENCE','RUNNING'].includes(run.status))throw new MadeProofError('RUN_NOT_ACCEPTING_EVIDENCE',`Run in ${run.status} is not accepting evidence`,409);const item=this.evidenceService.createInline({workspaceId:actor.workspaceId,runId,criterionId:input.criterionId,type:input.type,value:input.value,source:input.source??actor.type.toLowerCase(),sourceActor:actor.id,provenance:actor.type==='GITHUB'?'EXTERNAL_SIGNED':'SELF_REPORTED',mimeType:input.mimeType});await this.store.addEvidence(item);await this.audit(actor,'evidence.added','evidence',item.id,undefined,{runId,type:item.type,provenance:item.provenance,hash:item.contentHash});return item}

  async verify(actor:Actor,runId:string):Promise<any>{this.requireScope(actor,'verification:run');const run=await this.store.getRun(actor.workspaceId,runId);if(!['AWAITING_EVIDENCE','RUNNING','VERIFYING'].includes(run.status))throw new MadeProofError('RUN_NOT_VERIFIABLE',`Run in ${run.status} cannot be verified`,409);await this.store.getContract(actor.workspaceId,run.task_id,run.contract_version);const job=await this.store.enqueueVerificationJob({workspaceId:actor.workspaceId,runId,actorId:actor.id,requestKey:`verify:${runId}`,maxAttempts:5});await this.audit(actor,'verification.queued','run',runId,undefined,{jobId:job.id});return job}

  async cancelVerification(actor:Actor,runId:string):Promise<boolean>{this.requireScope(actor,'verification:run');const run=await this.store.getRun(actor.workspaceId,runId),cancelled=await this.store.cancelVerificationJob(actor.workspaceId,runId);if(!cancelled)return false;const fresh=await this.store.getRun(actor.workspaceId,runId);if(['CREATED','QUEUED','RUNNING','AWAITING_EVIDENCE','VERIFYING'].includes(fresh.status))await this.store.updateRunStatus(actor.workspaceId,runId,fresh.status,'CANCELLED');const task=await this.store.getTask(actor.workspaceId,run.task_id);if(['DRAFT','READY','IN_PROGRESS','AWAITING_EVIDENCE','VERIFYING','REVIEW_REQUIRED','FAILED'].includes(task.status))await this.store.updateTaskStatus(actor.workspaceId,task.id,task.status,'CANCELLED');await this.audit(actor,'verification.cancelled','run',runId);return true}

  async retry(actor:Actor,runId:string,input:{metadata?:Record<string,unknown>;artifactRef?:string}={}):Promise<any>{this.requireScope(actor,'verification:run');const previous=await this.store.getRun(actor.workspaceId,runId);return await this.startRun(actor,previous.task_id,{metadata:{...previous.metadata,...input.metadata},artifactRef:input.artifactRef??previous.artifact_ref})}
  async getRun(actor:Actor,runId:string):Promise<any>{this.requireScope(actor,'tasks:read');return await this.store.getRun(actor.workspaceId,runId)}
  async getVerification(actor:Actor,runId:string):Promise<any>{this.requireScope(actor,'tasks:read');const job=await this.store.getVerificationJob(actor.workspaceId,runId),results=await this.store.getResults(actor.workspaceId,runId);let verdict:any=null;try{verdict=await this.store.getVerdict(actor.workspaceId,runId)}catch(error:any){if(error?.code!=='VERDICT_NOT_READY')throw error}return{job,results,verdict}}
  async getVerdict(actor:Actor,runId:string):Promise<any>{this.requireScope(actor,'tasks:read');return await this.store.getVerdict(actor.workspaceId,runId)}
  async getFailedChecks(actor:Actor,runId:string):Promise<any[]>{this.requireScope(actor,'tasks:read');const results=await this.store.getResults(actor.workspaceId,runId),run=await this.store.getRun(actor.workspaceId,runId),contract=await this.store.getContract(actor.workspaceId,run.task_id,run.contract_version);return results.filter(item=>['FAILED','INCONCLUSIVE','ERROR'].includes(item.status)).map(item=>({...item,criterion:contract.acceptanceCriteria.find(c=>c.id===item.criterionId)}))}
  async getReceipt(actor:Actor,receiptId:string):Promise<any>{this.requireScope(actor,'receipts:read');return await this.store.getReceipt(actor.workspaceId,receiptId)}
  async getReceiptByRun(actor:Actor,runId:string):Promise<any>{this.requireScope(actor,'receipts:read');return await this.store.getReceiptByRun(actor.workspaceId,runId)}
  async dashboard(actor:Actor):Promise<any>{this.requireScope(actor,'tasks:read');return{counts:await this.store.dashboardCounts(actor.workspaceId),attention:await this.store.listAttention(actor.workspaceId),projects:await this.store.listProjects(actor.workspaceId,10,0),tasks:await this.store.listTasks(actor.workspaceId,{limit:20})}}
  async agentReliability(actor:Actor,agentId?:string):Promise<any>{this.requireScope(actor,'tasks:read');return{agentId:agentId??null,status:'INSUFFICIENT_SAMPLE',minimumSample:5,message:'MADEPROOF does not calculate reliability from fewer than five completed runs in the same domain.'}}

  async createRunner(actor:Actor,input:{name:string;version:string;capabilities:string[]}):Promise<{secret:string;runner:any}>{this.requireUser(actor);if(!/^0\.1\./.test(input.version))throw new MadeProofError('RUNNER_VERSION_INCOMPATIBLE','Runner protocol must be 0.1.x',422);const capabilities=[...new Set(input.capabilities.map(String))];if(!capabilities.length)throw new MadeProofError('VALIDATION_ERROR','Runner requires at least one capability',422);const secret=`mpr_${randomToken(32)}`,runner=await this.store.registerRunner({workspaceId:actor.workspaceId,name:input.name,credentialHash:hashToken(secret),version:input.version,capabilities});await this.audit(actor,'runner.created','runner',runner.id,undefined,{name:input.name,version:input.version,capabilities});return{secret,runner}}
  async listRunners(actor:Actor):Promise<any[]>{this.requireUser(actor);return await this.store.listRunners(actor.workspaceId)}
  async revokeRunner(actor:Actor,runnerId:string):Promise<boolean>{this.requireUser(actor);const revoked=await this.store.revokeRunner(actor.workspaceId,runnerId);if(revoked)await this.audit(actor,'runner.revoked','runner',runnerId);return revoked}
  async authenticateRunner(secret:string):Promise<RunnerActor>{const runner=await this.store.getRunnerByCredentialHash(hashToken(secret));if(!runner)throw new MadeProofError('RUNNER_AUTH_REQUIRED','Runner credential is invalid or revoked',401);return{id:runner.id,workspaceId:runner.workspace_id,version:runner.version,capabilities:Array.isArray(runner.capabilities)?runner.capabilities:[]}}
  async runnerHeartbeat(runner:RunnerActor,version:string,capabilities:string[]):Promise<void>{if(version!==runner.version||!/^0\.1\./.test(version))throw new MadeProofError('RUNNER_VERSION_INCOMPATIBLE','Runner protocol version does not match registration',409);const declared=[...capabilities].sort(),registered=[...runner.capabilities].sort();if(JSON.stringify(declared)!==JSON.stringify(registered))throw new MadeProofError('RUNNER_CAPABILITY_MISMATCH','Runner capabilities do not match registration',409);await this.store.heartbeatRunner(runner.workspaceId,runner.id,version,capabilities)}
  async runnerPoll(runner:RunnerActor,version:string,capabilities:string[]):Promise<any|null>{await this.runnerHeartbeat(runner,version,capabilities);const leaseToken=randomToken(32),job=await this.store.claimRunnerJob({workspaceId:runner.workspaceId,runnerId:runner.id,capabilities:runner.capabilities,leaseTokenHash:hashToken(leaseToken),leaseSeconds:30});return job?{...job,leaseToken}:null}
  async runnerStart(runner:RunnerActor,jobId:string,leaseToken:string):Promise<any>{return await this.store.markRunnerJobRunning({workspaceId:runner.workspaceId,runnerId:runner.id,jobId,leaseTokenHash:hashToken(leaseToken),leaseSeconds:30})}
  async runnerComplete(runner:RunnerActor,jobId:string,leaseToken:string,result:any):Promise<any>{return await this.store.completeRunnerJob({workspaceId:runner.workspaceId,runnerId:runner.id,jobId,leaseTokenHash:hashToken(leaseToken),result})}
  async runnerFail(runner:RunnerActor,jobId:string,leaseToken:string,input:{retryable?:boolean;error:any}):Promise<any>{return await this.store.failRunnerJob({workspaceId:runner.workspaceId,runnerId:runner.id,jobId,leaseTokenHash:hashToken(leaseToken),retryable:Boolean(input.retryable),error:input.error??{code:'RUNNER_FAILED',message:'Runner failed'}})}

  async idempotent<T>(actor:Actor,key:string|undefined,route:string,input:unknown,operation:()=>Promise<{status:number;body:T}>):Promise<{status:number;body:T;replayed:boolean}>{if(!key)return{...(await operation()),replayed:false};if(key.length>200)throw new MadeProofError('IDEMPOTENCY_KEY_INVALID','Idempotency-Key is too long',422);const requestHash=sha256(canonicalJson(input)),existing=await this.store.getIdempotency(actor.workspaceId,key,route);if(existing){if(existing.request_hash!==requestHash)throw new MadeProofError('IDEMPOTENCY_CONFLICT','Idempotency-Key was already used with a different request body',409);return{status:existing.response_status,body:existing.response as T,replayed:true}}const value=await operation();await this.store.saveIdempotency({workspaceId:actor.workspaceId,key,route,requestHash,responseStatus:value.status,response:value.body});return{...value,replayed:false}}

  private requireScope(actor:Actor,scope:string):void{if(actor.scopes.includes('*'))return;const readAlias=scope.endsWith(':read')&&actor.scopes.includes('tasks:read');if(!actor.scopes.includes(scope)&&!readAlias)throw new MadeProofError('INSUFFICIENT_SCOPE',`This operation requires scope ${scope}`,403)}
  private requireUser(actor:Actor):void{if(actor.type!=='USER')throw new MadeProofError('USER_SESSION_REQUIRED','This operation requires an interactive user session',403)}
  private async audit(actor:Actor,action:string,resourceType:string,resourceId:string,previous?:unknown,resulting?:unknown):Promise<void>{await this.store.appendAudit({workspaceId:actor.workspaceId,actorId:actor.id,actorType:actor.type,action,resourceType,resourceId,previous,resulting})}
}

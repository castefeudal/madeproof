import http from 'node:http';
import path from 'node:path';
import url from 'node:url';
import { loadConfig, type RuntimeConfig } from '../../../packages/config/src/runtime.js';
import { SqliteDistributedStore } from '../../../packages/db/src/sqlite-distributed-store.js';
import { PostgresStore } from '../../../packages/db/src/postgres-store.js';
import type { MadeProofStore } from '../../../packages/db/src/store.js';
import { EvidenceService } from '../../../packages/evidence/src/evidence-service.js';
import { MadeProofService, type Actor } from '../../../packages/core/src/service.js';
import { securityHeaders } from '../../../packages/security/src/headers.js';
import { RateLimiter } from '../../../packages/security/src/rate-limit.js';
import { canonicalJson, sha256 } from '../../../packages/shared/src/canonical.js';
import { asMadeProofError, MadeProofError } from '../../../packages/shared/src/errors.js';
import { newId } from '../../../packages/shared/src/ids.js';
import { requiredString } from '../../../packages/shared/src/validation.js';
import { parseCookies, readJson, sendJson, sendText, serveStatic } from './http-utils.js';
import { openApiDocument } from './openapi.js';
import { handleMcpHttp } from '../../mcp/src/protocol.js';

export interface Application {
  server: any;
  service: MadeProofService;
  config: RuntimeConfig;
  start(): Promise<{ url: string; port: number }>;
  close(): Promise<void>;
}

function setCommonHeaders(response:any,config:RuntimeConfig,requestId:string):void{response.setHeader('X-Request-Id',requestId);for(const[key,value]of Object.entries(securityHeaders(config.env==='production')))response.setHeader(key,value)}
function scopeFor(method:string,pathname:string):string|undefined{if(pathname.includes('/receipts/')||pathname.endsWith('/receipt'))return'receipts:read';if(pathname.includes('/verify')||pathname.includes('/retry')||pathname.includes('/cancel'))return'verification:run';if(pathname.includes('/evidence')&&method==='POST')return'evidence:write';if(pathname.startsWith('/api/v1/projects'))return method==='GET'?'projects:read':'projects:write';if(pathname==='/api/v1/dashboard'||pathname==='/api/v1/attention'||pathname==='/api/v1/agent-reliability')return'tasks:read';if(pathname.startsWith('/api/v1/tasks')||pathname.startsWith('/api/v1/runs'))return method==='GET'?'tasks:read':'tasks:write';return undefined}

async function authenticate(service:MadeProofService,request:any,requiredScope?:string):Promise<{actor:Actor;session?:any;sessionToken?:string}>{const authorization=String(request.headers.authorization??'');if(authorization.startsWith('Bearer '))return{actor:await service.authenticateApiKey(authorization.slice(7),requiredScope)};const sessionToken=parseCookies(request.headers.cookie).mp_session;if(!sessionToken)throw new MadeProofError('AUTH_REQUIRED','Authentication is required',401);const session=await service.store.getSession((await import('../../../packages/security/src/crypto.js')).hashToken(sessionToken));if(!session)throw new MadeProofError('AUTH_REQUIRED','Session is invalid or expired',401);return{actor:await service.authenticateSession(sessionToken),session,sessionToken}}
function enforceCsrf(request:any,auth:{session?:any}):void{if(!auth.session||['GET','HEAD','OPTIONS'].includes(request.method??'GET'))return;if(request.headers['x-csrf-token']!==auth.session.csrf_token)throw new MadeProofError('CSRF_REJECTED','CSRF token is missing or invalid',403)}
async function asyncIdempotent<T>(service:MadeProofService,actor:Actor,key:string|undefined,route:string,body:unknown,operation:()=>Promise<{status:number;body:T}>):Promise<{status:number;body:T;replayed:boolean}>{if(!key)return{...(await operation()),replayed:false};if(key.length>200)throw new MadeProofError('IDEMPOTENCY_KEY_INVALID','Idempotency-Key is too long',422);const requestHash=sha256(canonicalJson(body)),existing=await service.store.getIdempotency(actor.workspaceId,key,route);if(existing){if(existing.request_hash!==requestHash)throw new MadeProofError('IDEMPOTENCY_CONFLICT','Idempotency-Key was already used with a different request body',409);return{status:existing.response_status,body:existing.response as T,replayed:true}}const value=await operation();await service.store.saveIdempotency({workspaceId:actor.workspaceId,key,route,requestHash,responseStatus:value.status,response:value.body});return{...value,replayed:false}}

export function createApplication(overrides:Partial<RuntimeConfig>={}):Application{
  const config=loadConfig(overrides);
  const store:MadeProofStore=config.databaseKind==='postgres'?new PostgresStore(config.databaseUrl!):new SqliteDistributedStore(config.dataDir);
  const evidenceService=new EvidenceService(config.dataDir);
  const projectRoot=path.resolve(process.env.MADEPROOF_PROJECT_ROOT??process.cwd());
  const service=new MadeProofService(store,evidenceService,config,projectRoot);
  const authLimiter=new RateLimiter(10,60_000),apiLimiter=new RateLimiter(240,60_000);
  const moduleDir=path.dirname(url.fileURLToPath(import.meta.url)),webRoot=path.resolve(moduleDir,'../../web/public'),demoRoot=path.resolve(moduleDir,'../../../examples/demo-target/public');

  const server=http.createServer(async(request:any,response:any)=>{
    const requestId=newId('req');setCommonHeaders(response,config,requestId);const parsedUrl=new URL(request.url??'/',config.publicBaseUrl),pathname=parsedUrl.pathname,method=request.method??'GET',ip=request.socket?.remoteAddress??'unknown';
    try{
      if(method==='OPTIONS'){response.writeHead(204,{Allow:'GET,POST,DELETE,OPTIONS'});response.end();return}
      const rate=(pathname==='/api/v1/auth/login'?authLimiter:apiLimiter).consume(`${ip}:${pathname.split('/').slice(0,4).join('/')}`);response.setHeader('RateLimit-Remaining',String(rate.remaining));response.setHeader('RateLimit-Reset',String(Math.ceil(rate.resetAt/1000)));if(!rate.allowed)throw new MadeProofError('RATE_LIMITED','Too many requests; retry after the rate-limit window resets',429);
      if(pathname==='/health/live')return sendJson(response,200,{status:'live',version:'0.1.0',requestId});
      if(pathname==='/health/ready'){const ready=await store.ping();return sendJson(response,ready?200:503,{status:ready?'ready':'not-ready',database:config.databaseKind,requestId})}
      if(pathname==='/api/v1/openapi.json')return sendJson(response,200,openApiDocument);
      if(pathname.startsWith('/demo-target')){const relative=pathname.replace('/demo-target','')||'/';if(serveStatic(response,demoRoot,relative))return;throw new MadeProofError('NOT_FOUND','Demo target asset not found',404)}
      if(pathname==='/api/v1/auth/login'&&method==='POST'){const body=await readJson(request),login=await service.login(requiredString(body.email,'email',3),requiredString(body.password,'password',1)),cookie=`mp_session=${encodeURIComponent(login.token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=28800${config.env==='production'?'; Secure':''}`;return sendJson(response,200,{user:login.user,workspace:login.workspace,csrfToken:login.csrfToken,expiresAt:login.expiresAt},{'Set-Cookie':cookie,'Cache-Control':'no-store'})}

      if(pathname.startsWith('/api/v1/runner/')){
        const authorization=String(request.headers.authorization??'');if(!authorization.startsWith('Runner '))throw new MadeProofError('RUNNER_AUTH_REQUIRED','Runner authentication is required',401);const runner=await service.authenticateRunner(authorization.slice(7));
        if(pathname==='/api/v1/runner/heartbeat'&&method==='POST'){const body=await readJson(request);await service.runnerHeartbeat(runner,String(body.version??''),Array.isArray(body.capabilities)?body.capabilities.map(String):[]);return sendJson(response,200,{ok:true})}
        if(pathname==='/api/v1/runner/poll'&&method==='POST'){const body=await readJson(request),job=await service.runnerPoll(runner,String(body.version??''),Array.isArray(body.capabilities)?body.capabilities.map(String):[]);if(!job){response.writeHead(204);response.end();return}return sendJson(response,200,{job})}
        const start=pathname.match(/^\/api\/v1\/runner\/jobs\/([^/]+)\/start$/);if(start&&method==='POST'){const body=await readJson(request);return sendJson(response,200,await service.runnerStart(runner,start[1]!,requiredString(body.leaseToken,'leaseToken')))}
        const complete=pathname.match(/^\/api\/v1\/runner\/jobs\/([^/]+)\/complete$/);if(complete&&method==='POST'){const body=await readJson(request);return sendJson(response,200,await service.runnerComplete(runner,complete[1]!,requiredString(body.leaseToken,'leaseToken'),body.result))}
        const fail=pathname.match(/^\/api\/v1\/runner\/jobs\/([^/]+)\/fail$/);if(fail&&method==='POST'){const body=await readJson(request);return sendJson(response,200,await service.runnerFail(runner,fail[1]!,requiredString(body.leaseToken,'leaseToken'),{retryable:Boolean(body.retryable),error:body.error}))}
        throw new MadeProofError('NOT_FOUND','Runner API route not found',404)
      }

      if(pathname==='/mcp'&&method==='POST'){const auth=await authenticate(service,request,'tasks:read');return await handleMcpHttp({request,response,service,actor:{...auth.actor,type:'MCP'},requestId,config})}

      if(pathname.startsWith('/api/v1/')){
        const auth=await authenticate(service,request,scopeFor(method,pathname));enforceCsrf(request,auth);const actor=auth.actor,idempotencyKey=typeof request.headers['idempotency-key']==='string'?request.headers['idempotency-key']:undefined;
        if(pathname==='/api/v1/auth/me'&&method==='GET')return sendJson(response,200,{actor,workspace:await service.store.getDefaultWorkspaceForUser(actor.id),csrfToken:auth.session?.csrf_token??null});
        if(pathname==='/api/v1/auth/logout'&&method==='POST'){if(auth.sessionToken)await service.logout(auth.sessionToken);return sendJson(response,200,{ok:true},{'Set-Cookie':'mp_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0'})}
        if(pathname==='/api/v1/dashboard'&&method==='GET')return sendJson(response,200,await service.dashboard(actor));
        if(pathname==='/api/v1/attention'&&method==='GET')return sendJson(response,200,{items:await service.store.listAttention(actor.workspaceId)});
        if(pathname==='/api/v1/agent-reliability'&&method==='GET')return sendJson(response,200,await service.agentReliability(actor,parsedUrl.searchParams.get('agentId')??undefined));

        if(pathname==='/api/v1/projects'&&method==='GET')return sendJson(response,200,{items:await service.listProjects(actor,Number(parsedUrl.searchParams.get('limit')??50),Number(parsedUrl.searchParams.get('offset')??0))});
        if(pathname==='/api/v1/projects'&&method==='POST'){const body=await readJson(request),outcome=await asyncIdempotent(service,actor,idempotencyKey,pathname,body,async()=>({status:201,body:await service.createProject(actor,{name:requiredString(body.name,'name',2),projectType:body.projectType,repositoryUrl:body.repositoryUrl})}));return sendJson(response,outcome.status,outcome.body,outcome.replayed?{'Idempotency-Replayed':'true'}:{})}
        const projectMatch=pathname.match(/^\/api\/v1\/projects\/([^/]+)$/);if(projectMatch&&method==='GET')return sendJson(response,200,await service.getProject(actor,projectMatch[1]!));

        if(pathname==='/api/v1/tasks'&&method==='GET')return sendJson(response,200,{items:await service.listTasks(actor,{status:parsedUrl.searchParams.get('status')??undefined,projectId:parsedUrl.searchParams.get('projectId')??undefined,limit:Number(parsedUrl.searchParams.get('limit')??50),offset:Number(parsedUrl.searchParams.get('offset')??0)})});
        if(pathname==='/api/v1/tasks'&&method==='POST'){const body=await readJson(request),outcome=await asyncIdempotent(service,actor,idempotencyKey,pathname,body,async()=>({status:201,body:await service.createTask(actor,{projectId:requiredString(body.projectId,'projectId'),title:requiredString(body.title,'title',2),intent:requiredString(body.intent,'intent',5),template:body.template})}));return sendJson(response,outcome.status,outcome.body,outcome.replayed?{'Idempotency-Replayed':'true'}:{})}
        const taskMatch=pathname.match(/^\/api\/v1\/tasks\/([^/]+)$/);if(taskMatch&&method==='GET')return sendJson(response,200,await service.getTask(actor,taskMatch[1]!));
        const contractsMatch=pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/contracts$/);if(contractsMatch&&method==='GET')return sendJson(response,200,{items:await service.listContracts(actor,contractsMatch[1]!)});if(contractsMatch&&method==='POST'){const body=await readJson(request),outcome=await asyncIdempotent(service,actor,idempotencyKey,pathname,body,async()=>({status:201,body:body.acceptanceCriteria?await service.updateContract(actor,contractsMatch[1]!,body):await service.generateContract(actor,contractsMatch[1]!)}));return sendJson(response,outcome.status,outcome.body,outcome.replayed?{'Idempotency-Replayed':'true'}:{})}
        const taskRunsMatch=pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/runs$/);if(taskRunsMatch&&method==='POST'){const body=await readJson(request),outcome=await asyncIdempotent(service,actor,idempotencyKey,pathname,body,async()=>({status:201,body:await service.startRun(actor,taskRunsMatch[1]!,body)}));return sendJson(response,outcome.status,outcome.body,outcome.replayed?{'Idempotency-Replayed':'true'}:{})}

        const runMatch=pathname.match(/^\/api\/v1\/runs\/([^/]+)$/);if(runMatch&&method==='GET')return sendJson(response,200,await service.getRun(actor,runMatch[1]!));
        const evidenceMatch=pathname.match(/^\/api\/v1\/runs\/([^/]+)\/evidence$/);if(evidenceMatch&&method==='GET')return sendJson(response,200,{items:await service.store.listEvidence(actor.workspaceId,evidenceMatch[1]!)});if(evidenceMatch&&method==='POST'){const body=await readJson(request),outcome=await asyncIdempotent(service,actor,idempotencyKey,pathname,body,async()=>({status:201,body:await service.addEvidence(actor,evidenceMatch[1]!,{criterionId:body.criterionId,type:requiredString(body.type,'type'),value:body.value,source:body.source,mimeType:body.mimeType})}));return sendJson(response,outcome.status,outcome.body,outcome.replayed?{'Idempotency-Replayed':'true'}:{})}
        const verifyMatch=pathname.match(/^\/api\/v1\/runs\/([^/]+)\/verify$/);if(verifyMatch&&method==='POST'){const body=await readJson(request),outcome=await asyncIdempotent(service,actor,idempotencyKey,pathname,body,async()=>({status:202,body:await service.verify(actor,verifyMatch[1]!)}));return sendJson(response,outcome.status,outcome.body,outcome.replayed?{'Idempotency-Replayed':'true'}:{})}
        const cancelMatch=pathname.match(/^\/api\/v1\/runs\/([^/]+)\/cancel$/);if(cancelMatch&&method==='POST')return sendJson(response,200,{cancelled:await service.cancelVerification(actor,cancelMatch[1]!)});
        const verificationMatch=pathname.match(/^\/api\/v1\/runs\/([^/]+)\/verification$/);if(verificationMatch&&method==='GET')return sendJson(response,200,await service.getVerification(actor,verificationMatch[1]!));
        const verdictMatch=pathname.match(/^\/api\/v1\/runs\/([^/]+)\/verdict$/);if(verdictMatch&&method==='GET')return sendJson(response,200,await service.getVerdict(actor,verdictMatch[1]!));
        const failedMatch=pathname.match(/^\/api\/v1\/runs\/([^/]+)\/failed-checks$/);if(failedMatch&&method==='GET')return sendJson(response,200,{items:await service.getFailedChecks(actor,failedMatch[1]!)});
        const retryMatch=pathname.match(/^\/api\/v1\/runs\/([^/]+)\/retry$/);if(retryMatch&&method==='POST'){const body=await readJson(request),outcome=await asyncIdempotent(service,actor,idempotencyKey,pathname,body,async()=>({status:201,body:await service.retry(actor,retryMatch[1]!,body)}));return sendJson(response,outcome.status,outcome.body,outcome.replayed?{'Idempotency-Replayed':'true'}:{})}

        const receiptJsonMatch=pathname.match(/^\/api\/v1\/receipts\/([^/.]+)\.json$/);if(receiptJsonMatch&&method==='GET')return sendJson(response,200,await service.getReceipt(actor,receiptJsonMatch[1]!));const receiptMatch=pathname.match(/^\/api\/v1\/receipts\/([^/]+)$/);if(receiptMatch&&method==='GET')return sendJson(response,200,await service.getReceipt(actor,receiptMatch[1]!));const runReceiptMatch=pathname.match(/^\/api\/v1\/runs\/([^/]+)\/receipt$/);if(runReceiptMatch&&method==='GET')return sendJson(response,200,await service.getReceiptByRun(actor,runReceiptMatch[1]!));

        if(pathname==='/api/v1/api-keys'&&method==='GET')return sendJson(response,200,{items:await service.listApiKeys(actor)});if(pathname==='/api/v1/api-keys'&&method==='POST'){const body=await readJson(request);return sendJson(response,201,await service.createApiKey(actor,{name:requiredString(body.name,'name',2),scopes:Array.isArray(body.scopes)?body.scopes.map(String):[],expiresAt:body.expiresAt}))}const apiKeyMatch=pathname.match(/^\/api\/v1\/api-keys\/([^/]+)$/);if(apiKeyMatch&&method==='DELETE'){const revoked=await service.revokeApiKey(actor,apiKeyMatch[1]!);return sendJson(response,revoked?200:404,{revoked})}

        if(pathname==='/api/v1/runners'&&method==='GET')return sendJson(response,200,{items:await service.listRunners(actor)});if(pathname==='/api/v1/runners'&&method==='POST'){const body=await readJson(request);return sendJson(response,201,await service.createRunner(actor,{name:requiredString(body.name,'name',2),version:requiredString(body.version,'version'),capabilities:Array.isArray(body.capabilities)?body.capabilities.map(String):[]}))}const runnerMatch=pathname.match(/^\/api\/v1\/runners\/([^/]+)$/);if(runnerMatch&&method==='DELETE'){const revoked=await service.revokeRunner(actor,runnerMatch[1]!);return sendJson(response,revoked?200:404,{revoked})}
        throw new MadeProofError('NOT_FOUND','API route not found',404)
      }
      if(serveStatic(response,webRoot,pathname))return;sendText(response,404,'Not found');
    }catch(error){const safe=asMadeProofError(error);if(safe.status>=500)console.error(JSON.stringify({level:'error',requestId,code:safe.code,message:safe.message}));sendJson(response,safe.status,{error:{code:safe.code,message:safe.status>=500?'The request could not be completed due to an internal error.':safe.message,requestId,details:safe.status<500?safe.details:undefined}},safe.status===429?{'Retry-After':'60'}:{})}
  });

  return{server,service,config,async start(){await service.initialize();await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.host,()=>resolve())});const address=server.address(),port=typeof address==='object'&&address?address.port:config.port;config.port=port;config.publicBaseUrl=`http://${config.host}:${port}`;return{url:config.publicBaseUrl,port}},async close(){await new Promise<void>(resolve=>server.close(()=>resolve()));await store.close()}}
}

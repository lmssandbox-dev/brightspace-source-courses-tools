'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createSourceDeploymentClient}=require('../src/replication/client');
const {createDeploymentJobs,parseDeploymentCsv}=require('../src/replication/jobs');
function client(options={}){const calls=[];return {calls,api:createSourceDeploymentClient({baseUrl:'https://tenant.example',lpVersion:options.version||'1.53',oauth:{getAccessToken:async()=>{if(options.authFail)throw Error('SECRET');return 'SECRET';}},api:{read:async url=>{calls.push({url});if(url.includes('reofferedCourses'))return {ReofferedCourses:[]};return {Identifier:url.split('/').at(-1),Name:'Course',Code:'C',IsActive:options.active??false};}},http:async config=>{calls.push(config);if(options.error)throw options.error;return options.response||{status:200,data:123};}})};}
test('deployment CSV groups repeated sources, preserves IDs and rejects conflicting replica mappings',()=>{
 const rows=parseDeploymentCsv('SourceOrgUnitId,SourceOrgUnitCode,ReplicaOrgUnitId,ReplicaOrgUnitCode\n10,,20,\n10,,21,\n10,,20,\n11,,20,\n30,,30,\n,,,\n40,,50,\n50,,60,');
 assert.deepEqual(rows.map(r=>r.status),['invalid','pending','duplicate','invalid','invalid','ignored','invalid','pending']);
 assert.equal(rows[1].sourceId,'10');assert.equal(rows[1].targetId,'21');
 for(const text of ['id,target\n1,2','SourceOrgUnitId,SourceOrgUnitCode,ReplicaOrgUnitId,ReplicaOrgUnitCode\n','SourceOrgUnitId,SourceOrgUnitCode,ReplicaOrgUnitId,ReplicaOrgUnitCode\n"bad','x'.repeat(16385)])assert.throws(()=>parseDeploymentCsv(text));
});
test('source-specific validation, inactive targets and API version requirements',async()=>{
 const s=client();await s.api.source('10');assert.match(s.calls[0].url,/sourceCourses\/10\/reofferedCourses$/);await s.api.target('20');
 assert.equal((await client({active:true}).api.target('20')).isActive,true);await assert.rejects(()=>client({version:'1.49'}).api.source('10'));
});
test('deployment sends one restricted POST with target array after persistence hook',async()=>{
 const s=client();let persisted=false;const r=await s.api.deploy('10',['20','21','20'],async()=>{persisted=true;});
 assert.equal(persisted,true);assert.equal(r.status,'submitted');assert.equal(r.deploymentId,'123');assert.equal(r.targets.length,2);
 assert.equal(s.calls.length,1);assert.equal(s.calls[0].method,'POST');assert.match(s.calls[0].url,/sourceCourses\/10\/deploy$/);
 assert.deepEqual(s.calls[0].data,{TargetCourseOfferingIds:[20,21]});assert.equal(s.calls[0].maxRedirects,0);
 await assert.rejects(()=>s.api.deploy('10',['10']));assert.equal(s.calls.length,1);
});
test('207 response retains deployment ID and per-target failures without leaking raw text',async()=>{
 const s=client({response:{status:207,data:{SourceCourseDeployId:99,FailedOrgUnitsIds:['21'],FailedOrgUnitsWithInfoStr:'SECRET'}}});
 const r=await s.api.deploy('10',['20','21']);assert.equal(r.status,'submittedWithErrors');assert.deepEqual(r.targets.map(t=>t.status),['submitted','failed']);assert.equal(JSON.stringify(r).includes('SECRET'),false);
});
test('lost/malformed responses are uncertain; explicit rejection is failed; no POST is retried',async()=>{
 for(const options of [{error:Error('SECRET')},{response:{status:200,data:{unexpected:true}}},{error:{response:{status:403}}}]){
  const s=client(options),r=await s.api.deploy('10',['20']);assert.equal(r.status,options.error?.response?'failed':'uncertain');assert.equal(s.calls.length,1);assert.equal(JSON.stringify(r).includes('SECRET'),false);
 }
 const s=client({authFail:true}),r=await s.api.deploy('10',['20']);assert.equal(r.writeAttempted,false);assert.equal(s.calls.length,0);
});
test('lease/persistence failure prevents deployment POST',async()=>{
 const s=client();await assert.rejects(()=>s.api.deploy('10',['20'],async()=>{throw Error('storage unavailable');}));assert.equal(s.calls.length,0);
});
function workflow({badTarget=false,result='submitted',enabled=true}={}){
 const calls=[];const engine=createDeploymentJobs({enabled:()=>enabled,client:{source:async id=>{calls.push('source');return {orgUnitId:id,name:'Source'};},target:async id=>{calls.push('target');if(badTarget)throw Error();return {orgUnitId:id,name:'Replica',isActive:false};},setActive:async(id,active,before)=>{await before();calls.push(active?'activate':'deactivate');return {status:'updated',verifiedActive:active,writeAttempted:true};},deploy:async(source,targets,before)=>{await before();calls.push({source,targets});return {status:result,writeAttempted:true};}}});
 const job={kind:'sourceDeployment',rows:parseDeploymentCsv('SourceOrgUnitId,SourceOrgUnitCode,ReplicaOrgUnitId,ReplicaOrgUnitCode\n10,,20,\n10,,21,\n11,,22,'),tasks:[]};
 return {engine,job,calls};
}
test('deployment planner is read-only; valid mappings group replicas by source',async()=>{
 const s=workflow();await s.engine.plan(s.job,async()=>{});assert.equal(s.job.status,'ready');assert.equal(s.job.tasks.length,2);assert.equal(s.job.tasks[0].targets.length,2);assert.ok(s.calls.every(c=>typeof c==='string'));
 await s.engine.execute(s.job,async()=>{},async()=>{});assert.equal(s.job.status,'activated');assert.equal(s.calls.filter(c=>typeof c==='object').length,2);
});
test('invalid targets block preview and revalidation or missing scope prevent all POSTs',async()=>{
 const s=workflow({badTarget:true});await s.engine.plan(s.job,async()=>{});assert.equal(s.job.status,'failed');
 for(const option of [{badTarget:true},{enabled:false}]){
  const good=workflow();await good.engine.plan(good.job,async()=>{});const bad=workflow(option);await bad.engine.execute(good.job,async()=>{},async()=>{});assert.equal(good.job.status,'failed');assert.ok(bad.calls.every(c=>typeof c==='string'));
 }
});
test('uncertain source-group outcome does not block unrelated batches',async()=>{
 const s=workflow({result:'uncertain'});await s.engine.plan(s.job,async()=>{});await s.engine.execute(s.job,async()=>{},async()=>{});
 assert.equal(s.job.status,'outcomeUnknown');assert.equal(s.job.tasks[1].result.status,'uncertain');assert.equal(s.calls.filter(c=>typeof c==='object').length,2);
});

const {courseStatusPayload}=require('../src/replication/client');
const course=()=>({Identifier:'20',Name:'Replica',Code:'CODE',IsActive:true,StartDate:null,EndDate:'2027-01-01T00:00:00Z',Description:{Html:'<p>Keep</p>',Text:'Keep'},CanSelfRegister:false,LocaleId:null,ForceLocale:false,ShowAddressBook:true});
test('course active-state writer preserves settings, reconciles lost PUT response and never repeats PUT',async()=>{
 for(const version of ['1.53','1.54']){
  let row=course(),puts=0,hooks=0;
  const api=createSourceDeploymentClient({baseUrl:'https://tenant.example',lpVersion:version,oauth:{getAccessToken:async()=> 'token'},api:{read:async()=>structuredClone(row)},http:async config=>{
   puts++;assert.equal(config.method,'PUT');assert.equal(config.data.Name,row.Name);assert.deepEqual(config.data.Description,{Content:'<p>Keep</p>',Type:'Html'});
   assert.equal('LocaleId' in config.data,version==='1.54');row.IsActive=config.data.IsActive;throw Error('response lost');
  }});
  const result=await api.setActive('20',false,async()=>{hooks++;});assert.equal(result.status,'updated');assert.equal(result.verifiedActive,false);assert.equal(hooks,1);assert.equal(puts,1);
  assert.equal((await api.setActive('20',false)).status,'unchanged');assert.equal(puts,1);
  assert.equal((await api.setActive('20',true)).status,'updated');assert.equal(puts,2);
 }
});
test('incomplete settings and storage failure prevent course PUT; changed settings fail verification',async()=>{
 for(const mode of ['missing','storage','changed','unverified']){
  let row=course(),puts=0,reads=0;if(mode==='missing')delete row.Code;
  const api=createSourceDeploymentClient({baseUrl:'https://tenant.example',lpVersion:'1.53',oauth:{getAccessToken:async()=> 'token'},api:{read:async()=>{if(++reads>1&&mode==='unverified')throw Error();return structuredClone(row);}},http:async()=>{puts++;row.IsActive=false;row.Name='Unexpected change';return {status:200};}});
  const run=()=>api.setActive('20',false,async()=>{if(mode==='storage')throw Error('lost lease');});
  if(mode==='storage')await assert.rejects(run);else assert.equal((await run()).status,'failed');
  assert.equal(puts,['missing','storage'].includes(mode)?0:1);
 }
 assert.throws(()=>courseStatusPayload({...course(),ShowAddressBook:undefined},false,'1.54'));
});
test('prepare verifies only the current batch inactive before deploy and automatically reactivates accepted replicas',async()=>{
 const s=workflow();await s.engine.plan(s.job,async()=>{});assert.equal(s.calls.includes('deactivate'),false);
 await s.engine.execute(s.job,async()=>{},async()=>{});
 assert.equal(s.calls.filter(c=>c==='deactivate').length,3);assert.equal(s.calls.includes('activate'),true);
 const firstPost=s.calls.findIndex(c=>typeof c==='object');assert.equal(s.calls.slice(0,firstPost).filter(c=>c==='deactivate').length,2);
 const submissions=structuredClone(s.job.tasks.map(t=>t.result));
 await s.engine.activate(s.job,async()=>{},async()=>{});assert.equal(s.job.status,'activated');assert.equal(s.calls.filter(c=>c==='activate').length,3);assert.deepEqual(s.job.tasks.map(t=>t.result),submissions);
});
test('failed deactivation blocks every deploy',async()=>{
 let posts=0;const engine=createDeploymentJobs({enabled:()=>true,client:{source:async()=>{},target:async()=>({isActive:true}),setActive:async()=>({status:'failed',verifiedActive:true}),deploy:async()=>{posts++;}}});
 const job={tasks:[{sourceId:'10',targets:[{orgUnitId:'20'}]}]};await engine.execute(job,async()=>{},async()=>{});assert.equal(posts,0);assert.equal(job.status,'failed');
});
test('activation interruption retains deployment IDs and allows status reconciliation',()=>{
 const {interruptJob}=require('../src/shared/jobs');
 const job={kind:'sourceDeployment',operation:'activate',tasks:[{result:{status:'submitted',deploymentId:'123'},targets:[{activation:{status:'running',writeAttempted:true}}]}]};
 interruptJob(job);assert.equal(job.status,'activationWithErrors');assert.equal(job.tasks[0].result.deploymentId,'123');assert.equal(job.tasks[0].targets[0].activation.status,'failed');
});

test('source validation succeeds when only optional name lookup is forbidden',async()=>{
 const calls=[];const c=createSourceDeploymentClient({baseUrl:'https://tenant.example',lpVersion:'1.53',api:{read:async url=>{calls.push(url);if(url.includes('reofferedCourses'))return {ReofferedCourses:[]};throw {status:403,message:'SECRET'};}}});
 const source=await c.source('9532');assert.equal(source.name,'Source Course 9532');assert.equal(source.orgUnitId,'9532');assert.match(source.warning,/HTTP 403/);assert.equal(calls.length,2);
 const engine=createDeploymentJobs({enabled:()=>true,client:{source:c.source,target:async orgUnitId=>({orgUnitId,name:'Replica',isActive:true})}});
 const job={rows:parseDeploymentCsv('SourceOrgUnitId,SourceOrgUnitCode,ReplicaOrgUnitId,ReplicaOrgUnitCode\n9532,,8062,\n9532,,8063,'),tasks:[]};
 await engine.plan(job,async()=>{});assert.equal(job.status,'ready');assert.equal(job.tasks[0].targets.length,2);assert.match(job.rows[0].message,/display name/);
});
test('source validation errors cannot be bypassed by optional metadata fallback',async()=>{
 for(const status of [401,403,404,429,500]){
  let calls=0;const c=createSourceDeploymentClient({baseUrl:'https://tenant.example',lpVersion:'1.53',api:{read:async()=>{calls++;throw {status,message:'SECRET'};}}});
  await assert.rejects(()=>c.source('9532'),e=>e.stage==='source'&&e.httpStatus===status&&!e.message.includes('SECRET'));assert.equal(calls,status===429?3:1);
 }
 const c=createSourceDeploymentClient({baseUrl:'https://tenant.example',lpVersion:'1.53',api:{read:async()=>({})}});
 await assert.rejects(()=>c.source('9532'),e=>e.reason==='INVALID_RESPONSE');
});
test('replica validation reports the failing ID, version and status without raw errors',async()=>{
 const c=createSourceDeploymentClient({baseUrl:'https://tenant.example',lpVersion:'1.53',api:{read:async()=>{throw {status:404,message:'SECRET'};}}});
 const engine=createDeploymentJobs({enabled:()=>true,client:{source:async()=>({name:'Source'}),target:c.target}});
 const job={rows:parseDeploymentCsv('SourceOrgUnitId,SourceOrgUnitCode,ReplicaOrgUnitId,ReplicaOrgUnitCode\n9532,,8062,'),tasks:[]};
 await engine.plan(job,async()=>{});assert.equal(job.status,'failed');assert.match(job.rows[0].message,/Replica.*8062.*LP 1.53, HTTP 404/);assert.doesNotMatch(job.rows[0].message,/SECRET/);
});

test('10,000 mappings are accepted and split into bounded deployment batches',async()=>{
 const csv='SourceOrgUnitId,SourceOrgUnitCode,ReplicaOrgUnitId,ReplicaOrgUnitCode\n'+Array.from({length:10000},(_,i)=>`1,,${i+2},`).join('\n');
 const rows=parseDeploymentCsv(csv);assert.equal(rows.length,10000);
 assert.throws(()=>parseDeploymentCsv(csv+'\n1,10002'),/10,000/);
 assert.throws(()=>parseDeploymentCsv(' '.repeat(5*1024*1024+1)),/5 MB/);
 const jobs=createDeploymentJobs({enabled:()=>true,client:{source:async()=>({name:'Source'}),target:async id=>({orgUnitId:id,name:'Replica'})}});
 const job={rows,tasks:[]};await jobs.plan(job,async()=>{});
 assert.equal(job.status,'ready');assert.equal(job.tasks.length,100);
 assert.ok(job.tasks.every(t=>t.targets.length===100));
 assert.equal(new Set(job.tasks.flatMap(t=>t.targets.map(r=>r.orgUnitId))).size,10000);
});

function batchScenario(outcomes,{preparationError,validationError}={}){
 const events=[],job={tasks:outcomes.map((_,i)=>({sourceId:String(i+1),targets:[{orgUnitId:String(i+101)}]}))};
 const engine=createDeploymentJobs({enabled:()=>true,client:{
 source:async id=>{if(validationError&&id==='1')throw validationError;},target:async()=>({isActive:false}),
 setActive:async(id,desired,before)=>{await before();events.push(`${desired?'activate':'prepare'}:${id}`);if(preparationError&&id==='101')return {status:'failed',error:preparationError};return {status:'updated',verifiedActive:desired};},
 deploy:async(id,targets,before)=>{await before();events.push(`deploy:${id}`);const outcome=outcomes[Number(id)-1];return {...outcome,targets:targets.map(orgUnitId=>({orgUnitId,status:outcome.status}))};}
 }});
 return {job,events,run:()=>engine.execute(job,async()=>{},async()=>{}),engine};
}
test('isolated rejection and uncertain outcome continue; batches prepare just in time',async()=>{
 const s=batchScenario([{status:'failed',error:{httpStatus:400}},{status:'uncertain',error:{httpStatus:null}},{status:'submitted'}]);await s.run();
 assert.deepEqual(s.events,['prepare:101','deploy:1','prepare:102','deploy:2','prepare:103','deploy:3','activate:103']);
 assert.equal(s.job.status,'outcomeUnknown');
});
test('isolated validation and preparation failures leave other batches available',async()=>{
 for(const options of [{validationError:{httpStatus:404}},{preparationError:{httpStatus:400}}]){
 const s=batchScenario([{status:'submitted'},{status:'submitted'}],options);await s.run();
 assert.equal(s.job.tasks[0].result.targets[0].status,'notAttempted');assert.equal(s.job.tasks[1].result.status,'submitted');assert.equal(s.job.status,'submittedWithErrors');
 }
});
test('authentication and repeated outages stop without preparing later replicas',async()=>{
 for(const status of [401,429]){
 const s=batchScenario([{status:'failed',error:{httpStatus:status}},{status:'submitted'}]);await s.run();
 assert.deepEqual(s.events,['prepare:101','deploy:1']);assert.equal(s.job.tasks[1].result.targets[0].status,'notAttempted');
 }
 const s=batchScenario([...Array.from({length:3},()=>({status:'uncertain',error:{httpStatus:503}})),{status:'submitted'}]);await s.run();
 assert.equal(s.events.includes('prepare:104'),false);assert.equal(s.job.tasks[3].result.status,'skipped');
});
test('429 respects Retry-After and retries only explicit rejection with renewed intent',async()=>{
 let calls=0,hooks=0;const waits=[];
 const c=createSourceDeploymentClient({baseUrl:'https://tenant.example',lpVersion:'1.53',oauth:{getAccessToken:async()=> 'token'},delay:async ms=>waits.push(ms),http:async()=>{if(++calls===1)throw {response:{status:429,headers:{'retry-after':'2'}}};return {status:200,data:123};}});
 assert.equal((await c.deploy('1',['101'],async()=>{hooks++;})).status,'submitted');assert.deepEqual(waits,[2000]);assert.equal(calls,2);assert.equal(hooks,2);
});
test('long Retry-After never retries early and storage failure during retry stops POST',async()=>{
 for(const long of [true,false]){
 let calls=0,hooks=0;const waits=[];
 const c=createSourceDeploymentClient({baseUrl:'https://tenant.example',lpVersion:'1.53',oauth:{getAccessToken:async()=> 'token'},delay:async ms=>waits.push(ms),http:async()=>{calls++;throw {response:{status:429,headers:{'retry-after':long?'120':'0'}}};}});
 const run=()=>c.deploy('1',['101'],async()=>{if(++hooks===2)throw Error('storage');});
 if(long){assert.equal((await run()).status,'failed');assert.deepEqual(waits,[]);}else await assert.rejects(run,/storage/);
 assert.equal(calls,1);
 }
});
test('activation excludes failed and not-attempted replicas',async()=>{
 const s=batchScenario([{status:'failed',error:{httpStatus:400}},{status:'submitted'}]);await s.run();s.events.length=0;
 await s.engine.activate(s.job,async()=>{},async()=>{});
 assert.deepEqual(s.events,[]);assert.equal(s.job.tasks[0].targets[0].activation,undefined);
});
test('results and CSV keep separate outcomes for batches sharing a source',()=>{
 const {createDeploymentView}=require('../src/replication/view');
 const job={_id:'j',status:'submittedWithErrors',rows:[{sourceId:'1',targetId:'101'},{sourceId:'1',targetId:'102'}],tasks:[{sourceId:'1',targets:[{orgUnitId:'101'}],result:{status:'submitted',deploymentId:'first'}},{sourceId:'1',targets:[{orgUnitId:'102'}],result:{status:'failed',error:{message:'Rejected'},targets:[{orgUnitId:'102',status:'failed'}]}}]};
 const view=createDeploymentView({enabled:()=>true});const html=view.render({},job,{button:()=>'',controls:()=>'',now:()=>0});
 assert.match(html,/Deployment Needs Attention/);assert.match(html,/Copy in Process/);assert.doesNotMatch(html,/Deployment Results/);
 const report=view.report(job).split('\r\n');assert.match(report[1],/first/);assert.doesNotMatch(report[2],/first/);assert.match(report[2],/Rejected/);
});

test('3,000 sources and 5,000 replicas continue after the first batch is rejected',async()=>{
 let submissions=0,prepared=0;
 const jobs=createDeploymentJobs({enabled:()=>true,client:{source:async()=>({name:'Source'}),target:async orgUnitId=>({orgUnitId,name:'Replica',isActive:false}),setActive:async()=>{prepared++;return {status:'unchanged',verifiedActive:false};},deploy:async(source,targets)=>{const status=++submissions===1?'failed':'submitted';return {status,error:status==='failed'?{httpStatus:400}:undefined,targets:targets.map(orgUnitId=>({orgUnitId,status}))};}}});
 const mappings=Array.from({length:5000},(_,i)=>`${i%3000+1},,${i+10001},`);
 const job={rows:parseDeploymentCsv('SourceOrgUnitId,SourceOrgUnitCode,ReplicaOrgUnitId,ReplicaOrgUnitCode\n'+mappings.join('\n')),tasks:[]};
 await jobs.plan(job,async()=>{});await jobs.execute(job,async()=>{},async()=>{});
 assert.equal(submissions,3000);assert.equal(prepared,9998);assert.equal(job.status,'submittedWithErrors');
 assert.equal(job.tasks.flatMap(t=>t.result.targets).filter(r=>r.status==='submitted').length,4998);
});

test('deployment diagnostics survive into UI and CSV without credentials or executable markup',async()=>{
 const token='private-access-token',credential='private-client-secret';
 const response={status:403,headers:{'X-Request-ID':'request-123','set-cookie':'session=hidden-cookie'},data:{Message:`Feature denied <script>alert(1)</script> ${token} ${credential}`,Errors:[{Message:'Check deployment configuration'}],client_secret:credential,access_token:token,unrelated:'hidden-body-field'}};
 const c=createSourceDeploymentClient({baseUrl:'https://tenant.example',lpVersion:'1.53',oauth:{getAccessToken:async()=>token},http:async()=>{throw {response,config:{headers:{Authorization:`Bearer ${token}`}}};}});
 const result=await c.deploy('1',['101']);
 assert.equal(result.error.httpStatus,403);assert.match(result.error.responseDetails,/Feature denied/);assert.match(result.error.requestId,/request-123/);
 const {createDeploymentView}=require('../src/replication/view');const view=createDeploymentView({enabled:()=>true});
 const job={_id:'j',status:'failed',rows:[{sourceId:'1',targetId:'101'}],tasks:[{sourceId:'1',targets:[{orgUnitId:'101'}],result}]};
 const html=view.render({},job,{button:()=>'',controls:()=>'',now:()=>0});const csv=view.report(job);
 assert.match(html,/Deployment Needs Attention/);assert.doesNotMatch(html,/<script>alert/);assert.match(csv,/403/);assert.match(csv,/Feature denied/);
 assert.match(csv,/Deployment HTTP status/);assert.match(csv,/Brightspace error details/);assert.match(csv,/request-123/);
 for(const output of [JSON.stringify(result),html,csv])for(const secret of [token,credential,'hidden-cookie','hidden-body-field'])assert.equal(output.includes(secret),false);
});
test('diagnostics omit HTML and transport internals, bound messages and tolerate missing response',()=>{
 const {deploymentDiagnostics}=require('../src/replication/diagnostics');
 assert.deepEqual(deploymentDiagnostics(undefined,'token'),{});
 assert.deepEqual(deploymentDiagnostics({status:502,data:'<html>private proxy page</html>'}),{httpStatus:502});
 const d=deploymentDiagnostics({status:400,data:{Message:'x'.repeat(20000),Errors:Array.from({length:30},(_,i)=>({Message:`Error ${i}`}))}});
 assert.ok(d.responseDetails.length<11000);
 const plain=deploymentDiagnostics({status:403,data:'Denied Bearer abc123 user@example.com access_token=secret'});
 assert.doesNotMatch(plain.responseDetails,/abc123|user@example.com|=secret/);
});

test('explicitly rejected deployments release reservations while uncertain and accepted copies remain protected',()=>{
 const {reservesCourses}=require('../src/replication/outcomes');
 const task={sourceId:'1',targets:[{orgUnitId:'101',deactivation:{status:'updated'}}],result:{status:'failed',writeAttempted:true,error:{httpStatus:403},targets:[{orgUnitId:'101',status:'failed'}]}};
 assert.equal(reservesCourses(task),false);
 for(const status of ['submitted','uncertain','running'])assert.equal(reservesCourses({...task,result:{...task.result,status}}),true);
 assert.equal(reservesCourses({...task,result:{...task.result,error:{httpStatus:503}}}),true);
 assert.equal(reservesCourses({...task,result:{...task.result,targets:[{orgUnitId:'101',status:'submitted'}]}}),true);
 assert.equal(reservesCourses({...task,result:undefined}),true);
});

test('four-column mappings resolve codes, reject mismatches and deduplicate aliases',async()=>{
 const header='SourceOrgUnitId,SourceOrgUnitCode,ReplicaOrgUnitId,ReplicaOrgUnitCode\n';
 const engine=createDeploymentJobs({enabled:()=>true,resolveCode:async code=>({SOURCE:'1',TARGET:'2',OTHER:'3'})[code]||Promise.reject(Error()),client:{source:async orgUnitId=>({orgUnitId,name:'source'}),target:async orgUnitId=>({orgUnitId,name:'target'})}});
 const run=async csv=>{const job={rows:parseDeploymentCsv(header+csv),tasks:[]};await engine.plan(job,async()=>{});return job;};
 const job=await run(',SOURCE,,TARGET\n1,,2,');assert.equal(job.status,'ready');assert.equal(job.tasks[0].targets.length,1);assert.equal(job.rows[1].status,'duplicate');
 assert.equal((await run('3,SOURCE,2,TARGET')).status,'failed');
 assert.equal((await run(',SOURCE,,TARGET\n,OTHER,,TARGET')).status,'failed');
 assert.equal((await run(',SOURCE,,TARGET\n,TARGET,,OTHER')).status,'failed');
 assert.equal((await run('1,SOURCE,2,TARGET')).status,'ready');
});

test('legacy two-column deployment CSV is rejected',()=>{assert.throws(()=>parseDeploymentCsv('SourceOrgUnitId,ReplicaOrgUnitId\n1,2'),/Headers must be/);});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createBulkJobs,interruptJob}=require('../src/shared/jobs');
const {encodeDateJob}=require('../src/shared/dateChunks');
const {createDeploymentJobs}=require('../src/replication/jobs');
const dates={start:'2027-01-01T00:00:00Z',due:'2027-01-02T00:00:00Z',end:'2027-01-03T00:00:00Z'};
function setup(options={}) {
 const data=new Map(),calls=[];let held=false;
 const store={insert:async j=>data.set(j._id,structuredClone(j)),get:async(id,owner)=>{const j=data.get(id);return j?.owner===owner?structuredClone(j):null;},getStatus:options.getStatus||(async()=>null),list:async owner=>[...data.values()].filter(j=>j.owner===owner),
 acquire:async()=>{if(held)return false;held=true;return true;},renew:async()=>{},release:async()=>{held=false;},save:async j=>{const prior=data.get(j._id)||{};if(options.enforceWorkerStatus&&!['planning','running'].includes(prior.status))throw Error('Job is no longer owned by this worker.');data.set(j._id,{...structuredClone(j),...(prior.cancelRequestedAt?{cancelRequestedAt:prior.cancelRequestedAt}:{})});},
 claim:async()=>{const j=[...data.values()].find(j=>['queued','validating'].includes(j.status));if(!j)return null;j.status=j.status==='queued'?'running':'planning';data.set(j._id,structuredClone(j));return structuredClone(j);},
 confirm:async(id,owner,time)=>{const j=data.get(id);if(!j||j.owner!==owner||j.status!=='ready'||j.expiresAt<=time)return false;j.status='queued';return true;},
 cancel:async(id,owner)=>{const j=data.get(id);if(!j||j.owner!==owner)return false;if(j.status==='running'){j.cancelRequestedAt??=1000;return true;}if(!['validating','planning','ready','queued'].includes(j.status))return false;j.status='cancelled';return true;},
 isCancelled:async(id,owner)=>data.get(id)?.owner===owner&&(data.get(id)?.status==='cancelled'||Boolean(data.get(id)?.cancelRequestedAt)),
 savePlanningProgress:async(job,worker,fields)=>{Object.assign(data.get(job._id),structuredClone(fields));return true;}};
 const courses={resolve:async r=>{calls.push('resolve');if(r.orgUnitId==='999')throw Error('bad');return {orgUnitId:r.orgUnitId||'1',code:'001',name:'Course'};},get:async id=>({orgUnitId:id}),...options.courses};
 const discovery={discover:async org=>{const activities=['assignment','quiz','discussionTopic'].map((type,i)=>({type,id:String(i+1),parentId:'7',key:`${type}:${org}:${i+1}`,name:type}));return {complete:!options.partial,activities,nativeActivities:activities.map(a=>({key:a.key,data:{Id:a.id,QuizId:a.id,TopicId:a.id,ForumId:a.parentId}}))};},...options.discovery};
 const writer={updateActivityDates:async r=>{calls.push(r.dryRun?'preview':'write');if(!r.dryRun&&options.fail)return {status:'failed',error:{category:'API_FAILURE',httpStatus:options.fail}};return {status:r.dryRun?'ready':'updated',verifiedDates:{start:null,due:null,end:null},writeAttempted:!r.dryRun};},...options.writer};
 const jobs=createBulkJobs({store,courses,discovery,writers:{assignment:writer,quiz:writer,discussionTopic:writer},writeEnabled:()=>!options.noScope,deployment:options.deployment,buildSha:options.buildSha,now:options.now||(()=>1000)});
 return {jobs,data,calls,store,courses,discovery};
}
test('bulk job interface forwards metadata-only status reads from its store',async()=>{
 const expected={_id:'completed',kind:'dates',status:'completed'};let calls=0;
 const s=setup({getStatus:async(id,owner)=>{calls++;assert.equal(id,'completed');assert.equal(owner,'owner');return expected;}});
 let fullReads=0;s.store.get=async()=>{fullReads++;throw Error('full job load was not expected');};
 assert.equal(await s.jobs.getStatus('completed','owner'),expected);assert.equal(calls,1);assert.equal(fullReads,0);
});
test('Source Deployer preparation duration is saved with ready plan and retained after execution',async()=>{
 let time=1000;
 const clock=()=>time++;
 const deployment=createDeploymentJobs({enabled:()=>true,now:clock,client:{
  setActive:async(_id,active,before)=>{await before();return {status:'updated',verifiedActive:active,writeAttempted:true};},
  deploy:async(_source,targets,before)=>{await before();return {status:'submitted',writeAttempted:true,targets:targets.map(orgUnitId=>({orgUnitId,status:'submitted'}))};}
 }});
 const s=setup({deployment,enforceWorkerStatus:true,buildSha:'0123456789abcdef0123456789abcdef01234567',now:clock});
 const created=await s.jobs.create({owner:'a',kind:'sourceDeployment',csv:'SourceOrgUnitId,SourceOrgUnitCode,ReplicaOrgUnitId,ReplicaOrgUnitCode\n10,,20,'});
 assert.equal((await s.jobs.get(created._id,'a')).buildSha,'0123456789abcdef0123456789abcdef01234567');
 await s.jobs.tick();
 const ready=await s.jobs.get(created._id,'a');
 assert.equal(ready.status,'ready');assert.ok(Number.isFinite(ready.performance.preparationMs));assert.ok(ready.performance.preparationMs>0);
 const duration=ready.performance.preparationMs;
 assert.equal(await s.jobs.confirm(created._id,'a'),true);await s.jobs.tick();
 const executed=await s.jobs.get(created._id,'a');
 assert.equal(executed.status,'activated');assert.equal(executed.performance.preparationMs,duration);
 const telemetry=executed.performance.deploymentStep3Utilization;
 assert.equal(telemetry.coverage,'complete');assert.equal(telemetry.operations.deactivation.calls,1);assert.equal(telemetry.operations.deploymentSubmission.calls,1);assert.equal(telemetry.operations.reactivation.calls,1);
 assert.ok(telemetry.logicalCheckpointRequests>0);assert.ok(telemetry.physicalCheckpoints>0);assert.equal(executed.buildSha,'0123456789abcdef0123456789abcdef01234567');
});
test('Source Deployer records interrupted Step 3 coverage and completed checkpoint waits',async()=>{
 const deployment={parse:()=>[],plan:async job=>{job.tasks=[{sourceId:'10',targets:[{orgUnitId:'20'}]}];job.status='ready';},execute:async(job,save)=>{await save(job);throw Error('simulated execution interruption');}};
 const s=setup({deployment});const created=await s.jobs.create({owner:'a',kind:'sourceDeployment',csv:'SourceOrgUnitId,SourceOrgUnitCode,ReplicaOrgUnitId,ReplicaOrgUnitCode\n10,,20,'});
 await s.jobs.tick();assert.equal(await s.jobs.confirm(created._id,'a'),true);await s.jobs.tick();
 const interrupted=await s.jobs.get(created._id,'a');
 assert.equal(interrupted.status,'interrupted');assert.equal(interrupted.performance.deploymentStep3Utilization.coverage,'interrupted');
 assert.ok(interrupted.performance.deploymentStep3Utilization.checkpointCallerWaitMs>0);
});
test('Source Deployer cancellation finishes the active batch and leaves later batches not attempted',async()=>{
 let s,cancelId,requested=false,deactivations=0,reactivations=0,submissions=0;
 const deployment=createDeploymentJobs({enabled:()=>true,client:{
  setActive:async(_id,active,before)=>{await before();if(!active){deactivations++;if(!requested){requested=true;assert.equal(await s.jobs.cancel(cancelId,'a'),true);}}else reactivations++;return {status:'updated',verifiedActive:active,writeAttempted:true};},
  deploy:async(_source,targets,before)=>{submissions++;await before();return {status:'submitted',writeAttempted:true,deploymentId:'dep-1',targets:targets.map(orgUnitId=>({orgUnitId,status:'submitted'}))};}
 }});
 s=setup({deployment,enforceWorkerStatus:true});
 const csv='SourceOrgUnitId,SourceOrgUnitCode,ReplicaOrgUnitId,ReplicaOrgUnitCode\n'+Array.from({length:101},(_,i)=>`10,,${20+i},`).join('\n');
 const created=await s.jobs.create({owner:'a',kind:'sourceDeployment',csv});cancelId=created._id;await s.jobs.tick();assert.equal(await s.jobs.confirm(created._id,'a'),true);await s.jobs.tick();
 const saved=await s.jobs.get(created._id,'a');assert.equal(saved.status,'cancelled');assert.equal(deactivations,100);assert.equal(submissions,1);assert.equal(reactivations,100);
 assert.equal(saved.tasks[0].result.status,'submitted');assert.equal(saved.tasks[0].result.deploymentId,'dep-1');assert.equal(saved.tasks[1].result,undefined);assert.equal(saved.tasks[1].targets.length,1);
 assert.match(saved.message,/may continue asynchronously/);assert.equal(require('../src/replication/outcomes').targetStatus(saved.tasks[1],saved.tasks[1].targets[0]),'notAttempted');
 assert.equal(require('../src/replication/view').createDeploymentView({enabled:()=>true}).report(saved).split('\r\n').at(-1).includes('notAttempted'),true);
});
test('Source Deployer cancellation before dispatch prevents the first batch',async()=>{
 let deactivations=0,submissions=0;const deployment=createDeploymentJobs({enabled:()=>true,client:{setActive:async(_id,_active,before)=>{deactivations++;await before();return {status:'updated'};},deploy:async()=>{submissions++;}}});
 const s=setup({deployment}),created=await s.jobs.create({owner:'a',kind:'sourceDeployment',csv:'SourceOrgUnitId,SourceOrgUnitCode,ReplicaOrgUnitId,ReplicaOrgUnitCode\n10,,20,'});await s.jobs.tick();await s.jobs.confirm(created._id,'a');s.store.isCancelled=async()=>true;await s.jobs.tick();
 const saved=await s.jobs.get(created._id,'a');assert.equal(saved.status,'cancelled');assert.equal(deactivations,0);assert.equal(submissions,0);assert.equal(require('../src/replication/outcomes').targetStatus(saved.tasks[0],saved.tasks[0].targets[0]),'notAttempted');
});
test('Source Deployer cancellation during submission or reactivation drains the accepted batch',async()=>{
 for(const phase of ['submission','reactivation']){
  let s,cancelId,requested=false,submissions=0,reactivations=0;
  const requestCancel=async()=>{if(requested)return;requested=true;assert.equal(await s.jobs.cancel(cancelId,'a'),true);assert.equal(await s.jobs.cancel(cancelId,'a'),true);};
  const deployment=createDeploymentJobs({enabled:()=>true,client:{
   setActive:async(_id,active,before)=>{await before();if(active){reactivations++;if(phase==='reactivation')await requestCancel();}return {status:'updated',verifiedActive:active};},
   deploy:async(_source,targets,before)=>{submissions++;await before();if(phase==='submission')await requestCancel();return {status:'submitted',deploymentId:'dep-accepted',targets:targets.map(orgUnitId=>({orgUnitId,status:'submitted'}))};}
  }});
  s=setup({deployment});const created=await s.jobs.create({owner:'a',kind:'sourceDeployment',csv:'SourceOrgUnitId,SourceOrgUnitCode,ReplicaOrgUnitId,ReplicaOrgUnitCode\n10,,20,'});cancelId=created._id;await s.jobs.tick();await s.jobs.confirm(created._id,'a');await s.jobs.tick();
  const saved=await s.jobs.get(created._id,'a');assert.equal(saved.status,'cancelled',phase);assert.equal(submissions,1,phase);assert.equal(reactivations,1,phase);assert.equal(saved.tasks[0].result.deploymentId,'dep-accepted');assert.equal(saved.tasks[0].targets[0].activation.status,'updated');
 }
});
test('Source Deployer recovers a pending cancellation without replaying uncertain submissions',async()=>{
 const calls=[];const deployment=createDeploymentJobs({enabled:()=>true,client:{setActive:async(_id,active,before)=>{calls.push(active?'activate':'deactivate');await before();return {status:'updated',verifiedActive:active};},deploy:async(_source,targets,before)=>{calls.push('deploy');await before();return {status:'submitted',targets:targets.map(orgUnitId=>({orgUnitId,status:'submitted'}))};}}});
 const s=setup({deployment});const csv='SourceOrgUnitId,SourceOrgUnitCode,ReplicaOrgUnitId,ReplicaOrgUnitCode\n'+Array.from({length:101},(_,i)=>`10,,${20+i},`).join('\n');const created=await s.jobs.create({owner:'a',kind:'sourceDeployment',csv});await s.jobs.tick();
 const recovered=await s.jobs.get(created._id,'a');recovered.status='queued';recovered.cancelRequestedAt=900;recovered.tasks[0].result={status:'uncertain',writeAttempted:true,error:{category:'UNCERTAIN_OUTCOME'}};s.data.set(created._id,recovered);calls.length=0;
 await s.jobs.tick();const final=await s.jobs.get(created._id,'a');assert.equal(final.status,'cancelled');assert.deepEqual(calls,[]);assert.equal(final.tasks[0].result.status,'uncertain');assert.equal(final.tasks[1].result,undefined);
});
test('all course validation and discovery are read-only; confirmation executes only stored deduplicated plan',async()=>{
 const s=setup(),j=await s.jobs.create({owner:'a',csv:'OrgUnitId,OrgUnitCode\n1,\n,001\n2,',dates});
 await s.jobs.tick();const p=await s.jobs.get(j._id,'a');assert.equal(p.status,'ready');assert.equal(p.courses.length,2);assert.equal(p.tasks.length,6);assert.equal(p.rows[1].status,'duplicate');assert.ok(!s.calls.includes('write'));
 assert.equal(await s.jobs.confirm(j._id,'other'),false);assert.equal(await s.jobs.confirm(j._id,'a'),true);assert.equal(await s.jobs.confirm(j._id,'a'),false);
 await Promise.all([s.jobs.tick(),s.jobs.tick()]);assert.equal(s.calls.filter(c=>c==='write').length,6);assert.equal((await s.jobs.get(j._id,'a')).status,'completed');
});
test('Date Manager Step 3 persists compact utilization snapshots with the job checkpoints',async()=>{
 const s=setup(),created=await s.jobs.create({owner:'a',csv:'OrgUnitId,OrgUnitCode\n1,',dates});await s.jobs.tick();
 const plan=await s.jobs.get(created._id,'a');await s.jobs.confirm(created._id,'a');await s.jobs.tick();
 const completed=await s.jobs.get(created._id,'a'),metrics=completed.performance.dateStep3Utilization;
 assert.equal(completed.status,'completed');assert.equal(metrics.version,1);assert.equal(metrics.httpMs.length,5);assert.equal(metrics.permitMs.length,5);
 assert.ok(metrics.coveredMs>0);assert.equal(metrics.coveredMs,metrics.httpMs.reduce((sum,value)=>sum+value,0));
 assert.equal(plan.performance?.dateStep3Utilization,undefined);
});
test('Date Manager Step 2 persists bounded discovery utilization with existing plan saves',async()=>{
 const s=setup(),created=await s.jobs.create({owner:'a',csv:'OrgUnitId,OrgUnitCode\n1,',dates});await s.jobs.tick();
 const job=await s.jobs.get(created._id,'a'),metrics=job.performance.dateStep2Utilization;
 assert.equal(job.status,'ready');assert.equal(metrics.version,1);assert.equal(metrics.httpMs.length,9);assert.equal(metrics.permitMs.length,9);assert.equal(metrics.workerMs.length,9);
 assert.ok(metrics.coveredMs>=0);assert.ok(metrics.discoveryDurationMs>=metrics.coveredMs-1);assert.ok(Number.isFinite(metrics.checkpointWaitMs));assert.equal(job.courses.length,1);assert.equal(job.tasks.length,3);
});
test('Step 2 metadata telemetry stays nested through a later durable checkpoint',async()=>{
 const s=setup(),events=[];let checkpointTelemetry;
 const saveProgress=s.store.savePlanningProgress;s.store.savePlanningProgress=async(job,worker,fields)=>{
  if(Object.hasOwn(fields,'performance.dateStep2Utilization'))events.push('metadata');
  return saveProgress(job,worker,fields);
 };
 const save=s.store.save;s.store.save=async job=>{
  if(job.performance?.dateStep2Utilization){
   events.push('checkpoint');
   assert.equal(Object.hasOwn(job,'performance.dateStep2Utilization'),false);
   const encoded=await encodeDateJob(job,{bulkWrite:async()=>{}},'test',job.dateChunks||{});
   const paths=Object.keys(encoded).filter(path=>path!=='_id');
   assert.equal(paths.some(path=>paths.some(other=>other!==path&&other.startsWith(`${path}.`))),false);
   assert.deepEqual(encoded.performance.dateStep2Utilization,job.performance.dateStep2Utilization);
   checkpointTelemetry=encoded.performance.dateStep2Utilization;
  }
  return save(job);
 };
 const created=await s.jobs.create({owner:'a',csv:'OrgUnitId,OrgUnitCode\n1,',dates});await s.jobs.tick();
 assert.ok(events.indexOf('metadata')>=0);assert.ok(events.indexOf('checkpoint')>events.indexOf('metadata'));
 assert.ok(checkpointTelemetry);assert.equal(checkpointTelemetry.version,1);
 assert.equal(Object.hasOwn(s.data.get(created._id),'performance.dateStep2Utilization'),false);
 assert.deepEqual(s.data.get(created._id).performance.dateStep2Utilization,checkpointTelemetry);
});
test('invalid course, incomplete discovery and missing scopes cannot write',async()=>{
 for(const options of [{csv:'OrgUnitId,OrgUnitCode\n1,\n999,'},{partial:true},{noScope:true}]){
  const s=setup(options),j=await s.jobs.create({owner:'a',csv:options.csv||'OrgUnitId,OrgUnitCode\n1,',dates});await s.jobs.tick();await s.jobs.confirm(j._id,'a');await s.jobs.tick();
  assert.ok(!s.calls.includes('write'));assert.equal((await s.jobs.get(j._id,'a')).status,'failed');
 }
});
test('Date Manager course resolution retains eight concurrent row workers',async()=>{
 let active=0,peak=0;
 const s=setup({courses:{resolve:async row=>{peak=Math.max(peak,++active);await new Promise(resolve=>setImmediate(resolve));active--;return {orgUnitId:row.orgUnitId};}}});
 const j=await s.jobs.create({owner:'a',csv:'OrgUnitId,OrgUnitCode\n'+Array.from({length:20},(_,i)=>`${i+1},`).join('\n'),dates});
 await s.jobs.tick();assert.equal(peak,8);assert.equal((await s.jobs.get(j._id,'a')).courses.length,20);
});
test('Step 2 metadata persistence is throttled and runs independently of durable checkpoints',async()=>{
 let time=1000,metadataWrites=0;
 const s=setup({now:()=>time,courses:{resolve:async row=>{time+=6000;await new Promise(resolve=>setTimeout(resolve,1200));return {orgUnitId:row.orgUnitId};}}});
 const saveProgress=s.store.savePlanningProgress;s.store.savePlanningProgress=async(...args)=>{metadataWrites++;return saveProgress(...args);};
 const j=await s.jobs.create({owner:'a',csv:'OrgUnitId,OrgUnitCode\n1,',dates});await s.jobs.tick();
 assert.equal(metadataWrites,2);assert.equal((await s.jobs.get(j._id,'a')).status,'ready');
});
test('Date Manager discovery feeds eight concurrent course reads',async()=>{
 let active=0,peak=0;
 const s=setup({discovery:{discover:async()=>{peak=Math.max(peak,++active);await new Promise(resolve=>setImmediate(resolve));active--;return {complete:true,activities:[],nativeActivities:[]};}}});
 const j=await s.jobs.create({owner:'a',csv:'OrgUnitId,OrgUnitCode\n'+Array.from({length:20},(_,i)=>`${i+1},`).join('\n'),dates});
 await s.jobs.tick();assert.equal(peak,8);assert.equal((await s.jobs.get(j._id,'a')).courses.length,20);
});
test('cancellation during course resolution drains lookups in flight and prevents further scheduling',async()=>{
 let started=0,release;const barrier=new Promise(resolve=>{release=resolve;});
 const s=setup({courses:{resolve:async row=>{started++;if(started===8)release();await new Promise(resolve=>setTimeout(resolve,0));return {orgUnitId:row.orgUnitId};}}});
 let cancellationReads=0;s.store.isCancelled=async()=>{cancellationReads++;return false;};
 const j=await s.jobs.create({owner:'a',csv:'OrgUnitId,OrgUnitCode\n'+Array.from({length:40},(_,i)=>`${i+1},`).join('\n'),dates});
 const running=s.jobs.tick();await barrier;assert.equal(await s.jobs.cancel(j._id,'a'),true);await running;
 const saved=await s.jobs.get(j._id,'a');assert.equal(saved.status,'cancelled');assert.equal(started,8);assert.equal(saved.courses.length,8);assert.equal(saved.progress.processed,8);assert.equal(saved.tasks.length,0);
 assert.equal(cancellationReads,2);assert.equal(s.calls.filter(call=>call==='write').length,0);assert.equal(await s.jobs.confirm(j._id,'a'),false);
});
test('Date Manager database cancellation polling is throttled to one second',async()=>{
 let time=0,polls=0;
 const s=setup({now:()=>time,courses:{resolve:async row=>{time+=100;return {orgUnitId:row.orgUnitId};}}});
 s.store.isCancelled=async()=>{polls++;return false;};
 const j=await s.jobs.create({owner:'a',csv:'OrgUnitId,OrgUnitCode\n'+Array.from({length:30},(_,i)=>`${i+1},`).join('\n'),dates});
 await s.jobs.tick();assert.equal((await s.jobs.get(j._id,'a')).courses.length,30);
 assert.ok(polls>=4&&polls<=7,`expected about one database poll per second, got ${polls}`);
});
test('cancellation during activity preview drains the current request and prevents later previews or readiness',async()=>{
 let started=0,release;const entered=new Promise(resolve=>{release=resolve;});
 const activities=Array.from({length:20},(_,i)=>({type:'quiz',id:String(i+1),key:`quiz:1:${i+1}`,name:`Quiz ${i+1}`}));
 const s=setup({discovery:{discover:async()=>({complete:true,activities,nativeActivities:activities.map(a=>({key:a.key,data:{QuizId:a.id}}))})},writer:{updateActivityDates:async request=>{assert.equal(request.dryRun,true);started++;release();await new Promise(resolve=>setTimeout(resolve,0));return {status:'ready',verifiedDates:{}};}}});
 const j=await s.jobs.create({owner:'a',csv:'OrgUnitId,OrgUnitCode\n1,',dates});const running=s.jobs.tick();await entered;
 assert.equal(await s.jobs.cancel(j._id,'a'),true);await running;
 const saved=await s.jobs.get(j._id,'a');assert.equal(saved.status,'cancelled');assert.equal(started,1);assert.equal(saved.tasks.length,1);assert.equal(s.calls.filter(call=>call==='write').length,0);assert.equal(await s.jobs.confirm(j._id,'a'),false);
});
test('cancellation during activity discovery drains current courses without scheduling more discoveries or previews',async()=>{
 let started=0,release;const entered=new Promise(resolve=>{release=resolve;});
 const s=setup({discovery:{discover:async org=>{started++;if(started===8)release();await new Promise(resolve=>setTimeout(resolve,0));const key=`quiz:${org}:1`;return {complete:true,activities:[{type:'quiz',id:'1',key,name:'Quiz'}],nativeActivities:[{key,data:{QuizId:'1'}}]};}}});
 const j=await s.jobs.create({owner:'a',csv:'OrgUnitId,OrgUnitCode\n'+Array.from({length:20},(_,i)=>`${i+1},`).join('\n'),dates});
 const running=s.jobs.tick();await entered;assert.equal(await s.jobs.cancel(j._id,'a'),true);await running;
 const saved=await s.jobs.get(j._id,'a');assert.equal(saved.status,'cancelled');assert.equal(started,8);assert.equal(saved.tasks.length,0);assert.equal(s.calls.filter(call=>call==='preview').length,0);assert.equal(s.calls.filter(call=>call==='write').length,0);
 assert.equal(saved.courses.filter(course=>course.counts?.quiz===1).length,8);
});
test('isolated errors continue; systemic errors stop remaining writes and retain results',async()=>{
 for(const code of [400,401,403,429,503]){
  const s=setup({fail:code}),j=await s.jobs.create({owner:'a',csv:'OrgUnitId,OrgUnitCode\n1,',dates});await s.jobs.tick();await s.jobs.confirm(j._id,'a');await s.jobs.tick();const r=await s.jobs.get(j._id,'a');
  assert.equal(r.status,'completedWithErrors');assert.equal(s.calls.filter(c=>c==='write').length,code===400?3:1);if(code!==400)assert.equal(r.totals.skipped,2);
 }
});
test('interruption retains confirmed successes, marks in-flight work uncertain, and keeps untouched tasks pending',()=>{
 const j=interruptJob({kind:'dates',tasks:[{result:{status:'updated'}},{result:{status:'running'}},{}]});
 assert.deepEqual(j.tasks.map(t=>t.result?.status),['updated','uncertain',undefined]);assert.equal(j.tasks[1].result.error.category,'UNCERTAIN_OUTCOME');
});
test('Step 3 cancellation drains an in-flight write, retains its result, and leaves later tasks pending',async()=>{
 let started,finish;const entered=new Promise(resolve=>started=resolve),drain=new Promise(resolve=>finish=resolve);let writes=0;
 const s=setup({writer:{updateActivityDates:async r=>{if(r.dryRun)return {status:'ready',verifiedDates:dates};writes++;started();await drain;return {status:'updated',writeAttempted:true,verifiedDates:dates};}}});
 const created=await s.jobs.create({owner:'a',csv:'OrgUnitId,OrgUnitCode\n1,',dates});await s.jobs.tick();await s.jobs.confirm(created._id,'a');
 const running=s.jobs.tick();await entered;assert.equal(await s.jobs.cancel(created._id,'a'),true);assert.equal(await s.jobs.cancel(created._id,'a'),true);finish();await running;
 const saved=await s.jobs.get(created._id,'a');assert.equal(saved.status,'cancelled');assert.equal(saved.cancelledDuringStep3,true);assert.equal(saved.tasks[0].result.status,'updated');assert.ok(saved.tasks.slice(1).every(task=>!task.result));assert.equal(writes,1);
 assert.equal(saved.totals.updated,1);assert.equal(saved.totals.pending,2);assert.match(saved.message,/Confirmed updates are saved/);
});
test('recovered Step 3 cancellation reconciles the in-flight task read-only and does not resume pending writes',async()=>{
 const calls=[];const s=setup({writer:{updateActivityDates:async request=>{calls.push(request.reconcileOnly?'reconcile':request.dryRun?'preview':'write');return request.reconcileOnly?{status:'unchanged',verifiedDates:dates,reconciled:true,writeAttempted:false}:{status:'ready',verifiedDates:dates};}}});
 const created=await s.jobs.create({owner:'a',csv:'OrgUnitId,OrgUnitCode\n1,',dates});await s.jobs.tick();
 const recovered=await s.jobs.get(created._id,'a');recovered.storageVersion=2;recovered.status='queued';recovered.cancelRequestedAt=900;recovered.tasks[0].result={status:'running',writeAttempted:false};s.data.set(created._id,recovered);calls.length=0;
 await s.jobs.tick();const final=await s.jobs.get(created._id,'a');assert.deepEqual(calls,['reconcile']);assert.equal(final.status,'cancelled');assert.equal(final.tasks[0].result.status,'updated');assert.ok(final.tasks.slice(1).every(task=>!task.result));
});
test('restarted Date Manager reconciles in-flight activity read-only and resumes pending work',async()=>{
 const calls=[];const s=setup({writer:{updateActivityDates:async request=>{calls.push(request.reconcileOnly?'reconcile':request.dryRun?'preview':'write');return request.reconcileOnly?{status:'unchanged',verifiedDates:dates,reconciled:true,writeAttempted:false}:{status:'updated',verifiedDates:dates,writeAttempted:true};}}});
 const created=await s.jobs.create({owner:'a',csv:'OrgUnitId,OrgUnitCode\n1,',dates});await s.jobs.tick();
 const resumed=await s.jobs.get(created._id,'a');resumed.storageVersion=2;resumed.status='queued';resumed.tasks[0].result={status:'updated',verifiedDates:dates,writeAttempted:true};resumed.tasks[1].result={status:'running',writeAttempted:false};s.data.set(created._id,resumed);
 resumed.step3ElapsedMs=12000;resumed.step3StartedAt=null;resumed.step3ProgressAt=900;
 await s.jobs.tick();const final=await s.jobs.get(created._id,'a');
 assert.equal(final.tasks[0].result.status,'updated');assert.equal(final.tasks[1].result.status,'unchanged');assert.equal(final.tasks[1].result.reconciled,true);assert.equal(final.tasks[2].result.status,'updated');
 assert.equal(calls.filter(c=>c==='reconcile').length,1);assert.equal(calls.filter(c=>c==='write').length,1);assert.equal(final.status,'completed');
 assert.equal(final.step3ElapsedMs,12000);assert.equal(final.step3StartedAt,null);assert.equal(final.step3ProgressAt,1000);
});
test('persistence checkpoint failure stops sequential writes and preserves running intent',async()=>{
 const s=setup();const j=await s.jobs.create({owner:'a',csv:'OrgUnitId,OrgUnitCode\n1,',dates});await s.jobs.tick();const persisted=await s.jobs.get(j._id,'a');persisted.storageVersion=2;s.data.set(j._id,persisted);await s.jobs.confirm(j._id,'a');
 const originalSave=s.store.save;s.store.save=async job=>{if(job.tasks.some(t=>t.result?.status==='updated')){const error=Error('database unavailable');error.name='MongoNetworkError';throw error;}return originalSave(job);};
 await s.jobs.tick();const saved=await s.jobs.get(j._id,'a');assert.equal(s.calls.filter(c=>c==='write').length,1);assert.equal(saved.status,'running');assert.equal(saved.tasks[0].result.status,'running');assert.equal(saved.tasks[1].result,undefined);
});
test('worker lease loss prevents the first and every later Brightspace write',async()=>{
 const s=setup();const j=await s.jobs.create({owner:'a',csv:'OrgUnitId,OrgUnitCode\n1,',dates});await s.jobs.tick();const persisted=await s.jobs.get(j._id,'a');persisted.storageVersion=2;s.data.set(j._id,persisted);await s.jobs.confirm(j._id,'a');
 s.store.renew=async()=>{throw Error('Worker lease lost.');};await s.jobs.tick();
 assert.equal(s.calls.filter(c=>c==='write').length,0);const saved=await s.jobs.get(j._id,'a');assert.equal(saved.status,'running');assert.ok(saved.tasks.every(t=>!t.result));
});
test('invalid bulk ordering prevents storing jobs',async()=>{
 const s=setup();await assert.rejects(()=>s.jobs.create({owner:'a',csv:'OrgUnitId,OrgUnitCode\n1,',dates:{...dates,due:dates.start}}));assert.equal(s.data.size,0);
});
module.exports={setup};

test('queued activation dispatches separately and retains the original deployment result',async()=>{
 const s=setup();let deployments=0,activations=0;
 const job={_id:'activation',owner:'a',kind:'sourceDeployment',operation:'activate',status:'queued',courses:[],tasks:[{sourceId:'10',targets:[{orgUnitId:'20'}],result:{status:'submitted',deploymentId:'99'}}]};
 s.data.set(job._id,job);
 const jobs=createBulkJobs({store:s.store,deployment:{execute:async()=>{deployments++;},activate:async j=>{activations++;j.status='activated';}}});
 await jobs.tick();assert.equal(deployments,0);assert.equal(activations,1);assert.equal(s.data.get(job._id).status,'activated');assert.equal(s.data.get(job._id).tasks[0].result.deploymentId,'99');
});

test('date workers overlap independent courses, serialize each course and persist intent before writes',async()=>{
 const s=setup();let active=0,peak=0;const perCourse=new Set(),validated=new Set();
 const pause=()=>new Promise(resolve=>setTimeout(resolve,2));
 const writer={updateActivityDates:async r=>{
  assert.ok(!perCourse.has(r.orgUnitId));perCourse.add(r.orgUnitId);peak=Math.max(peak,++active);
  if(!r.dryRun){assert.equal(validated.size,0);const saved=[...s.data.values()][0];assert.equal(saved.tasks.find(t=>t.orgUnitId===r.orgUnitId&&t.activity.id===r.activity.id).result.status,'running');}
  await pause();active--;perCourse.delete(r.orgUnitId);return {status:r.dryRun?'ready':'updated',verifiedDates:{}};
 }};
 const jobs=createBulkJobs({store:s.store,courses:{resolve:async r=>({orgUnitId:r.orgUnitId}),get:async id=>{await pause();validated.add(id);}},discovery:{discover:async orgUnitId=>{const activities=['1','2'].map(id=>({type:'quiz',id,key:`quiz:${orgUnitId}:${id}`}));return {complete:true,activities,nativeActivities:activities.map(a=>({key:a.key,data:{QuizId:a.id}}))};}},writers:{quiz:writer},writeEnabled:()=>true});
 const j=await jobs.create({owner:'a',csv:'OrgUnitId,OrgUnitCode\n'+Array.from({length:8},(_,i)=>`${i+1},`).join('\n'),dates});
 await jobs.tick();assert.equal(peak,8);peak=0;await jobs.confirm(j._id,'a');await jobs.tick();
 const result=await jobs.get(j._id,'a');assert.equal(peak,6);assert.equal(result.status,'completed');assert.equal(result.totals.updated,16);
});

test('date chunk snapshots cannot change while database writes are pending',async()=>{
 const {encodeDateJob}=require('../src/shared/dateChunks');const {createHash}=require('node:crypto');
 const job={_id:'snapshot',kind:'dates',rows:[{status:'pending'}],courses:[],tasks:[{result:{status:'running'}}]};const records=[];
 await encodeDateJob(job,{bulkWrite:async operations=>{job.tasks[0].result.status='updated';for(const op of operations){const {filter,update}=op.updateOne;records.push({key:filter._id,items:update.$setOnInsert.items});}}},'test');
 const task=records.find(r=>r.key.includes(':tasks:'));assert.equal(task.items[0].result.status,'running');assert.ok(task.key.endsWith(createHash('sha256').update(JSON.stringify(task.items)).digest('hex')));
});

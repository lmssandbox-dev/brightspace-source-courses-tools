'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {encodeDateJob,decodeDateJob,DIRTY}=require('../src/shared/dateChunks');
const {setup}=require('./bulk-jobs.test');
const {createDateView}=require('../src/dates/view');
const {installDateUploadLimit}=require('../src/shared/uploadLimit');
const dates={start:'2027-01-01T00:00:00Z',due:'2027-01-02T00:00:00Z',end:'2027-01-03T00:00:00Z'};
function chunks(){const docs=new Map(),batches=[];return {docs,batches,updateOne:async()=>{throw Error('chunk writes must use bulkWrite');},bulkWrite:async ops=>{batches.push(ops);for(const op of ops){const {filter,update,upsert}=op.updateOne;assert.equal(upsert,true);if(!docs.has(filter._id))docs.set(filter._id,{_id:filter._id,...structuredClone(update.$setOnInsert)});}},find:q=>({toArray:async()=>[...docs.values()].filter(d=>q._id.$in.includes(d._id)&&d.namespace===q.namespace&&d.jobId===q.jobId)})};}
test('large job exceeds old 8 MB cap, round-trips chunks and preserves old checkpoint after partial update',async()=>{
 const collection=chunks(),job={_id:'large',kind:'dates',rows:[],courses:[],tasks:Array.from({length:10000},(_,i)=>({id:i,name:'x'.repeat(1000)}))};
 assert.ok(Buffer.byteLength(JSON.stringify(job))>8*1024*1024);
 const first=await encodeDateJob(job,collection,'n');
 assert.ok(Buffer.byteLength(JSON.stringify(first))<1000000);
 assert.equal((await decodeDateJob(structuredClone(first),collection,'n')).tasks.length,10000);
 const existingBatches=collection.batches.length;
 const unchanged=await encodeDateJob(job,collection,'n',first.dateChunks);
 assert.equal(collection.batches.length,existingBatches);assert.deepEqual(unchanged.dateChunks,first.dateChunks);
 job.tasks[55].result={status:'updated'};job[DIRTY]={tasks:[55]};
 const second=await encodeDateJob(job,collection,'n',first.dateChunks);
 assert.equal(collection.docs.size,1001);
 assert.equal((await decodeDateJob(structuredClone(first),collection,'n')).tasks[55].result,undefined);
 assert.equal((await decodeDateJob(structuredClone(second),collection,'n')).tasks[55].result.status,'updated');
 await assert.rejects(()=>decodeDateJob(structuredClone(second),collection,'wrong'),/incomplete/);
});
test('date chunk persistence batches at most 500 content-addressed upserts',async()=>{
 const collection=chunks(),job={_id:'batch',kind:'dates',rows:[],courses:[],tasks:Array.from({length:5010},(_,i)=>({id:i}))};
 const encoded=await encodeDateJob(job,collection,'n');
 assert.equal(encoded.storageVersion,2);assert.deepEqual(collection.batches.map(batch=>batch.length),[500,1]);
 assert.equal(collection.docs.size,501);
 let chunkIndex=0;for(const batch of collection.batches)for(const op of batch){
  assert.deepEqual(Object.keys(op),['updateOne']);assert.equal(op.updateOne.upsert,true);
  assert.deepEqual(Object.keys(op.updateOne.update),['$setOnInsert']);
  assert.equal(op.updateOne.filter._id,encoded.dateChunks.tasks[chunkIndex++]);
 }
 assert.equal((await decodeDateJob(structuredClone(encoded),collection,'n')).tasks.length,5010);
});
test('resumed planning does not repeat resolved rows or duplicate partially previewed activities',async()=>{
 const s=setup(),j=await s.jobs.create({owner:'a',csv:'OrgUnitId,OrgUnitCode\n1,\n2,',dates});
 await s.jobs.tick();const saved=s.data.get(j._id);
 saved.status='validating';saved.courses[1].status='pending';saved.tasks=saved.tasks.filter(t=>t.orgUnitId==='1').concat(saved.tasks.filter(t=>t.orgUnitId==='2').slice(0,1));
 const before=s.calls.filter(c=>c==='preview').length;
 await s.jobs.tick();assert.equal(s.data.get(j._id).tasks.length,6);assert.equal(s.calls.filter(c=>c==='preview').length-before,2);
});
test('course resolution saves once and discovery checkpoints every 500 courses before the final ready save',async()=>{
 const s=setup(),j=await s.jobs.create({owner:'a',csv:'OrgUnitId,OrgUnitCode\n'+Array.from({length:501},(_,i)=>`${i+1},`).join('\n'),dates});
 const saves=[];const originalSave=s.store.save;
 let readySaveStarted,releaseReadySave;
 const readySave=new Promise(resolve=>{readySaveStarted=resolve;}),readyGate=new Promise(resolve=>{releaseReadySave=resolve;});
 s.store.save=async job=>{if(job.status==='ready'){readySaveStarted();await readyGate;}saves.push(structuredClone(job));await originalSave(job);};
 let savesAtDiscoveryStart;
 s.discovery.discover=async orgUnitId=>{savesAtDiscoveryStart??=saves.length;const key=`quiz:${orgUnitId}:1`,activities=[{type:'quiz',id:'1',key,name:'Quiz'}];return {complete:true,activities,nativeActivities:[{key,data:{QuizId:'1'}}]};};
 const running=s.jobs.tick();
 await readySave;
 assert.notEqual((await s.jobs.get(j._id,'a')).status,'ready');
 releaseReadySave();
 await running;
 assert.equal(savesAtDiscoveryStart,1);
 assert.equal(saves[0].progress.phase,'Resolving courses');
 assert.equal(saves[0].progress.processed,501);
 assert.equal(saves[0].courses.length,501);
 const discoveryCheckpoints=saves.filter(snapshot=>snapshot.progress.phase==='Discovering activities');
 assert.ok(discoveryCheckpoints.length>=2&&discoveryCheckpoints.length<=3,`expected batched discovery checkpoints, got ${discoveryCheckpoints.length}`);
 assert.equal(discoveryCheckpoints.at(-1).status,'ready');
 assert.equal(discoveryCheckpoints.at(-1).tasks.length,501);
});
test('resumed execution skips saved successes and flags in-flight work instead of repeating it',async()=>{
 const s=setup({writer:{updateActivityDates:async request=>{s.calls.push(request.reconcileOnly?'reconcile':request.dryRun?'preview':'write');return request.reconcileOnly?{status:'uncertain',error:{category:'UNCERTAIN_OUTCOME',stage:'reconciliation',message:'Manual review required.'}}:{status:request.dryRun?'ready':'updated',verifiedDates:{},writeAttempted:!request.dryRun};}}}),j=await s.jobs.create({owner:'a',csv:'OrgUnitId,OrgUnitCode\n1,',dates});await s.jobs.tick();await s.jobs.confirm(j._id,'a');
 const saved=s.data.get(j._id);saved.tasks[0].result={status:'updated'};saved.tasks[1].result={status:'running'};
 await s.jobs.tick();const result=s.data.get(j._id);
 assert.equal(s.calls.filter(c=>c==='write').length,1);assert.equal(s.calls.filter(c=>c==='reconcile').length,1);assert.equal(result.tasks[0].result.status,'updated');assert.equal(result.tasks[1].result.status,'uncertain');assert.equal(result.tasks[1].result.error.category,'UNCERTAIN_OUTCOME');assert.equal(result.status,'completedWithErrors');
});
test('date results paginate large task lists without rendering every activity',()=>{
 const job={_id:'j',status:'completedWithErrors',rows:[],courses:[],dates,tasks:Array.from({length:1000},(_,i)=>({name:`Activity-${i}`,activity:{type:'quiz',id:String(i)},result:{status:'updated'}}))};
 const html=createDateView({writeEnabled:()=>true}).render({},job,{now:()=>0,button:()=>'',page:2});
 assert.match(html,/Completed with Issues/);assert.doesNotMatch(html,/Page 2 of|Activity-100<|CSV validation/);
});
test('large form parser is scoped to date previews and leaves other parsers intact',async()=>{
 const {Readable}=require('node:stream');let fallback=0;
 const app={_router:{stack:[{name:'urlencodedParser',handle:(req,res,next)=>{fallback++;next();}}]}};
 installDateUploadLimit(app);const handler=app._router.stack[0].handle;
 const csv='OrgUnitId,OrgUnitCode\n'+Array.from({length:10000},(_,i)=>`,SOURCE-${i}`).join('\n');
 const body=new URLSearchParams({csv,ltik:'session'}).toString();assert.ok(body.length>100*1024);
 const req=Readable.from([Buffer.from(body)]);Object.assign(req,{method:'POST',path:'/bulk/preview',headers:{'content-type':'application/x-www-form-urlencoded','content-length':String(Buffer.byteLength(body))}});
 await new Promise((resolve,reject)=>handler(req,{},e=>e?reject(e):resolve()));
 assert.equal(req.body.csv,csv);assert.equal(req.body.ltik,'session');assert.equal(fallback,0);
 handler({method:'POST',path:'/other'},{},()=>{});assert.equal(fallback,1);
});
test('10,000 courses produce a complete read-only 30,000-activity plan',async()=>{
 const s=setup();s.store.save=async job=>s.data.set(job._id,job);
 const j=await s.jobs.create({owner:'a',csv:'OrgUnitId,OrgUnitCode\n'+Array.from({length:10000},(_,i)=>`${i+10001},`).join('\n'),dates});
 await s.jobs.tick();const saved=s.data.get(j._id);
 assert.equal(saved.status,'ready');assert.equal(saved.courses.length,10000);assert.equal(saved.tasks.length,30000);assert.equal(saved.progress.processed,10000);assert.equal(s.calls.filter(c=>c==='write').length,0);
});

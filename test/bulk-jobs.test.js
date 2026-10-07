'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createBulkJobs,interruptJob}=require('../src/shared/jobs');
const dates={start:'2027-01-01T00:00:00Z',due:'2027-01-02T00:00:00Z',end:'2027-01-03T00:00:00Z'};
function setup(options={}) {
 const data=new Map(),calls=[];let held=false;
 const store={insert:async j=>data.set(j._id,structuredClone(j)),get:async(id,owner)=>{const j=data.get(id);return j?.owner===owner?structuredClone(j):null;},list:async owner=>[...data.values()].filter(j=>j.owner===owner),
 acquire:async()=>{if(held)return false;held=true;return true;},renew:async()=>{},release:async()=>{held=false;},save:async j=>data.set(j._id,structuredClone(j)),
 claim:async()=>{const j=[...data.values()].find(j=>['queued','validating'].includes(j.status));if(!j)return null;j.status=j.status==='queued'?'running':'planning';return structuredClone(j);},
 confirm:async(id,owner,time)=>{const j=data.get(id);if(!j||j.owner!==owner||j.status!=='ready'||j.expiresAt<=time)return false;j.status='queued';return true;},
 cancel:async(id,owner)=>{const j=data.get(id);if(!j||j.owner!==owner||!['validating','planning','ready','queued'].includes(j.status))return false;j.status='cancelled';return true;},
 isCancelled:async(id,owner)=>data.get(id)?.owner===owner&&data.get(id)?.status==='cancelled'};
 const courses={resolve:async r=>{calls.push('resolve');if(r.orgUnitId==='999')throw Error('bad');return {orgUnitId:r.orgUnitId||'1',code:'001',name:'Course'};},get:async id=>({orgUnitId:id}),...options.courses};
 const discovery={discover:async org=>{const activities=['assignment','quiz','discussionTopic'].map((type,i)=>({type,id:String(i+1),parentId:'7',key:`${type}:${org}:${i+1}`,name:type}));return {complete:!options.partial,activities,nativeActivities:activities.map(a=>({key:a.key,data:{Id:a.id,QuizId:a.id,TopicId:a.id,ForumId:a.parentId}}))};},...options.discovery};
 const writer={updateActivityDates:async r=>{calls.push(r.dryRun?'preview':'write');if(!r.dryRun&&options.fail)return {status:'failed',error:{category:'API_FAILURE',httpStatus:options.fail}};return {status:r.dryRun?'ready':'updated',verifiedDates:{start:null,due:null,end:null},writeAttempted:!r.dryRun};},...options.writer};
 const jobs=createBulkJobs({store,courses,discovery,writers:{assignment:writer,quiz:writer,discussionTopic:writer},writeEnabled:()=>!options.noScope,now:()=>1000});
 return {jobs,data,calls,store,courses,discovery};
}
test('all course validation and discovery are read-only; confirmation executes only stored deduplicated plan',async()=>{
 const s=setup(),j=await s.jobs.create({owner:'a',csv:'OrgUnitId,OrgUnitCode\n1,\n,001\n2,',dates});
 await s.jobs.tick();const p=await s.jobs.get(j._id,'a');assert.equal(p.status,'ready');assert.equal(p.courses.length,2);assert.equal(p.tasks.length,6);assert.equal(p.rows[1].status,'duplicate');assert.ok(!s.calls.includes('write'));
 assert.equal(await s.jobs.confirm(j._id,'other'),false);assert.equal(await s.jobs.confirm(j._id,'a'),true);assert.equal(await s.jobs.confirm(j._id,'a'),false);
 await Promise.all([s.jobs.tick(),s.jobs.tick()]);assert.equal(s.calls.filter(c=>c==='write').length,6);assert.equal((await s.jobs.get(j._id,'a')).status,'completed');
});
test('invalid course, incomplete discovery and missing scopes cannot write',async()=>{
 for(const options of [{csv:'OrgUnitId,OrgUnitCode\n1,\n999,'},{partial:true},{noScope:true}]){
  const s=setup(options),j=await s.jobs.create({owner:'a',csv:options.csv||'OrgUnitId,OrgUnitCode\n1,',dates});await s.jobs.tick();await s.jobs.confirm(j._id,'a');await s.jobs.tick();
  assert.ok(!s.calls.includes('write'));assert.equal((await s.jobs.get(j._id,'a')).status,'failed');
 }
});
test('cancellation during course resolution drains lookups in flight and prevents further scheduling',async()=>{
 let started=0,release;const barrier=new Promise(resolve=>{release=resolve;});
 const s=setup({courses:{resolve:async row=>{started++;if(started===8)release();await new Promise(resolve=>setTimeout(resolve,0));return {orgUnitId:row.orgUnitId};}}});
 const j=await s.jobs.create({owner:'a',csv:'OrgUnitId,OrgUnitCode\n'+Array.from({length:40},(_,i)=>`${i+1},`).join('\n'),dates});
 const running=s.jobs.tick();await barrier;assert.equal(await s.jobs.cancel(j._id,'a'),true);await running;
 const saved=await s.jobs.get(j._id,'a');assert.equal(saved.status,'cancelled');assert.equal(started,8);assert.equal(saved.courses.length,8);assert.equal(saved.progress.processed,8);assert.equal(saved.tasks.length,0);
 assert.equal(s.calls.filter(call=>call==='write').length,0);assert.equal(await s.jobs.confirm(j._id,'a'),false);
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
 const s=setup({discovery:{discover:async org=>{started++;if(started===4)release();await new Promise(resolve=>setTimeout(resolve,0));const key=`quiz:${org}:1`;return {complete:true,activities:[{type:'quiz',id:'1',key,name:'Quiz'}],nativeActivities:[{key,data:{QuizId:'1'}}]};}}});
 const j=await s.jobs.create({owner:'a',csv:'OrgUnitId,OrgUnitCode\n'+Array.from({length:20},(_,i)=>`${i+1},`).join('\n'),dates});
 const running=s.jobs.tick();await entered;assert.equal(await s.jobs.cancel(j._id,'a'),true);await running;
 const saved=await s.jobs.get(j._id,'a');assert.equal(saved.status,'cancelled');assert.equal(started,4);assert.equal(saved.tasks.length,0);assert.equal(s.calls.filter(call=>call==='preview').length,0);assert.equal(s.calls.filter(call=>call==='write').length,0);
 assert.equal(saved.courses.filter(course=>course.counts?.quiz===1).length,4);
});
test('isolated errors continue; systemic errors stop remaining writes and retain results',async()=>{
 for(const code of [400,401,403,429,503]){
  const s=setup({fail:code}),j=await s.jobs.create({owner:'a',csv:'OrgUnitId,OrgUnitCode\n1,',dates});await s.jobs.tick();await s.jobs.confirm(j._id,'a');await s.jobs.tick();const r=await s.jobs.get(j._id,'a');
  assert.equal(r.status,'completedWithErrors');assert.equal(s.calls.filter(c=>c==='write').length,code===400?3:1);if(code!==400)assert.equal(r.totals.skipped,2);
 }
});
test('interruption retains confirmed successes and marks uncertain/unscheduled tasks',()=>{
 const j=interruptJob({tasks:[{result:{status:'updated'}},{result:{status:'running'}},{}]});
 assert.deepEqual(j.tasks.map(t=>t.result.status),['updated','failed','skipped']);assert.equal(j.tasks[1].result.error.category,'UNCERTAIN_OUTCOME');
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
 await jobs.tick();assert.equal(peak,4);peak=0;await jobs.confirm(j._id,'a');await jobs.tick();
 const result=await jobs.get(j._id,'a');assert.equal(peak,4);assert.equal(result.status,'completed');assert.equal(result.totals.updated,16);
});

test('date chunk snapshots cannot change while database writes are pending',async()=>{
 const {encodeDateJob}=require('../src/shared/dateChunks');const {createHash}=require('node:crypto');
 const job={_id:'snapshot',kind:'dates',rows:[{status:'pending'}],courses:[],tasks:[{result:{status:'running'}}]};const records=[];
 await encodeDateJob(job,{bulkWrite:async operations=>{job.tasks[0].result.status='updated';for(const op of operations){const {filter,update}=op.updateOne;records.push({key:filter._id,items:update.$setOnInsert.items});}}},'test');
 const task=records.find(r=>r.key.includes(':tasks:'));assert.equal(task.items[0].result.status,'running');assert.ok(task.key.endsWith(createHash('sha256').update(JSON.stringify(task.items)).digest('hex')));
});

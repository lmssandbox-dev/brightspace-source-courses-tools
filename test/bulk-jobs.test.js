'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createBulkJobs,interruptJob}=require('../src/shared/jobs');
const dates={start:'2027-01-01T00:00:00Z',due:'2027-01-02T00:00:00Z',end:'2027-01-03T00:00:00Z'};
function setup(options={}) {
 const data=new Map(),calls=[];let held=false;
 const store={insert:async j=>data.set(j._id,structuredClone(j)),get:async(id,owner)=>{const j=data.get(id);return j?.owner===owner?structuredClone(j):null;},list:async owner=>[...data.values()].filter(j=>j.owner===owner),
 acquire:async()=>{if(held)return false;held=true;return true;},renew:async()=>{},release:async()=>{held=false;},save:async j=>data.set(j._id,structuredClone(j)),
 claim:async()=>{const j=[...data.values()].find(j=>['queued','validating'].includes(j.status));if(!j)return null;j.status=j.status==='queued'?'running':'planning';return structuredClone(j);},
 confirm:async(id,owner,time)=>{const j=data.get(id);if(!j||j.owner!==owner||j.status!=='ready'||j.expiresAt<=time)return false;j.status='queued';return true;},cancel:async()=>false};
 const courses={resolve:async r=>{calls.push('resolve');if(r.orgUnitId==='999')throw Error('bad');return {orgUnitId:r.orgUnitId||'1',code:'001',name:'Course'};},get:async id=>({orgUnitId:id})};
 const discovery={discover:async org=>({complete:!options.partial,activities:['assignment','quiz','discussionTopic'].map((type,i)=>({type,id:String(i+1),parentId:'7',key:`${type}:${org}:${i+1}`,name:type}))})};
 const writer={updateActivityDates:async r=>{calls.push(r.dryRun?'preview':'write');if(!r.dryRun&&options.fail)return {status:'failed',error:{category:'API_FAILURE',httpStatus:options.fail}};return {status:r.dryRun?'ready':'updated',verifiedDates:{start:null,due:null,end:null},writeAttempted:!r.dryRun};}};
 const jobs=createBulkJobs({store,courses,discovery,writers:{assignment:writer,quiz:writer,discussionTopic:writer},writeEnabled:()=>!options.noScope,now:()=>1000});
 return {jobs,data,calls,store};
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
 const jobs=createBulkJobs({store:s.store,courses:{resolve:async r=>({orgUnitId:r.orgUnitId}),get:async id=>{await pause();validated.add(id);}},discovery:{discover:async()=>({complete:true,activities:[{type:'quiz',id:'1'},{type:'quiz',id:'2'}]})},writers:{quiz:writer},writeEnabled:()=>true});
 const j=await jobs.create({owner:'a',csv:'OrgUnitId,OrgUnitCode\n'+Array.from({length:8},(_,i)=>`${i+1},`).join('\n'),dates});
 await jobs.tick();assert.equal(peak,4);peak=0;await jobs.confirm(j._id,'a');await jobs.tick();
 const result=await jobs.get(j._id,'a');assert.equal(peak,4);assert.equal(result.status,'completed');assert.equal(result.totals.updated,16);
});

test('date chunk snapshots cannot change while database writes are pending',async()=>{
 const {encodeDateJob}=require('../src/shared/dateChunks');const {createHash}=require('node:crypto');
 const job={_id:'snapshot',kind:'dates',rows:[{status:'pending'}],courses:[],tasks:[{result:{status:'running'}}]};const records=[];
 await encodeDateJob(job,{updateOne:async(filter,update)=>{job.tasks[0].result.status='updated';records.push({key:filter._id,items:update.$setOnInsert.items});}},'test');
 const task=records.find(r=>r.key.includes(':tasks:'));assert.equal(task.items[0].result.status,'running');assert.ok(task.key.endsWith(createHash('sha256').update(JSON.stringify(task.items)).digest('hex')));
});

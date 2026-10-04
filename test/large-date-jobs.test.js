'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {encodeDateJob,decodeDateJob,DIRTY}=require('../src/shared/dateChunks');
const {setup}=require('./bulk-jobs.test');
const {createDateView}=require('../src/dates/view');
const {installDateUploadLimit}=require('../src/shared/uploadLimit');
const dates={start:'2027-01-01T00:00:00Z',due:'2027-01-02T00:00:00Z',end:'2027-01-03T00:00:00Z'};
function chunks(){const docs=new Map();return {docs,updateOne:async(q,u)=>{if(!docs.has(q._id))docs.set(q._id,{_id:q._id,...structuredClone(u.$setOnInsert)});},find:q=>({toArray:async()=>[...docs.values()].filter(d=>q._id.$in.includes(d._id)&&d.namespace===q.namespace&&d.jobId===q.jobId)})};}
test('large job exceeds old 8 MB cap, round-trips chunks and preserves old checkpoint after partial update',async()=>{
 const collection=chunks(),job={_id:'large',kind:'dates',rows:[],courses:[],tasks:Array.from({length:10000},(_,i)=>({id:i,name:'x'.repeat(1000)}))};
 assert.ok(Buffer.byteLength(JSON.stringify(job))>8*1024*1024);
 const first=await encodeDateJob(job,collection,'n');
 assert.ok(Buffer.byteLength(JSON.stringify(first))<1000000);
 assert.equal((await decodeDateJob(structuredClone(first),collection,'n')).tasks.length,10000);
 job.tasks[55].result={status:'updated'};job[DIRTY]={tasks:[55]};
 const second=await encodeDateJob(job,collection,'n',first.dateChunks);
 assert.equal(collection.docs.size,1001);
 assert.equal((await decodeDateJob(structuredClone(first),collection,'n')).tasks[55].result,undefined);
 assert.equal((await decodeDateJob(structuredClone(second),collection,'n')).tasks[55].result.status,'updated');
 await assert.rejects(()=>decodeDateJob(structuredClone(second),collection,'wrong'),/incomplete/);
});
test('resumed planning does not repeat resolved rows or duplicate partially previewed activities',async()=>{
 const s=setup(),j=await s.jobs.create({owner:'a',csv:'OrgUnitId,OrgUnitCode\n1,\n2,',dates});
 await s.jobs.tick();const saved=s.data.get(j._id);
 saved.status='validating';saved.courses[1].status='pending';saved.tasks=saved.tasks.slice(0,4);
 const before=s.calls.filter(c=>c==='preview').length;
 await s.jobs.tick();assert.equal(s.data.get(j._id).tasks.length,6);assert.equal(s.calls.filter(c=>c==='preview').length-before,2);
});
test('resumed execution skips saved successes and flags in-flight work instead of repeating it',async()=>{
 const s=setup(),j=await s.jobs.create({owner:'a',csv:'OrgUnitId,OrgUnitCode\n1,',dates});await s.jobs.tick();await s.jobs.confirm(j._id,'a');
 const saved=s.data.get(j._id);saved.tasks[0].result={status:'updated'};saved.tasks[1].result={status:'running'};
 await s.jobs.tick();const result=s.data.get(j._id);
 assert.equal(s.calls.filter(c=>c==='write').length,1);assert.equal(result.tasks[0].result.status,'updated');assert.equal(result.tasks[1].result.error.category,'UNCERTAIN_OUTCOME');assert.equal(result.status,'completedWithErrors');
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

'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createBulkStore}=require('../src/shared/store');
function setup({lost=false,duplicate=false,recover=[],failChunkWrite=false}={}){
 const calls=[];
 const collection=name=>({
  updateOne:async(filter,update)=>{calls.push({name,op:'updateOne',filter,update});return {matchedCount:lost?0:1,modifiedCount:1};},
  bulkWrite:async operations=>{calls.push({name,op:'bulkWrite',operations});if(failChunkWrite)throw Error('chunk write failed');},
  updateMany:async(filter,update)=>{calls.push({name,op:'updateMany',filter,update});},
  findOneAndUpdate:async(filter,update,options)=>{calls.push({name,op:'claim',filter,update,options});if(duplicate)throw {code:11000};return {value:name==='bulk_date_locks'?{worker:'w'}:{_id:'j',...update.$set}};},
  find:filter=>({toArray:async()=>recover}),findOne:async filter=>{calls.push({name,op:'get',filter});return null;},insertOne:async doc=>calls.push({name,op:'insert',doc})
 });
 const mongoClient={connect:async()=>{},db:()=>({collection}),close:async()=>{}};
 const store=createBulkStore({uri:'mongodb://localhost/brightspace_source_courses_tools',namespace:'n',mongoClient,now:()=>100});
 return {store,calls};
}
test('date job document is not published if a chunk batch fails',async()=>{
 const s=setup({failChunkWrite:true});
 await assert.rejects(()=>s.store.insert({_id:'date',kind:'dates',owner:'owner',rows:Array.from({length:11},(_,i)=>({row:i})),courses:[],tasks:[]}),/chunk write failed/);
 assert.equal(s.calls.filter(c=>c.name==='bulk_date_chunks'&&c.op==='bulkWrite').length,1);
 assert.equal(s.calls.some(c=>c.name==='bulk_date_jobs'&&c.op==='insert'),false);
});
test('Mongo confirmation is a single owner/status/expiry-guarded mutation',async()=>{
 const s=setup();await s.store.confirm('j','owner',100);
 assert.deepEqual(s.calls[0].filter,{_id:'j',owner:'owner',namespace:'n',status:'ready',expiresAt:{$gt:100}});
 assert.equal(s.calls[0].update.$set.status,'queued');
 await s.store.get('j','other');assert.equal(s.calls[1].filter.owner,'other');
});
test('Mongo lease contention and lease loss prevent worker persistence',async()=>{
 assert.equal(await setup({duplicate:true}).store.acquire('w'),false);
 const s=setup({lost:true});await assert.rejects(()=>s.store.save({_id:'j',status:'completed'},'w'));assert.equal(s.calls.length,1);assert.equal(s.calls[0].name,'bulk_date_locks');
});
test('Mongo recovery preserves saved successes and marks uncertain work without resuming',async()=>{
 const s=setup({recover:[{_id:'j',tasks:[{result:{status:'updated'}},{result:{status:'running'}},{}]}]});
 assert.equal(await s.store.acquire('w'),true);
 const recovery=s.calls.find(c=>c.name==='bulk_date_jobs'&&c.op==='updateOne');assert.equal(recovery.update.$set.status,'interrupted');
 assert.deepEqual(recovery.update.$set.tasks.map(t=>t.result.status),['updated','failed','skipped']);assert.equal(recovery.update.$set.worker,null);
});
test('Mongo save is fenced by worker and running state; no ltijs collections are touched',async()=>{
 const s=setup();await s.store.save({_id:'j',status:'ready',tasks:[]},'w');
 const saved=s.calls.find(c=>c.name==='bulk_date_jobs');assert.deepEqual(saved.filter,{_id:'j',namespace:'n',worker:'w',status:{$in:['planning','running']}});
 assert.ok(s.calls.every(c=>['bulk_date_jobs','bulk_date_locks'].includes(c.name)));
});

test('activation queues atomically for the owner and removes preview expiry',async()=>{
 const s=setup();await s.store.activate('j','owner',100);
 const c=s.calls[0];assert.equal(c.filter.owner,'owner');assert.equal(c.filter.kind,'sourceDeployment');assert.ok(!c.filter.status.$in.includes('queued'));assert.ok(!c.filter.status.$in.includes('activated'));
 assert.deepEqual(c.filter['tasks.targets.deactivation'],{$exists:true});assert.equal(c.update.$set.operation,'activate');assert.equal(c.update.$set.status,'queued');assert.deepEqual(c.update.$unset,{expiresAt:''});
});
test('activation jobs cannot be cancelled and leave inactive replicas untracked',async()=>{
 const s=setup();await s.store.cancel('j','owner');assert.deepEqual(s.calls[0].filter.operation,{$ne:'activate'});
});
test('Date Manager planning cancellation is owner-scoped and fenced checkpoints retain cancelled state',async()=>{
 const s=setup();await s.store.cancel('j','owner');const cancel=s.calls[0];assert.equal(cancel.filter.owner,'owner');assert.ok(cancel.filter.$or.some(condition=>condition.kind==='dates'&&condition.status==='planning'));
 s.calls.length=0;await s.store.save({_id:'j',kind:'dates',status:'cancelled',worker:'w',rows:[],courses:[],tasks:[]},'w');
 const save=s.calls.find(call=>call.name==='bulk_date_jobs');assert.deepEqual(save.filter.status,{$in:['planning','cancelled']});
});

test('chunked date recovery requeues checkpoints without rewriting tasks',async()=>{
 const s=setup({recover:[{_id:'p',kind:'dates',storageVersion:2,status:'planning'},{_id:'r',kind:'dates',storageVersion:2,status:'running'}]});
 await s.store.acquire('w');const changes=s.calls.filter(c=>c.name==='bulk_date_jobs'&&c.op==='updateOne');
 assert.deepEqual(changes.map(c=>c.update.$set.status),['validating','queued']);assert.ok(changes.every(c=>!Object.hasOwn(c.update.$set,'tasks')));
});
test('copy-check claims require explicit requests and saves are fenced by run and lease',async()=>{
 const s=setup();await s.store.claimCopyMonitor();
 const claim=s.calls.find(c=>c.op==='claim');assert.deepEqual(claim.filter['copyCheck.status'],{$in:['queued','running']});assert.equal(claim.filter.nextCopyCheckAt,undefined);
 await s.store.saveCopyMonitor({_id:'j',copyCheck:{runId:'run',leaseId:'lease',total:5000}}, {'101':{status:'Logs available',checkedAt:100}},0,100);
 const save=s.calls.find(c=>c.op==='updateOne');assert.equal(save.filter['copyCheck.runId'],'run');assert.equal(save.filter['copyCheck.leaseId'],'lease');assert.equal(save.update.$set['copyCheck.status'],'completed');assert.equal(save.update.$set['copyCheck.processed'],5000);assert.equal(save.update.$set.nextCopyCheckAt,undefined);
});
test('copy checks deduplicate pending requests and require ownership',async()=>{
 const job={_id:'j',owner:'owner',namespace:'n',kind:'sourceDeployment',status:'activated',tasks:[{targets:[{orgUnitId:'1'}],result:{status:'submitted'}}]};let mutations=0;
 const collection={findOne:async f=>f.owner===job.owner?job:null,updateOne:async(f,u)=>{mutations++;Object.assign(job,u.$set);return {modifiedCount:1};}};
 const store=createBulkStore({uri:'mongodb://localhost/brightspace_source_courses_tools',namespace:'n',mongoClient:{connect:async()=>{},db:()=>({collection:()=>collection})},now:()=>100});
 assert.equal(await store.requestCopyCheck('j','other'),false);
 assert.equal(await store.requestCopyCheck('j','owner'),true);const run=job.copyCheck.runId;
 assert.equal(await store.requestCopyCheck('j','owner'),true);assert.equal(mutations,1);assert.equal(job.copyCheck.runId,run);
 job.copyCheck.status='completed';assert.equal(await store.requestCopyCheck('j','owner'),true);assert.notEqual(job.copyCheck.runId,run);
});

test('native copy checks queue only pending tokens and preserve expiry-independent ownership guards',async()=>{
 const job={_id:'copy',kind:'courseCopy',owner:'owner',namespace:'n',status:'copiesInProcess',tasks:[{result:{status:'COMPLETE',jobToken:'done'}},{result:{status:'PENDING',jobToken:'pending'}}]};let writes=0;
 const collection={findOne:async f=>f.owner===job.owner&&f.kind===job.kind?job:null,updateOne:async(f,u)=>{assert.equal(f.owner,'owner');assert.equal(f.namespace,'n');assert.equal(f.status,job.status);assert.equal(u.$unset.expiresAt,'');writes++;Object.assign(job,u.$set);return {modifiedCount:1};}};
 const store=createBulkStore({uri:'mongodb://localhost/test_copy',namespace:'n',mongoClient:{connect:async()=>{},db:()=>({collection:()=>collection})}});
 assert.equal(await store.requestCopyCheck('copy','other'),false);
 assert.equal(await store.requestCopyCheck('copy','owner'),true);assert.equal(job.operation,'check');
 assert.equal(await store.requestCopyCheck('copy','owner'),true);assert.equal(writes,1);
 job.status='copiesConcluded';job.tasks[1].result.status='COMPLETE';assert.equal(await store.requestCopyCheck('copy','owner'),false);assert.equal(writes,1);
});

test('copy/deployment checkpoints persist only selected task paths with worker fencing',async()=>{
 const {DIRTY}=require('../src/shared/dateChunks');
 for(const kind of ['courseCopy','sourceDeployment']){
  const s=setup(),job={_id:'j',kind,status:'running',rows:Array.from({length:5000},()=>({code:'private'})),tasks:[{result:{status:'PENDING',jobToken:'keep'}},{result:{status:'uncertain'}}],courses:[],totals:{total:2}};
  job[DIRTY]={tasks:[1]};const saved=s.store.save(job,'w');job.tasks[1].result.status='changed after snapshot';await saved;
  const write=s.calls.find(c=>c.name==='bulk_date_jobs').update.$set;
  assert.equal(write.tasks,undefined);assert.equal(write.rows,undefined);assert.equal(write.courses,undefined);assert.equal(write['tasks.0'],undefined);assert.equal(write['tasks.1'].result.status,'uncertain');assert.ok(JSON.stringify(write).length<500);
 }
});

test('recent lease checks are shared, periodically renewed, and fail closed after lease loss',async()=>{
 let time=0,writes=0,allow=true;
 const collection={updateOne:async()=>{writes++;await Promise.resolve();return {matchedCount:allow?1:0};}};
 const store=createBulkStore({uri:'mongodb://localhost/test',namespace:'n',now:()=>time,mongoClient:{connect:async()=>{},db:()=>({collection:()=>collection})}});
 await Promise.all(Array.from({length:8},()=>store.renew('w')));assert.equal(writes,1);
 time=9999;await store.renew('w');assert.equal(writes,1);
 time=10000;await store.renew('w');assert.equal(writes,2);
 time=20000;allow=false;await assert.rejects(()=>store.renew('w'),/lease lost/);assert.equal(writes,3);
 allow=true;await assert.rejects(()=>store.renew('w'),/lease lost/);assert.equal(writes,3);
});
test('expired leases cannot be used from cache',async()=>{
 let time=0,writes=0;
 const store=createBulkStore({uri:'mongodb://localhost/test',namespace:'n',leaseMs:100,now:()=>time,mongoClient:{connect:async()=>{},db:()=>({collection:()=>({updateOne:async()=>({matchedCount:++writes===1?1:0})})})}});
 await store.renew('w');time=101;await assert.rejects(()=>store.renew('w'),/lease lost/);assert.equal(writes,2);
});

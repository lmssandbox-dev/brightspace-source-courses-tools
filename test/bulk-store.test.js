'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createBulkStore}=require('../src/shared/store');
function setup({lost=false,duplicate=false,recover=[]}={}){
 const calls=[];
 const collection=name=>({
  updateOne:async(filter,update)=>{calls.push({name,op:'updateOne',filter,update});return {matchedCount:lost?0:1,modifiedCount:1};},
  updateMany:async(filter,update)=>{calls.push({name,op:'updateMany',filter,update});},
  findOneAndUpdate:async(filter,update,options)=>{calls.push({name,op:'claim',filter,update,options});if(duplicate)throw {code:11000};return {value:name==='bulk_date_locks'?{worker:'w'}:{_id:'j',...update.$set}};},
  find:filter=>({toArray:async()=>recover}),findOne:async filter=>{calls.push({name,op:'get',filter});return null;},insertOne:async doc=>calls.push({name,op:'insert',doc})
 });
 const mongoClient={connect:async()=>{},db:()=>({collection}),close:async()=>{}};
 const store=createBulkStore({uri:'mongodb://localhost/brightspace_source_courses_tools',namespace:'n',mongoClient,now:()=>100});
 return {store,calls};
}
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

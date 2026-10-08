'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {parseArgs,makePlan,boundedDelete,BATCH}=require('../scripts/cleanup-date-jobs');
const {run}=require('../scripts/cleanup-date-jobs');

test('cleanup defaults to dry run and requires explicit flags for deletion',()=>{
 assert.deepEqual(parseArgs([]),{apply:false,allDateJobs:false});
 assert.deepEqual(parseArgs(['--dry-run']),{apply:false,allDateJobs:false});
 assert.deepEqual(parseArgs(['--apply']),{apply:true,allDateJobs:false});
 assert.throws(()=>parseArgs(['--all-date-jobs']),/requires --apply/);
 assert.throws(()=>parseArgs(['--apply','--dry-run']),/either/);
});
test('orphan cleanup retains chunks referenced by every retained namespace job',()=>{
 const jobs=[{_id:'a',kind:'dates',status:'completed',dateChunks:{tasks:['a1','a2']}},{_id:'b',kind:'dates',status:'ready',dateChunks:{tasks:['b1']}}];
 const chunks=['a1','a2','b1','orphan'].map(_id=>({_id,namespace:'tenant',jobId:_id[0],items:[{name:'a'}]}));
 const plan=makePlan(jobs,chunks);
 assert.deepEqual(plan.selected.map(c=>c._id),['orphan']);assert.equal(plan.retainedJobs,2);assert.equal(plan.candidateChunks,1);
});
test('complete historical cleanup selects terminal Date Manager jobs only and retains other workflows',()=>{
 const jobs=[{_id:'done',kind:'dates',status:'completed',dateChunks:{tasks:['donechunk']}},{_id:'old',status:'completedWithErrors',dateChunks:{tasks:['oldchunk']}},{_id:'ready',kind:'dates',status:'ready',dateChunks:{tasks:['readychunk']}}];
 const chunks=['donechunk','oldchunk','readychunk','orphan'].map(_id=>({_id,namespace:'n',jobId:_id.replace('chunk',''),items:[]}));
 const plan=makePlan(jobs,chunks,{allDateJobs:true});
 assert.deepEqual(plan.deletable.map(j=>j._id),['done','old']);assert.deepEqual(plan.selected.map(c=>c._id),['donechunk','oldchunk','orphan']);assert.equal(plan.retainedJobs,1);
});
test('cleanup refuses active workflows and preserves queued or resumable job references',()=>{
 for(const status of ['planning','running'])assert.throws(()=>makePlan([{_id:'active',kind:'dates',status}],[]),/active or pending/);
 const jobs=['validating','queued','ready','interrupted'].map(status=>({_id:status,kind:'dates',status,dateChunks:{tasks:[`${status}-chunk`]}}));
 const chunks=[...jobs.map(job=>({_id:`${job.status}-chunk`,namespace:'n',jobId:job._id,items:[]})),{_id:'queued-unpublished',namespace:'n',jobId:'queued',items:[]}];
 const plan=makePlan(jobs,chunks);assert.equal(plan.retainedJobs,4);assert.equal(plan.candidateChunks,0);assert.equal(plan.retainedChunks,5);
});
test('deletion operations stay bounded and repeat safely',async()=>{
 const batches=[];const collection={deleteMany:async filter=>{assert.ok(filter._id.$in.length<=BATCH);batches.push(filter._id.$in);return {deletedCount:filter._id.$in.length};}};
 const ids=Array.from({length:BATCH+3},(_,i)=>String(i));
 assert.equal(await boundedDelete(collection,{namespace:'n'},ids),ids.length);assert.deepEqual(batches.map(b=>b.length),[BATCH,3]);
 assert.equal(await boundedDelete({deleteMany:async()=>({deletedCount:0})},{namespace:'n'},[]),0);
});
test('default run scopes reads to its namespace and performs no deletion',async()=>{
 const namespace=createHash('sha256').update('https://tenant.example|d').digest('hex');
 const filters=[],deletes=[];const storedJobs=[{_id:'job',namespace,kind:'dates',status:'completed',dateChunks:{tasks:['ref']}}];
 const storedChunks=[{_id:'orphan',namespace,jobId:'job-old',items:[{x:1}]}];
 const collection=name=>({find:filter=>{filters.push([name,filter]);const rows=name==='bulk_date_jobs'?storedJobs:storedChunks;return {batchSize(size){assert.equal(size,BATCH);return this;},toArray:async()=>rows.filter(row=>row.namespace===filter.namespace)};},findOneAndUpdate:async(_f,u)=>({value:{worker:u.$set.worker}}),updateOne:async()=>({matchedCount:1}),countDocuments:async()=>0,deleteMany:async filter=>{deletes.push([name,filter]);return {deletedCount:0};}});
 const client={connect:async()=>{},db:()=>({collection}),close:async()=>{}};
 const result=await run({uri:'mongodb://localhost/app',baseUrl:'https://tenant.example',deploymentId:'d',client});
 assert.equal(result.mode,'dry-run');assert.equal(result.candidateChunks,1);assert.equal(deletes.length,0);assert.ok(filters.every(([,filter])=>filter.namespace===result.namespace));
});
test('explicit full cleanup deletes terminal Date Manager history and chunks idempotently',async()=>{
 const namespace=createHash('sha256').update('https://tenant.example|d').digest('hex');
 const docs={bulk_date_jobs:[{_id:'old',namespace,kind:'dates',status:'completed',dateChunks:{tasks:['oldchunk']}},{_id:'ready',namespace,kind:'dates',status:'ready',dateChunks:{tasks:['readychunk']}}],bulk_date_chunks:[{_id:'oldchunk',namespace,jobId:'old',items:[1]},{_id:'readychunk',namespace,jobId:'ready',items:[2]},{_id:'orphan',namespace,jobId:'retired',items:[3]}]};
 const collection=name=>({find:filter=>({batchSize(){return this;},toArray:async()=>docs[name].filter(row=>row.namespace===filter.namespace)}),findOneAndUpdate:async(_f,u)=>({value:{worker:u.$set.worker}}),updateOne:async()=>({matchedCount:1}),countDocuments:async()=>0,deleteMany:async filter=>{const before=docs[name].length;docs[name]=docs[name].filter(row=>!(row.namespace===filter.namespace&&filter._id.$in.includes(row._id)));return {deletedCount:before-docs[name].length};}});
 const client={connect:async()=>{},db:()=>({collection}),close:async()=>{}};
 const first=await run({uri:'mongodb://localhost/app',baseUrl:'https://tenant.example',deploymentId:'d',apply:true,allDateJobs:true,client});
 assert.equal(first.deletedJobs,1);assert.equal(first.deletedChunks,2);assert.deepEqual(docs.bulk_date_jobs.map(j=>j._id),['ready']);assert.deepEqual(docs.bulk_date_chunks.map(c=>c._id),['readychunk']);
 const second=await run({uri:'mongodb://localhost/app',baseUrl:'https://tenant.example',deploymentId:'d',apply:true,allDateJobs:true,client});assert.equal(second.deletedJobs,0);assert.equal(second.deletedChunks,0);
});

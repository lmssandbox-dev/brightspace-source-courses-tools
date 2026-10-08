'use strict';
require('dotenv').config();
const {randomUUID,createHash}=require('node:crypto');
const {MongoClient}=require('mongodb');
const {databaseConfig}=require('../src/shared/database');

const BATCH=250;
const LEASE_MS=60*1000;
const ACTIVE=new Set(['planning','running']);
const TERMINAL=new Set(['completed','completedWithErrors','failed','interrupted','cancelled']);
const RETAINED_CHUNK_OWNER=new Set(['validating','queued','ready','interrupted']);
function parseArgs(argv){
 const args=new Set(argv);
 for(const arg of args)if(!['--dry-run','--apply','--all-date-jobs'].includes(arg))throw Error(`Unknown option: ${arg}`);
 if(args.has('--dry-run')&&args.has('--apply'))throw Error('Choose either --dry-run or --apply.');
 if(args.has('--all-date-jobs')&&!args.has('--apply'))throw Error('--all-date-jobs requires --apply.');
 return {apply:args.has('--apply'),allDateJobs:args.has('--all-date-jobs')};
}
function dateFilter(job){return job.kind==='dates'||job.kind==null;}
function idsInRefs(job){return Object.values(job.dateChunks||{}).flat().filter(v=>typeof v==='string');}
function makePlan(jobs,chunks,{allDateJobs=false}={}){
 const active=jobs.filter(j=>ACTIVE.has(j.status));
 if(active.length)throw Error(`Cleanup aborted: ${active.length} active or pending bulk workflow(s) exist in this deployment namespace.`);
 const deletable=allDateJobs?jobs.filter(j=>dateFilter(j)&&TERMINAL.has(j.status)):[];
 const retained=jobs.filter(j=>!deletable.includes(j));
 const referenced=new Set(retained.flatMap(idsInRefs));
 const protectedJobIds=new Set(retained.filter(j=>RETAINED_CHUNK_OWNER.has(j.status)).map(j=>j._id));
 const candidates=chunks.filter(c=>c.namespace&&!protectedJobIds.has(c.jobId)&&!referenced.has(c._id));
 const selected=allDateJobs?chunks.filter(c=>deletable.some(j=>j._id===c.jobId)||candidates.some(orphan=>orphan._id===c._id)):candidates;
 const unique=[...new Map(selected.map(c=>[c._id,c])).values()];
 const selectedJobIds=new Set(deletable.map(j=>j._id));
 return {deletable,retained,selected:unique,retainedChunks:chunks.length-unique.length,
  jobBytes:deletable.reduce((n,j)=>n+Buffer.byteLength(JSON.stringify(j)),0),
  chunkBytes:unique.reduce((n,c)=>n+Buffer.byteLength(JSON.stringify(c)),0),
  candidateJobs:deletable.length,retainedJobs:retained.length,candidateChunks:unique.length,
  protectedChunks:chunks.filter(c=>selectedJobIds.has(c.jobId)&&!unique.some(x=>x._id===c._id)).length};
}
async function boundedDelete(collection,filter,ids,beforeBatch=async()=>{}){
 let deleted=0;
 for(let i=0;i<ids.length;i+=BATCH){await beforeBatch();const batch=ids.slice(i,i+BATCH);const result=await collection.deleteMany({...filter,_id:{$in:batch}});deleted+=result.deletedCount||0;}
 return deleted;
}
async function run({uri,baseUrl,deploymentId,apply=false,allDateJobs=false,client:providedClient,now=Date.now}={}){
 databaseConfig(uri);if(!baseUrl||!deploymentId)throw Error('BS_URL and BS_DEPLOYMENT_ID are required.');
 const namespace=createHash('sha256').update(`${baseUrl}|${deploymentId}`).digest('hex');
 const client=providedClient||new MongoClient(uri,{serverSelectionTimeoutMS:10000,socketTimeoutMS:15000});
 const ownsClient=!providedClient;let lockId,lockWorker;
 try{
  await client.connect();const db=client.db(),jobs=db.collection('bulk_date_jobs'),chunks=db.collection('bulk_date_chunks'),locks=db.collection('bulk_date_locks');
  const preliminary=await jobs.find({namespace},{projection:{_id:1,status:1}}).batchSize(BATCH).toArray();
  if(preliminary.some(j=>ACTIVE.has(j.status)))throw Error(`Cleanup aborted: ${preliminary.filter(j=>ACTIVE.has(j.status)).length} active or pending bulk workflow(s) exist in this deployment namespace.`);
  const worker=`maintenance:${randomUUID()}`;lockId=namespace;lockWorker=worker;
  try{const lock=await locks.findOneAndUpdate({_id:namespace,until:{$lte:now()}},{$set:{worker,until:now()+LEASE_MS,maintenance:true}},{upsert:true,returnDocument:'after'});if(lock.value?.worker!==worker)throw Error('Cleanup aborted: another bulk workflow or maintenance operation holds the namespace lease.');}
  catch(error){if(error.code===11000)throw Error('Cleanup aborted: another bulk workflow or maintenance operation holds the namespace lease.');throw error;}
  const savedJobs=await jobs.find({namespace},{projection:{_id:1,kind:1,status:1,dateChunks:1}}).batchSize(BATCH).toArray();
  const savedChunks=await chunks.find({namespace},{projection:{_id:1,namespace:1,jobId:1,items:1}}).batchSize(BATCH).toArray();
  const plan=makePlan(savedJobs,savedChunks,{allDateJobs});
  const renewMaintenance=async()=>{const result=await locks.updateOne({_id:namespace,worker,until:{$gt:now()}},{$set:{until:now()+LEASE_MS,maintenance:true}});if(!result.matchedCount)throw Error('Cleanup aborted: namespace maintenance lease was lost.');};
  const report={mode:apply?'apply':'dry-run',namespace,allDateJobs,candidateJobs:plan.candidateJobs,retainedJobs:plan.retainedJobs,candidateChunks:plan.candidateChunks,retainedChunks:plan.retainedChunks,deletedJobs:0,deletedChunks:0,estimatedLogicalBytes:plan.jobBytes+plan.chunkBytes,estimatedJobBytes:plan.jobBytes,estimatedChunkBytes:plan.chunkBytes,protectedChunks:plan.protectedChunks,batchSize:BATCH};
  if(apply){
   // Recheck under the exclusive namespace lease immediately before mutation.
   const active=await jobs.countDocuments({namespace,status:{$in:[...ACTIVE]}});if(active)throw Error(`Cleanup aborted: ${active} active or pending bulk workflow(s) appeared before deletion.`);
   await renewMaintenance();
   if(allDateJobs){const ids=plan.deletable.map(j=>j._id);for(let i=0;i<ids.length;i+=BATCH){await renewMaintenance();const r=await jobs.deleteMany({namespace,_id:{$in:ids.slice(i,i+BATCH)},status:{$in:[...TERMINAL]},$or:[{kind:'dates'},{kind:{$exists:false}}]});report.deletedJobs+=r.deletedCount||0;}}
   report.deletedChunks=await boundedDelete(chunks,{namespace},plan.selected.map(c=>c._id),renewMaintenance);
  }
  return report;
 }finally{if(lockId&&lockWorker){try{const db=client.db();await db.collection('bulk_date_locks').updateOne({_id:lockId,worker:lockWorker},{$set:{until:0},$unset:{maintenance:''}});}catch{}}if(ownsClient)await client.close();}
}
if(require.main===module){
 try{const options=parseArgs(process.argv.slice(2));run({uri:process.env.MONGODB_URL,baseUrl:process.env.BS_URL,deploymentId:process.env.BS_DEPLOYMENT_ID,...options}).then(r=>{console.table(r);console.log('Estimated logical JSON bytes only; this does not estimate physical Atlas storage reclaimed.');}).catch(e=>{console.error(e.message);process.exitCode=1;});}
 catch(e){console.error(e.message);process.exitCode=1;}
}
module.exports={parseArgs,makePlan,boundedDelete,run,BATCH};

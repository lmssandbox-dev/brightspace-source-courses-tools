'use strict';
const { MongoClient } = require('mongodb');
const {encodeDateJob,decodeDateJob,DIRTY,CHUNK_SIZE}=require('./dateChunks');
const { interruptJob } = require('./jobs');
const { databaseConfig } = require('./database');
// Dedicated application collections; ltijs collections are never accessed.
function createBulkStore({uri,namespace,now=Date.now,leaseMs=120000,mongoClient}) {
  databaseConfig(uri);
  const client=mongoClient || new MongoClient(uri,{serverSelectionTimeoutMS:10000,socketTimeoutMS:15000});
  let connected;
  async function collections() {
    if(!connected)connected=client.connect().catch(e=>{connected=null;throw e;});
    await connected;
    return {jobs:client.db().collection('bulk_date_jobs'),locks:client.db().collection('bulk_date_locks'),chunks:client.db().collection('bulk_date_chunks')};
  }
  return {
    async insert(job) {const {jobs,chunks}=await collections();const data=job.kind==='dates'?await encodeDateJob(job,chunks,namespace):job;await jobs.insertOne({...data,namespace});},
    async get(_id,owner) {const {jobs,chunks}=await collections();return decodeDateJob(await jobs.findOne({_id,owner,namespace}),chunks,namespace);},
    async list(owner,kind) {const {jobs}=await collections();return jobs.find({owner,namespace,...(kind==='sourceDeployment'?{kind}:kind==='dates'?{$or:[{kind:'dates'},{kind:{$exists:false}}]}:{})},{projection:{_id:1,status:1,createdAt:1,totals:1}}).sort({createdAt:-1}).limit(100).toArray();},
    async blocked(ids,excludeId) {
      const {jobs}=await collections();
      const pending=await jobs.find({namespace,_id:{$ne:excludeId},kind:'sourceDeployment',status:{$in:['submitted','submittedWithErrors','outcomeUnknown','interrupted','activationWithErrors','failed','queued','running']}}).toArray();
      return pending.some(job=>job.tasks.some(t=>(t.targets.some(r=>r.deactivation) || (t.result?.writeAttempted && !['failed','skipped'].includes(t.result.status))) && [t.sourceId,...t.targets.map(r=>r.orgUnitId)].some(id=>ids.includes(id))));
    },
    async review(_id,owner,time) {
      const {jobs}=await collections();return (await jobs.updateOne({_id,owner,namespace,kind:'sourceDeployment',status:{$in:['submitted','submittedWithErrors','outcomeUnknown','interrupted']}},{$set:{status:'reviewed',reviewedAt:time,message:'User acknowledged checking deployment outcomes in Brightspace. Submission results are retained; this is not automatic completion verification.'}})).modifiedCount===1;
    },
    async activate(_id,owner,time) {
      const {jobs}=await collections();
      return (await jobs.updateOne({_id,owner,namespace,kind:'sourceDeployment',status:{$in:['submitted','submittedWithErrors','outcomeUnknown','interrupted','failed','activationWithErrors']},'tasks.targets.deactivation':{$exists:true}},{$set:{status:'queued',operation:'activate',completionConfirmedAt:time,updatedAt:time},$unset:{expiresAt:''}})).modifiedCount===1;
    },
    async confirm(_id,owner,time) {
      const {jobs}=await collections();return (await jobs.updateOne({_id,owner,namespace,status:'ready',expiresAt:{$gt:time}},{$set:{status:'queued',confirmedAt:time}})).modifiedCount===1;
    },
    async cancel(_id,owner) {
      const {jobs}=await collections();return (await jobs.updateOne({_id,owner,namespace,operation:{$ne:'activate'},status:{$in:['validating','ready','queued']}},{$set:{status:'cancelled',updatedAt:now()}})).modifiedCount===1;
    },
    async acquire(worker) {
      const {locks,jobs}=await collections();let lock;
      try {lock=await locks.findOneAndUpdate({_id:namespace,until:{$lte:now()}},{$set:{worker,until:now()+leaseMs}},{upsert:true,returnDocument:'after'});}
      catch(e){if(e.code===11000)return false;throw e;}
      if(lock.value?.worker!==worker)return false;
      const interrupted=await jobs.find({namespace,status:{$in:['planning','running']}}).toArray();
      for(const job of interrupted) {
        if(job.storageVersion===2&&job.kind==='dates'){
          await jobs.updateOne({_id:job._id,namespace,status:job.status},{$set:{status:job.status==='planning'?'validating':'queued',worker:null,resuming:true,updatedAt:now(),message:'Resuming from the last saved checkpoint. In-flight writes will be flagged for review.'}});
          continue;
        }
        interruptJob(job);
        await jobs.updateOne({_id:job._id,namespace,status:{$in:['planning','running']}},{$set:{status:job.status,tasks:job.tasks,totals:job.totals,worker:null,updatedAt:now(),message:job.message}});
      }
      return true;
    },
    async renew(worker) {
      const {locks}=await collections();
      const r=await locks.updateOne({_id:namespace,worker,until:{$gt:now()}},{$set:{until:now()+leaseMs}});
      if(!r.matchedCount)throw new Error('Worker lease lost.');
    },
    async claim(worker) {
      const {jobs,chunks}=await collections();
      await jobs.updateMany({namespace,status:'queued',$or:[{storageVersion:{$ne:2}},{confirmedAt:{$exists:false}}],expiresAt:{$lte:now()}},{$set:{status:'failed',message:'Preview expired before execution. Create a new preview.'}});
      const queued=await jobs.findOneAndUpdate({namespace,status:'queued'},{$set:{status:'running',worker,updatedAt:now()}},{sort:{createdAt:1},returnDocument:'after'});
      if(queued.value)return decodeDateJob(queued.value,chunks,namespace);
      return decodeDateJob((await jobs.findOneAndUpdate({namespace,status:'validating'},{$set:{status:'planning',worker,updatedAt:now()}},{sort:{createdAt:1},returnDocument:'after'})).value,chunks,namespace);
    },
    async save(job,worker) {
      await this.renew(worker);
      if(job.kind!=='dates'&&Buffer.byteLength(JSON.stringify(job))>8*1024*1024)throw new Error('Job exceeds storage limit.');
      const {jobs,chunks}=await collections();
      const encoded=job.kind==='dates'?await encodeDateJob(job,chunks,namespace,job.dateChunks):job;
      await this.renew(worker);
      const {_id,...data}=encoded;
      if(encoded.storageVersion===2&&job[DIRTY]&&job.dateChunks){
        delete data.dateChunks;
        for(const [field,indices] of Object.entries(job[DIRTY]))for(const index of new Set(indices.map(i=>Math.floor(i/CHUNK_SIZE))))data[`dateChunks.${field}.${index}`]=encoded.dateChunks[field][index];
      }
      if(Buffer.byteLength(JSON.stringify(data))>8*1024*1024)throw new Error('Job metadata exceeds storage limit.');
      const r=await jobs.updateOne({_id,namespace,worker,status:{$in:['planning','running']}},{$set:data});
      if(!r.matchedCount)throw new Error('Job is no longer owned by this worker.');
      if(encoded.storageVersion===2){job.storageVersion=2;job.dateChunks=encoded.dateChunks;}
    },
    async release(worker) {const {locks}=await collections();await locks.updateOne({_id:namespace,worker},{$set:{until:0}});},
    async close(){await client.close();}
  };
}
module.exports={createBulkStore};

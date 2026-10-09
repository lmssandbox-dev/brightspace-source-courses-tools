'use strict';
const {randomUUID}=require('node:crypto');
const {targetStatus}=require('../replication/outcomes');
const { MongoClient } = require('mongodb');
const {reservesCourses}=require('../replication/outcomes');
const {encodeDateJob,decodeDateJob,DIRTY,CHUNK_SIZE}=require('./dateChunks');
const { interruptJob } = require('./jobs');
const { databaseConfig } = require('./database');
// Dedicated application collections; ltijs collections are never accessed.
function createBulkStore({uri,namespace,now=Date.now,leaseMs=120000,mongoClient}) {
  databaseConfig(uri);
  const client=mongoClient || new MongoClient(uri,{serverSelectionTimeoutMS:10000,socketTimeoutMS:15000});
  let connected;
  const leases=new Map();
  async function collections() {
    if(!connected)connected=client.connect().catch(e=>{connected=null;throw e;});
    await connected;
    return {jobs:client.db().collection('bulk_date_jobs'),locks:client.db().collection('bulk_date_locks'),chunks:client.db().collection('bulk_date_chunks')};
  }
  return {
    async insert(job) {const {jobs,chunks}=await collections();const data=job.kind==='dates'?await encodeDateJob(job,chunks,namespace):job;await jobs.insertOne({...data,namespace});},
    async get(_id,owner) {const {jobs,chunks}=await collections();return decodeDateJob(await jobs.findOne({_id,owner,namespace}),chunks,namespace);},
    async getStatus(_id,owner) {const {jobs}=await collections();return jobs.findOne({_id,owner,namespace},{projection:{_id:1,owner:1,kind:1,status:1,createdAt:1,updatedAt:1,dates:1,timeZone:1,courseTotal:1,totals:1,progress:1,step2StartedAt:1,step2ElapsedMs:1,step2ProgressAt:1,step2CourseProgressAt:1,step2RatePerMs:1,step2SampleAt:1,step2SampleProcessed:1,step2SamplePhase:1,step2SampleCount:1,step3StartedAt:1,step3ElapsedMs:1,step3ProgressAt:1,message:1,systemicFailure:1,expiresAt:1,confirmedAt:1,resuming:1}});},
    async savePlanningProgress(job,worker,fields) {
      await this.renew(worker);
      const {jobs}=await collections();
      const result=await jobs.updateOne({_id:job._id,namespace,worker,status:'planning'},{$set:{...fields,updatedAt:now()}});
      return result.matchedCount===1;
    },
    async list(owner,kind) {const {jobs}=await collections();return jobs.find({owner,namespace,...(['sourceDeployment','courseCopy'].includes(kind)?{kind}:kind==='dates'?{$or:[{kind:'dates'},{kind:{$exists:false}}]}:{})},{projection:{_id:1,status:1,createdAt:1,totals:1,copyMonitorCheckedAt:1,copyCheck:1,...(kind==='sourceDeployment'?{copySummary:{$let:{vars:{targets:{$reduce:{input:{$ifNull:['$tasks',[]]},initialValue:[],in:{$concatArrays:['$$value','$$this.targets']}}},monitors:{$objectToArray:{$ifNull:['$copyMonitor',{}]}}},in:{total:{$size:'$$targets'},copied:{$size:{$filter:{input:'$$targets',as:'target',cond:{$anyElementTrue:{$map:{input:'$$monitors',as:'monitor',in:{$and:[{$eq:['$$monitor.k','$$target.orgUnitId']},{$eq:['$$monitor.v.status','Copied successfully']}]}}}}}}}}}}}:{})}}).sort({createdAt:-1}).limit(100).toArray();},
    async blocked(ids,excludeId) {
      const {jobs}=await collections();
      const pending=await jobs.find({namespace,_id:{$ne:excludeId},kind:'sourceDeployment',status:{$in:['submitted','submittedWithErrors','outcomeUnknown','interrupted','activationWithErrors','failed','queued','running']}}).toArray();
      return pending.some(job=>job.tasks.some(t=>reservesCourses(t) && [t.sourceId,...t.targets.map(r=>r.orgUnitId)].some(id=>ids.includes(id))));
    },
    async requestCopyCheck(_id,owner){
      const {jobs}=await collections();
      const copy=await jobs.findOne({_id,owner,namespace,kind:'courseCopy'});
      if(copy?.kind==='courseCopy'){
        if(['queued','running'].includes(copy.status))return copy.operation==='check';
        if(!['copiesInProcess','copyNeedsAttention','interrupted'].includes(copy.status)||!copy.tasks.some(t=>t.result?.jobToken&&!['COMPLETE','COMPLETE_WITH_ERRORS','FAILED','CANCELLED'].includes(t.result.status)))return false;
        return (await jobs.updateOne({_id,owner,namespace,status:copy.status},{$set:{status:'queued',operation:'check'},$unset:{expiresAt:''}})).modifiedCount===1;
      }
      const job=await jobs.findOne({_id,owner,namespace,kind:'sourceDeployment'});
      if(!job||['queued','running','planning','validating'].includes(job.status))return false;
      if(['queued','running'].includes(job.copyCheck?.status))return true;
      const targetIds=job.tasks.flatMap(t=>t.targets.filter(r=>['submitted','uncertain'].includes(targetStatus(t,r))&&job.copyMonitor?.[r.orgUnitId]?.status!=='Copied successfully').map(r=>String(r.orgUnitId)));
      const total=targetIds.length;
      if(!total)return true;
      const result=await jobs.updateOne({_id,owner,namespace,status:job.status,'copyCheck.status':{$nin:['queued','running']}},{$set:{copyCheck:{runId:randomUUID(),status:'queued',requestedAt:now(),processed:0,total,targetIds},copyMonitorCursor:0},$unset:{nextCopyCheckAt:''}});
      return result.modifiedCount===1||Boolean(await jobs.findOne({_id,owner,namespace,'copyCheck.status':{$in:['queued','running']}}));
    },
    async claimCopyMonitor(){
      const {jobs}=await collections();
      return (await jobs.findOneAndUpdate({namespace,kind:'sourceDeployment',status:{$nin:['queued','running','planning','validating']},'copyCheck.status':{$in:['queued','running']},$or:[{'copyCheck.leaseUntil':{$exists:false}},{'copyCheck.leaseUntil':{$lte:now()}}]},{$set:{'copyCheck.status':'running','copyCheck.leaseUntil':now()+10*60*1000,'copyCheck.leaseId':randomUUID()}},{sort:{'copyCheck.lastBatchAt':1,'copyCheck.requestedAt':1},returnDocument:'after'})).value;
    },
    async renewCopyMonitor(job){
      const {jobs}=await collections();const r=await jobs.updateOne({_id:job._id,namespace,'copyCheck.runId':job.copyCheck.runId,'copyCheck.leaseId':job.copyCheck.leaseId,'copyCheck.status':'running'},{$set:{'copyCheck.leaseUntil':now()+10*60*1000}});
      if(r.matchedCount!==1)throw Error('Copy-check lease lost');
    },
    async nextCopySubmission(jobId,sourceId,targetId,since){
      const {jobs}=await collections();
      const newer=await jobs.find({namespace,kind:'sourceDeployment',_id:{$ne:jobId},tasks:{$elemMatch:{sourceId,submittedAt:{$gt:since},'targets.orgUnitId':targetId}}},{projection:{tasks:1}}).toArray();
      const times=newer.flatMap(j=>j.tasks.filter(t=>t.sourceId===sourceId&&t.submittedAt>since&&t.targets.some(r=>r.orgUnitId===targetId)).map(t=>t.submittedAt));
      return times.length?Math.min(...times):null;
    },
    async saveCopyMonitor(job,updates,cursor,time){
      const {jobs}=await collections();const done=cursor===0;
      const fields={copyMonitorCheckedAt:time,copyMonitorCursor:cursor,'copyCheck.processed':done?job.copyCheck.total:cursor,'copyCheck.status':done?'completed':'queued','copyCheck.lastBatchAt':time,'copyCheck.leaseUntil':0};
      if(done)fields['copyCheck.completedAt']=time;
      for(const [id,result] of Object.entries(updates))fields[`copyMonitor.${id}`]={...result,runId:job.copyCheck.runId};
      await jobs.updateOne({_id:job._id,namespace,'copyCheck.runId':job.copyCheck.runId,'copyCheck.leaseId':job.copyCheck.leaseId,status:{$nin:['queued','running','planning','validating']}},{$set:fields});
    },
    async review(_id,owner,time) {
      const {jobs}=await collections();return (await jobs.updateOne({_id,owner,namespace,kind:'sourceDeployment',status:{$in:['submitted','submittedWithErrors','outcomeUnknown','interrupted','failed','activationWithErrors']}},{$set:{status:'reviewed',reviewedAt:time,message:'User acknowledged checking deployment outcomes in Brightspace. Submission results are retained; this is not automatic completion verification.'}})).modifiedCount===1;
    },
    async activate(_id,owner,time) {
      const {jobs}=await collections();
      return (await jobs.updateOne({_id,owner,namespace,kind:'sourceDeployment',status:{$in:['submitted','submittedWithErrors','outcomeUnknown','interrupted','failed','activationWithErrors']},'tasks.targets.deactivation':{$exists:true}},{$set:{status:'queued',operation:'activate',reactivationRequestedAt:time,updatedAt:time},$unset:{expiresAt:''}})).modifiedCount===1;
    },
    async confirm(_id,owner,time) {
      const {jobs}=await collections();return (await jobs.updateOne({_id,owner,namespace,status:'ready',expiresAt:{$gt:time}},{$set:{status:'queued',confirmedAt:time}})).modifiedCount===1;
    },
    async cancel(_id,owner) {
      const {jobs}=await collections();return (await jobs.updateOne({_id,owner,namespace,operation:{$ne:'activate'}, $or:[{status:{$in:['validating','ready','queued']}},{kind:'dates',status:'planning'},{kind:'courseCopy',status:'planning'}]},{$set:{status:'cancelled',updatedAt:now()}})).modifiedCount===1;
    },
    async isCancelled(_id,owner) {const {jobs}=await collections();return Boolean(await jobs.findOne({_id,owner,namespace,status:'cancelled'},{projection:{_id:1}}));},
    async acquire(worker) {
      const {locks,jobs}=await collections();let lock;
      try {lock=await locks.findOneAndUpdate({_id:namespace,until:{$lte:now()}},{$set:{worker,until:now()+leaseMs}},{upsert:true,returnDocument:'after'});}
      catch(e){if(e.code===11000)return false;throw e;}
      if(lock.value?.worker!==worker)return false;
      leases.delete(worker);
      const interrupted=await jobs.find({namespace,status:{$in:['planning','running']}}).toArray();
      for(const job of interrupted) {
        // Only count the active segment through its last durable progress point. The
        // interval after that point may include process/lease downtime.
        const step3ElapsedMs=job.kind==='dates'?(Number(job.step3ElapsedMs)||0)+(Number.isFinite(job.step3StartedAt)&&Number.isFinite(job.step3ProgressAt)?Math.max(0,job.step3ProgressAt-job.step3StartedAt):0):undefined;
        const step2ElapsedMs=job.kind==='dates'?(Number(job.step2ElapsedMs)||0)+(Number.isFinite(job.step2StartedAt)&&Number.isFinite(job.step2ProgressAt)?Math.max(0,job.step2ProgressAt-job.step2StartedAt):0):undefined;
        const recoveredProgress=job.kind==='dates'?(job.step2DurableProgress||{phase:'Resolving courses',processed:0,total:job.progress?.total||0}):undefined;
        if(job.storageVersion===2&&job.kind==='dates'){
          await jobs.updateOne({_id:job._id,namespace,status:job.status},{$set:{status:job.status==='planning'?'validating':'queued',worker:null,resuming:true,updatedAt:now(),step2ElapsedMs,step2StartedAt:null,step2ProgressAt:null,step2CourseProgressAt:null,progress:recoveredProgress,step2SampleAt:null,step2SampleCount:0,step2RatePerMs:0,step3ElapsedMs,step3StartedAt:null,message:'Resuming from the last saved checkpoint. In-flight writes will be flagged for review.'}});
          continue;
        }
        if(job.kind==='dates'){
          const wasPlanning=job.status==='planning';
          interruptJob(job);
          job.status=wasPlanning?'validating':'queued';job.resuming=true;job.message='Resuming from the last saved checkpoint. In-flight writes require read-only reconciliation.';
          await jobs.updateOne({_id:job._id,namespace,status:{$in:['planning','running']}},{$set:{status:job.status,tasks:job.tasks,totals:job.totals,worker:null,updatedAt:now(),step2ElapsedMs,step2StartedAt:null,step2ProgressAt:null,step2CourseProgressAt:null,progress:recoveredProgress,step2SampleAt:null,step2SampleCount:0,step2RatePerMs:0,step3ElapsedMs,step3StartedAt:null,message:job.message,resuming:true}});
          continue;
        }
        interruptJob(job);
        await jobs.updateOne({_id:job._id,namespace,status:{$in:['planning','running']}},{$set:{status:job.status,tasks:job.tasks,totals:job.totals,worker:null,updatedAt:now(),message:job.message}});
      }
      return true;
    },
    async renew(worker) {
      let lease=leases.get(worker);
      if(lease?.failed)throw lease.failed;
      if(lease?.pending)return lease.pending;
      // Only reuse a recently confirmed, unexpired lease. Heartbeats still renew it.
      if(lease&&now()-lease.confirmedAt<Math.min(10000,leaseMs/4)&&now()<lease.until)return;
      lease ||= {};leases.set(worker,lease);
      const started=now();
      lease.pending=(async()=>{
        try {
          const {locks}=await collections();
          const r=await locks.updateOne({_id:namespace,worker,until:{$gt:now()}},{$set:{until:started+leaseMs}});
          if(!r.matchedCount)throw new Error('Worker lease lost.');
          lease.confirmedAt=started;lease.until=started+leaseMs;
        }catch(error){lease.failed=error;throw error;}
        finally{lease.pending=null;}
      })();
      return lease.pending;
    },
    async claim(worker) {
      const {jobs,chunks}=await collections();
      await jobs.updateMany({namespace,status:'queued',$or:[{storageVersion:{$ne:2}},{confirmedAt:{$exists:false}}],expiresAt:{$lte:now()}},{$set:{status:'failed',message:'Preview expired before execution. Create a new preview.'}});
      const queued=await jobs.findOneAndUpdate({namespace,status:'queued'},{$set:{status:'running',worker,updatedAt:now()}},{sort:{createdAt:1},returnDocument:'after'});
      if(queued.value)return decodeDateJob(queued.value,chunks,namespace);
      return decodeDateJob((await jobs.findOneAndUpdate({namespace,status:'validating'},{$set:{status:'planning',worker,updatedAt:now()}},{sort:{createdAt:1},returnDocument:'after'})).value,chunks,namespace);
    },
    async save(job,worker) {
      const dirty=job[DIRTY];
      let snapshot=job;
      if(job.kind!=='dates'&&dirty){
        const {rows,tasks,courses,...metadata}=job;snapshot=JSON.parse(JSON.stringify(metadata));
        for(const field of ['rows','tasks','courses'])for(const index of dirty[field]||[])snapshot[`${field}.${index}`]=JSON.parse(JSON.stringify(job[field][index]));
      }
      await this.renew(worker);
      if(job.kind!=='dates'&&Buffer.byteLength(JSON.stringify(snapshot))>8*1024*1024)throw new Error('Job exceeds storage limit.');
      const {jobs,chunks}=await collections();
      const encoded=job.kind==='dates'?await encodeDateJob(job,chunks,namespace,job.dateChunks):snapshot;
      await this.renew(worker);
      const {_id,...data}=encoded;
      if(encoded.storageVersion===2&&job[DIRTY]&&job.dateChunks){
        delete data.dateChunks;
        for(const [field,indices] of Object.entries(job[DIRTY]))for(const index of new Set(indices.map(i=>Math.floor(i/CHUNK_SIZE))))data[`dateChunks.${field}.${index}`]=encoded.dateChunks[field][index];
      }
      if(Buffer.byteLength(JSON.stringify(data))>8*1024*1024)throw new Error('Job metadata exceeds storage limit.');
      const statuses=job.kind==='dates'&&job.status==='cancelled'?{$in:['planning','cancelled']}:{$in:['planning','running']};
      const r=await jobs.updateOne({_id,namespace,worker,status:statuses},{$set:data});
      if(!r.matchedCount)throw new Error('Job is no longer owned by this worker.');
      if(encoded.storageVersion===2){job.storageVersion=2;job.dateChunks=encoded.dateChunks;}
    },
    async release(worker) {leases.delete(worker);const {locks}=await collections();await locks.updateOne({_id:namespace,worker},{$set:{until:0}});},
    async close(){await client.close();}
  };
}
module.exports={createBulkStore};

'use strict';
const {parse}=require('csv-parse/sync');
const {id}=require('../shared/id');
const {canActivateTarget,targetStatus}=require('./outcomes');
const invalid=message=>Object.assign(new Error(message),{code:'INVALID_CSV'});
function parseDeploymentCsv(text){
 if(typeof text!=='string'||Buffer.byteLength(text)>5*1024*1024)throw invalid('Use a UTF-8 CSV of at most 5 MB.');
 let records;try{records=parse(text,{bom:true,trim:true,info:true,relax_column_count:true});}catch{throw invalid('Malformed CSV.');}
 const header=records.shift()?.record;
 if(!header||header.length!==2||!header.includes('SourceOrgUnitId')||!header.includes('ReplicaOrgUnitId'))throw invalid('Headers must be SourceOrgUnitId,ReplicaOrgUnitId.');
 if(records.length>10000)throw invalid('At most 10,000 mappings are supported.');
 const targets=new Map();
 const rows=records.map(({record,info})=>{
  const row={row:info.lines,status:'pending'};
  if(record.every(x=>!x.trim()))return {...row,status:'ignored',message:'Blank row ignored.'};
  try{if(record.length!==2)throw Error();row.sourceId=id(record[header.indexOf('SourceOrgUnitId')]);row.targetId=id(record[header.indexOf('ReplicaOrgUnitId')]);if(row.sourceId===row.targetId||!Number.isSafeInteger(Number(row.targetId)))throw Error();}
  catch{return {...row,status:'invalid',message:'Supply two positive IDs; source and replica must differ.'};}
  const previous=targets.get(row.targetId);
  if(previous){if(previous.sourceId===row.sourceId)return {...row,status:'duplicate',message:`Duplicate of row ${previous.row}; deployed once.`};previous.status='invalid';previous.message='Replica is assigned to different sources.';return {...row,status:'invalid',message:previous.message};}
  targets.set(row.targetId,row);return row;
 });
 const sources=new Set(rows.map(r=>r.sourceId).filter(Boolean));
 for(const row of rows)if(sources.has(row.targetId)){row.status='invalid';row.message='A source in this file cannot also be a deployment target.';}
 if(!rows.some(r=>r.status!=='ignored'))throw invalid('CSV contains no mappings.');
 return rows;
}
function createDeploymentJobs({client,enabled,now=Date.now}){
 return {
  parse:parseDeploymentCsv,
  async plan(job,save){
   const sources=new Map();
   for(const row of job.rows){
    if(row.status!=='pending')continue;
    try{
     if(!sources.has(row.sourceId))sources.set(row.sourceId,await client.source(row.sourceId));
     const target=await client.target(row.targetId),source=sources.get(row.sourceId);
     row.sourceName=source.name;row.targetName=target.name;row.status='valid';if(source.warning)row.message=source.warning;
     let task=job.tasks.find(t=>t.sourceId===row.sourceId&&t.targets.length<100);
     if(!task){task={sourceId:row.sourceId,sourceName:source.name,targets:[],preview:{status:'ready'}};job.tasks.push(task);}
     task.targets.push(target);
    }catch(error){row.status='invalid';row.message=error.code==='REPLICATION_VALIDATION'?error.message:'Source or replica lookup failed. Check the configured IDs, API connectivity and read permissions.';}
    await save(job);
   }
   job.status=job.rows.some(r=>r.status==='invalid')||!job.tasks.length?'failed':'ready';job.expiresAt=now()+30*60*1000;
  },
  async activate(job,save,renew){
   if(!enabled()){job.status='activationWithErrors';job.message='Required deployment/course update scopes are unavailable.';return;}
   for(const task of job.tasks)for(const target of task.targets.filter(r=>canActivateTarget(task,r)&&!['updated','unchanged'].includes(r.activation?.status))){
    target.activation={status:'running',writeAttempted:false};await save(job);
    target.activation=await client.setActive(target.orgUnitId,true,async()=>{await renew();target.activation.writeAttempted=true;await save(job);});
    await save(job);
   }
   job.status=job.tasks.every(t=>t.targets.every(r=>canActivateTarget(t,r)&&['updated','unchanged'].includes(r.activation?.status)))?'activated':'activationWithErrors';
   job.message=job.status==='activated'?'All replicas verified active. Copy completion was confirmed manually by the user.':'Some replicas were excluded from activation or could not be verified active. Inspect the per-replica results; eligible activation can be retried without deploying again.';
  },
  async execute(job,save,renew){
   if(!enabled()){job.status='failed';job.message='Configure manageCourses:deploy:manage and orgunits:course:update before deploying.';return;}
   job.automaticReactivation=true;
   let halted=false,serviceFailures=0;
   const recordFailure=error=>{
    const status=error?.httpStatus??error?.status??error?.response?.status;
    const service=status==null||status===403||status>=500;
    serviceFailures=service?serviceFailures+1:0;
    if(status===401||status===429||serviceFailures>=3)halted=true;
   };
   const notSent=(task,message)=>({status:'failed',writeAttempted:false,error:{message},targets:task.targets.map(t=>({orgUnitId:t.orgUnitId,status:'notAttempted'}))});
   for(const task of job.tasks){
    if(halted){task.result={...notSent(task,'Not attempted because processing stopped after a system-wide problem.'),status:'skipped'};await save(job);continue;}
    // Validate only this batch before touching its replicas.
    try{await client.source(task.sourceId);for(const target of task.targets)await client.target(target.orgUnitId);}
    catch(error){recordFailure(error);task.result=notSent(task,'Batch validation failed. No deployment was sent; review the source and replica access.');await save(job);continue;}
    let preparationFailed=false;
    for(const target of task.targets){
     target.deactivation={status:'running',writeAttempted:false};await save(job);
     target.deactivation=await client.setActive(target.orgUnitId,false,async()=>{await renew();target.deactivation.writeAttempted=true;await save(job);});
     await save(job);
     if(!['updated','unchanged'].includes(target.deactivation.status)||target.deactivation.verifiedActive!==false){
      recordFailure(target.deactivation.error);preparationFailed=true;break;
     }
    }
    if(preparationFailed){task.result=notSent(task,'Batch preparation failed. No deployment was sent. Some replicas may be inactive; inspect preparation results.');await save(job);continue;}
    try{for(const target of task.targets)if((await client.target(target.orgUnitId)).isActive!==false)throw {httpStatus:409};}
    catch(error){recordFailure(error);task.result=notSent(task,'Replica inactivity could not be confirmed. No deployment was sent for this batch.');await save(job);continue;}
    task.submittedAt=now();
    task.result={status:'running',writeAttempted:false};await save(job);
    task.result=await client.deploy(task.sourceId,task.targets.map(t=>t.orgUnitId),async()=>{await renew();task.result.writeAttempted=true;await save(job);});
    await save(job);
    // Reactivation follows acceptance, not completion of the asynchronous copy.
    for(const target of task.targets){
     if(targetStatus(task,target)!=='submitted')continue;
     target.activation={status:'running',writeAttempted:false};await save(job);
     target.activation=await client.setActive(target.orgUnitId,true,async()=>{await renew();target.activation.writeAttempted=true;await save(job);});
     await save(job);
    }
    if(task.result.status==='submitted')serviceFailures=0;
    else if(task.result.status==='submittedWithErrors')serviceFailures=0;
    else recordFailure(task.result.error);
    await save(job);
   }
   const outcomes=job.tasks.flatMap(t=>t.result?.targets||t.targets.map(r=>({orgUnitId:r.orgUnitId,status:t.result?.status==='submitted'?'submitted':t.result?.status==='uncertain'?'uncertain':'notAttempted'})));
   job.status=outcomes.some(r=>r.status==='uncertain')?'outcomeUnknown':outcomes.every(r=>r.status==='submitted')?'submitted':outcomes.some(r=>r.status==='submitted')?'submittedWithErrors':'failed';
   job.reactivationFinishedAt=now();
   if(outcomes.every(r=>r.status==='submitted'))job.status=job.tasks.every(t=>t.targets.every(r=>['updated','unchanged'].includes(r.activation?.status)))?'activated':'activationWithErrors';
   job.message=(halted?'Processing stopped after an authentication failure, exhausted rate-limit retries, or three consecutive service failures. ':'')+'Submission results are recorded. Accepted replicas were automatically reactivated where possible. Copy completion is separate and is not confirmed by activation. Failed or uncertain deployments are never automatically resubmitted. Download the report for failed and not-attempted replicas, including any left inactive during preparation.';

  }
 };
}
module.exports={createDeploymentJobs,parseDeploymentCsv};

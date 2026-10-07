'use strict';
const {parse}=require('csv-parse/sync');
const {id}=require('../shared/id');
const {pool}=require('../shared/pool');
const {canActivateTarget,targetStatus}=require('./outcomes');
const invalid=message=>Object.assign(new Error(message),{code:'INVALID_CSV'});
function parseDeploymentCsv(text){
 if(typeof text!=='string'||Buffer.byteLength(text)>5*1024*1024)throw invalid('Use a UTF-8 CSV of at most 5 MB.');
 let records;try{records=parse(text,{bom:true,trim:true,info:true,relax_column_count:true});}catch{throw invalid('Malformed CSV.');}
 const header=records.shift()?.record;
 const extended=['SourceOrgUnitId','SourceOrgUnitCode','ReplicaOrgUnitId','ReplicaOrgUnitCode'];
 const modern=header?.length===4&&extended.every(h=>header.includes(h));
 if(!modern)throw invalid('Headers must be SourceOrgUnitId,SourceOrgUnitCode,ReplicaOrgUnitId,ReplicaOrgUnitCode.');
 if(records.length>10000)throw invalid('At most 10,000 mappings are supported.');
 const targets=new Map();
 const rows=records.map(({record,info})=>{
  const row={row:info.lines,status:'pending'};
  if(record.every(x=>!x.trim()))return {...row,status:'ignored',message:'Blank row ignored.'};
  try{
   if(record.length!==header.length)throw Error();
   const value=name=>record[header.indexOf(name)]||'';
   row.sourceId=value('SourceOrgUnitId')?id(value('SourceOrgUnitId')):undefined;
   row.targetId=value('ReplicaOrgUnitId')?id(value('ReplicaOrgUnitId')):undefined;
   row.sourceCode=value('SourceOrgUnitCode');row.targetCode=value('ReplicaOrgUnitCode');
   if((!row.sourceId&&!row.sourceCode)||(!row.targetId&&!row.targetCode)||(row.sourceId&&row.sourceId===row.targetId)||(row.targetId&&!Number.isSafeInteger(Number(row.targetId))))throw Error();
  }catch{return {...row,status:'invalid',message:'Provide an ID or code for each source and replica; source and replica must differ.'};}
  if(row.sourceCode||row.targetCode||!row.sourceId||!row.targetId)return row; // Resolve aliases before checking duplicate/conflicting mappings.
  const previous=targets.get(row.targetId);
  if(previous){if(previous.sourceId===row.sourceId)return {...row,status:'duplicate',message:`Duplicate of row ${previous.row}; deployed once.`};previous.status='invalid';previous.message='Replica is assigned to different sources.';return {...row,status:'invalid',message:previous.message};}
  targets.set(row.targetId,row);return row;
 });
 const sources=new Set(rows.map(r=>r.sourceId).filter(Boolean));
 for(const row of rows)if(sources.has(row.targetId)){row.status='invalid';row.message='A source in this file cannot also be a deployment target.';}
 if(!rows.some(r=>r.status!=='ignored'))throw invalid('CSV contains no mappings.');
 return rows;
}
function createDeploymentJobs({client,enabled,resolveCode,orgResolver,now=Date.now}){
 return {
  parse:parseDeploymentCsv,
  async plan(job,save){
   const session=orgResolver?await orgResolver.prepare(job.rows.filter(r=>r.status==='pending').flatMap(r=>[r.sourceCode,r.targetCode])):null;
   const codes=new Map(),resolved=new Map();
   let processed=job.rows.filter(row=>row.status!=='pending').length;
   const cached=(map,key,load)=>{if(!map.has(key))map.set(key,Promise.resolve().then(load));return map.get(key);};
   await pool(job.rows,8,async row=>{
    if(row.status!=='pending')return;
    try{
     for(const [idField,codeField] of [['sourceId','sourceCode'],['targetId','targetCode']])if(row[codeField]){
      if(!resolveCode&&!session)throw Error('Code lookup unavailable');
      const value=await cached(codes,row[codeField],()=>session?session.resolve(row[codeField]).then(r=>r.Identifier):resolveCode(row[codeField]));
      if(row[idField]&&row[idField]!==value)throw Error('ID/code mismatch');row[idField]=value;
     }
     if(row.sourceId===row.targetId)throw Error('Source and replica must differ');
     const source={orgUnitId:row.sourceId,name:''};
     const target={orgUnitId:row.targetId,name:''};
     row.sourceName=source.name;row.targetName=target.name;row.status='valid';if(source.warning)row.message=source.warning;
     resolved.set(row,{source,target});
    }catch(error){row.status='invalid';row.message=error.code==='REPLICATION_VALIDATION'?error.message:'Source or replica lookup failed. Check IDs and codes match, codes are unique, and API access is permitted.';}
    job.progress={phase:'mappings',processed:++processed,total:job.rows.length};
    if(processed%25===0)await save(job);
   });
   const targets=new Map(),batches=new Map();
   for(const row of job.rows){
    if(row.status!=='valid')continue;
    const previous=targets.get(row.targetId);
    if(previous){
     if(previous.sourceId===row.sourceId){row.status='duplicate';row.message=`Duplicate of row ${previous.row}; deployed once.`;}
     else {previous.status=row.status='invalid';previous.message=row.message='Replica is assigned to different sources.';}
     continue;
    }
    targets.set(row.targetId,row);
    const {source,target}=resolved.get(row);
    let task=batches.get(row.sourceId);
    if(!task||task.targets.length>=100){task={sourceId:row.sourceId,sourceName:source.name,targets:[],preview:{status:'ready'}};batches.set(row.sourceId,task);job.tasks.push(task);}
    task.targets.push({...target});
   }
   const resolvedSources=new Set(job.rows.filter(r=>r.status==='valid').map(r=>r.sourceId)),resolvedTargets=new Set(job.rows.filter(r=>r.status==='valid').map(r=>r.targetId));
   for(const row of job.rows)if(row.status==='valid'&&(resolvedSources.has(row.targetId)||resolvedTargets.has(row.sourceId))){row.status='invalid';row.message='A source in this file cannot also be a deployment target.';}
   const eligible=new Set(job.rows.filter(r=>r.status==='valid').map(r=>`${r.sourceId}:${r.targetId}`));
   for(const task of job.tasks)task.targets=task.targets.filter(t=>eligible.has(`${task.sourceId}:${t.orgUnitId}`));
   job.tasks=job.tasks.filter(t=>t.targets.length);
   job.status=!job.tasks.length?'failed':'ready';job.expiresAt=now()+30*60*1000;
  },
  async activate(job,save,renew){
   if(!enabled()){job.status='activationWithErrors';job.message='Required deployment/course update scopes are unavailable.';return;}
   for(const [index,task] of job.tasks.entries()){
    const checkpoint=()=>save(job,{tasks:[index]});
    for(const target of task.targets.filter(r=>canActivateTarget(task,r)&&!['updated','unchanged'].includes(r.activation?.status))){
     target.activation={status:'running',writeAttempted:false};await checkpoint();
     target.activation=await client.setActive(target.orgUnitId,true,async()=>{await renew();target.activation.writeAttempted=true;await checkpoint();});
     await checkpoint();
    }
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
   const groups=new Map();
   job.tasks.forEach((task,index)=>{const group=groups.get(task.sourceId)||[];group.push({task,index});groups.set(task.sourceId,group);});
   async function submit(task,index){
    const checkpoint=()=>save(job,{tasks:[index]});
    if(task.result)return;
    if(halted){task.result={...notSent(task,'Not attempted because processing stopped after a system-wide problem.'),status:'skipped'};await checkpoint();return;}
    let preparationFailed=false;
    for(const target of task.targets){
     target.deactivation={status:'running',writeAttempted:false};await checkpoint();
     target.deactivation=await client.setActive(target.orgUnitId,false,async()=>{await renew();target.deactivation.writeAttempted=true;await checkpoint();});
     await checkpoint();
     if(!['updated','unchanged'].includes(target.deactivation.status)||target.deactivation.verifiedActive!==false){
      recordFailure(target.deactivation.error);preparationFailed=true;break;
     }
    }
    if(preparationFailed){task.result=notSent(task,'Batch preparation failed. No deployment was sent. Some replicas may be inactive; inspect preparation results.');await checkpoint();return;}
    task.submittedAt=now();
    task.result={status:'running',writeAttempted:false};await checkpoint();
    task.result=await client.deploy(task.sourceId,task.targets.map(t=>t.orgUnitId),async()=>{await renew();task.result.writeAttempted=true;await checkpoint();});
    await checkpoint();
    // Reactivation follows acceptance, not completion of the asynchronous copy.
    for(const target of task.targets){
     if(targetStatus(task,target)!=='submitted')continue;
     target.activation={status:'running',writeAttempted:false};await checkpoint();
     target.activation=await client.setActive(target.orgUnitId,true,async()=>{await renew();target.activation.writeAttempted=true;await checkpoint();});
     await checkpoint();
    }
    if(task.result.status==='submitted')serviceFailures=0;
    else if(task.result.status==='submittedWithErrors')serviceFailures=0;
    else recordFailure(task.result.error);
    // Submission and each activation result were already checkpointed above.
   }
   await pool([...groups.values()],8,async(group,_index,stopped)=>{for(const {task,index} of group){if(stopped())return;await submit(task,index);}});
   const outcomes=job.tasks.flatMap(t=>t.result?.targets||t.targets.map(r=>({orgUnitId:r.orgUnitId,status:t.result?.status==='submitted'?'submitted':t.result?.status==='uncertain'?'uncertain':'notAttempted'})));
   job.status=outcomes.some(r=>r.status==='uncertain')?'outcomeUnknown':outcomes.every(r=>r.status==='submitted')?'submitted':outcomes.some(r=>r.status==='submitted')?'submittedWithErrors':'failed';
   job.reactivationFinishedAt=now();
   if(outcomes.every(r=>r.status==='submitted'))job.status=job.tasks.every(t=>t.targets.every(r=>['updated','unchanged'].includes(r.activation?.status)))?'activated':'activationWithErrors';
   job.message=(halted?'Processing stopped after an authentication failure, exhausted rate-limit retries, or three consecutive service failures. ':'')+'Submission results are recorded. Accepted replicas were automatically reactivated where possible. Copy completion is separate and is not confirmed by activation. Failed or uncertain deployments are never automatically resubmitted. Download the report for failed and not-attempted replicas, including any left inactive during preparation.';

  }
 };
}
module.exports={createDeploymentJobs,parseDeploymentCsv};

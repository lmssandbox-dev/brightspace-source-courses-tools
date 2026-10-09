'use strict';

const {targetStatus}=require('./outcomes');
const duration=milliseconds=>{const seconds=Math.max(0,Math.floor(milliseconds/1000)),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60),remainder=seconds%60;return hours?`${hours}h ${minutes}m ${remainder}s`:minutes?`${minutes}m ${remainder}s`:`${remainder}s`;};
const percent=(processed,total)=>total?Math.min(100,Math.floor(processed*100/total)):0;
const elapsed=(job,prefix,time,active)=>Math.max(0,Number(job[`${prefix}ElapsedMs`])||0)+(Number.isFinite(job[`${prefix}StartedAt`])?Math.max(0,(active?time:Number(job[`${prefix}ProgressAt`])||job[`${prefix}StartedAt`])-job[`${prefix}StartedAt`]):0);

function step2(job,time){
 const progress=job.progress||{},processed=Math.max(0,Number(progress.processed)||0),total=Math.max(0,Number(progress.total)||job.rows?.length||0);
 const active=['validating','planning'].includes(job.status),complete=['ready','failed','cancelled'].includes(job.status),elapsedMs=elapsed(job,'deploymentStep2',time,active);
 const stalled=active&&Number.isFinite(job.deploymentStep2ProgressAt)&&time-job.deploymentStep2ProgressAt>=180000;
 let estimate='Calculating ETA…';
 if(complete)estimate='';
 else if(stalled||job.status==='interrupted')estimate='Progress paused — ETA unavailable';
 else if(active&&Number(job.deploymentStep2SampleCount)>=3&&elapsedMs>=15000&&Number(job.deploymentStep2RatePerMs)>0&&processed<total){const remaining=(total-processed)/job.deploymentStep2RatePerMs;if(Number.isFinite(remaining)&&remaining>=0)estimate=`ETA: ${duration(remaining)}`;}
 return {processed,total,percent:percent(processed,total),elapsed:duration(elapsedMs),complete,estimate};
}

function targetOutcome(task,target){
 if(target.deactivation?.status==='failed')return 'failed';
 if(target.deactivation?.status==='uncertain')return 'uncertain';
 const status=targetStatus(task,target);
 if(status==='submitted'){
  if(['updated','unchanged'].includes(target.activation?.status))return 'submitted';
  if(['failed','uncertain'].includes(target.activation?.status))return target.activation.status;
  return 'pending';
 }
 if(status==='uncertain')return 'uncertain';
 if(status==='failed')return 'failed';
 if(task.result?.status==='skipped')return 'skipped';
 if(task.result?.targets?.some(item=>item.orgUnitId===target.orgUnitId&&item.status==='notAttempted'))return 'notAttempted';
 return 'pending';
}

function step3(job,time){
 const tasks=job.tasks||[],targets=tasks.flatMap(task=>task.targets.map(target=>({task,target,outcome:targetOutcome(task,target)}))),total=targets.length;
 const count=key=>targets.filter(item=>item.outcome===key).length;
 const submitted=count('submitted'),failed=count('failed'),uncertain=count('uncertain'),skipped=count('skipped'),notAttempted=count('notAttempted'),processed=submitted+failed+uncertain+skipped+notAttempted;
 const terminal=['activated','activationWithErrors','submitted','submittedWithErrors','outcomeUnknown','failed','interrupted','cancelled'].includes(job.status),complete=terminal&&job.status!=='interrupted';
 const active=job.status==='running',elapsedMs=elapsed(job,'deploymentStep3',time,active),throughput=elapsedMs>0?processed*60000/elapsedMs:0;
 const stalled=active&&Number.isFinite(job.deploymentStep3ProgressAt)&&time-job.deploymentStep3ProgressAt>=180000;
 let phase='Preparing replicas — deactivation and verification';
 if(targets.some(item=>item.outcome==='pending'&&(!item.target.deactivation||item.target.deactivation.status==='running')))phase='Preparing replicas — deactivation and verification';
 else if(tasks.some(task=>!task.result||task.result.status==='running'))phase='Submitting deployments — Brightspace requests';
 else if(targets.some(item=>item.outcome==='pending'))phase='Reactivating replicas — activation and verification';
 else phase='Deployment execution complete';
 let estimate='Calculating ETA…';
 if(complete||job.cancelRequestedAt)estimate='';
 else if(stalled||job.status==='interrupted')estimate='Progress paused — ETA unavailable';
 else if(active&&processed>=20&&elapsedMs>=15000&&throughput>0&&processed<total){const remaining=(total-processed)/throughput*60000;if(Number.isFinite(remaining)&&remaining>=0)estimate=`ETA: ~${duration(remaining)}`;}
 return {phase,processed,total,percent:percent(processed,total),submitted,failed,uncertain,skipped,notAttempted,elapsed:duration(elapsedMs),throughput:throughput.toFixed(1),showThroughput:elapsedMs>0,terminal,complete,estimate};
}
module.exports={duration,percent,step2,step3,targetOutcome};

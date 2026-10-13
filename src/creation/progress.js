'use strict';

const duration=milliseconds=>{const seconds=Math.max(0,Math.floor(milliseconds/1000)),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60),remainder=seconds%60;return hours?`${hours}h ${minutes}m ${remainder}s`:minutes?`${minutes}m ${remainder}s`:`${remainder}s`;};
const percent=(processed,total,complete=false)=>complete?100:total?Math.min(100,Math.floor(processed*100/total)):0;
const elapsed=(job,prefix,time,active)=>Math.max(0,Number(job[`${prefix}ElapsedMs`])||0)+(Number.isFinite(job[`${prefix}StartedAt`])?Math.max(0,((active?time:Number(job[`${prefix}ProgressAt`])||job[`${prefix}StartedAt`])-job[`${prefix}StartedAt`])):0);
const terminalStep2=new Set(['ready','completed','completedWithErrors','failed','cancelled','interrupted']);
const terminalStep3=new Set(['completed','completedWithErrors','failed','cancelled','interrupted']);

function step2(job,time){
 const progress=job.progress||{},summary=job.creationSummary||{},rows=job.rows||[],processed=Math.max(0,Number(progress.processed)||0),total=Math.max(0,Number(progress.total)||rows.length||0),complete=['ready','completed','completedWithErrors'].includes(job.status),terminal=terminalStep2.has(job.status),active=['validating','planning'].includes(job.status),elapsedMs=elapsed(job,'step2',time,active),count=(key,status)=>Number.isFinite(Number(summary[key]))?Math.max(0,Number(summary[key])):rows.filter(row=>row.status===status).length;
 let estimate='Calculating ETA…';
 if(complete||terminal&&job.status!=='interrupted')estimate='';
 else if(job.status==='interrupted')estimate='Progress paused — ETA unavailable';
 const eligible=count('eligible','eligible'),skipped=count('skipped','skipped'),invalid=count('invalid','invalid');
 return {processed,total,percent:percent(processed,total,complete),eligible,skipped,invalid,pending:Math.max(0,total-eligible-skipped-invalid),elapsed:duration(elapsedMs),complete:complete||terminal&&processed>=total,terminal,estimate};
}

function step3(job,time){
 const summary=job.creationSummary||{},tasks=job.tasks||[],total=Math.max(0,Number(summary.total)||tasks.length),count=(key,status)=>Math.max(0,Number(summary[key])||tasks.filter(task=>task.result?.status===status).length),created=count('created','created'),skipped=Math.max(0,Number(job.totals?.skipped)||tasks.filter(task=>task.result?.status==='skipped').length),failed=count('failed','failed'),uncertain=count('uncertain','uncertain'),notAttempted=count('notAttempted','notAttempted'),processed=Math.min(total,created+skipped+failed+uncertain),active=['running','queued'].includes(job.status),complete=['completed','completedWithErrors'].includes(job.status),terminal=terminalStep3.has(job.status),elapsedMs=elapsed(job,'step3',time,job.status==='running'),reconciliationOnly=job.operation==='templateReconciliation',reconciliationInProgress=job.status==='running'&&(reconciliationOnly||total>0&&processed>=total&&(job.templateReconciliationPlan||[]).length>0),phase=job.status==='queued'?'Waiting to start':reconciliationInProgress?'Reconciling template parents':job.status==='interrupted'?'Creation paused after interruption':job.status==='cancelled'?'Creation cancelled':complete?'Creation and template reconciliation complete':job.status==='failed'?'Creation stopped after an error':'Creating Source Courses';
 const registrationPending=Math.max(0,Number(summary.registrationPending)||tasks.filter(task=>task.result?.status==='created'&&task.result.registration!=='ready').length);
 const showEta=job.status==='running'&&!reconciliationInProgress&&processed>=3&&elapsedMs>=15000&&processed<total,remaining=showEta?(total-processed)*elapsedMs/processed:0;
 let estimate='Calculating ETA…';
 if(complete||terminal&&job.status!=='interrupted'||job.status==='queued')estimate='';
 else if(job.status==='interrupted')estimate='Progress paused — ETA unavailable';
 else if(reconciliationInProgress)estimate='';
 else if(showEta&&Number.isFinite(remaining))estimate=`ETA: ${duration(remaining)}`;
 return {phase,processed,total,percent:percent(processed,total,complete),created,registrationPending,skipped,failed,uncertain,notAttempted,elapsed:duration(elapsedMs),complete,terminal,reconciliationInProgress,estimate};
}
module.exports={duration,percent,step2,step3};

'use strict';

const duration=milliseconds=>{const seconds=Math.max(0,Math.floor(milliseconds/1000)),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60),remainder=seconds%60;return hours?`${hours}h ${minutes}m ${remainder}s`:minutes?`${minutes}m ${remainder}s`:`${remainder}s`;};
const percent=(processed,total)=>total?Math.min(100,Math.floor(processed*100/total)):0;
const elapsed=(job,prefix,time,active)=>Math.max(0,Number(job[`${prefix}ElapsedMs`])||0)+(Number.isFinite(job[`${prefix}StartedAt`])?Math.max(0,(active?time:Number(job[`${prefix}ProgressAt`])||job[`${prefix}StartedAt`])-job[`${prefix}StartedAt`]):0);
function step2(job,time){
 const progress=job.progress||{},processed=Math.max(0,Number(progress.processed)||0),total=Math.max(0,Number(progress.total)||0),elapsedMs=elapsed(job,'copyStep2',time,['validating','planning'].includes(job.status));
 const complete=['ready','failed','cancelled'].includes(job.status),stalled=['validating','planning'].includes(job.status)&&Number.isFinite(job.copyStep2ProgressAt)&&time-job.copyStep2ProgressAt>=180000;
 let estimate='Calculating ETA…';
 if(stalled||job.status==='interrupted')estimate='Progress paused — ETA unavailable';
 else if(complete||total>0&&processed>=total)estimate='';
 else if(['validating','planning'].includes(job.status)&&Number(job.copyStep2SampleCount)>=3&&elapsedMs>=15000&&Number(job.copyStep2RatePerMs)>0&&processed<total){const remaining=(total-processed)/job.copyStep2RatePerMs;if(Number.isFinite(remaining)&&remaining>=0)estimate=`ETA: ${duration(remaining)}`;}
 return {processed,total,percent:percent(processed,total),elapsed:duration(elapsedMs),complete,estimate};
}
function step3(job,time){
 const tasks=job.tasks||[],total=tasks.length;
 const submissionIntent=t=>t.result?.submissionIntent===true;
 const submitted=tasks.filter(t=>Boolean(t.result?.jobToken)).length,failed=tasks.filter(t=>t.result?.status==='failed').length,uncertain=tasks.filter(t=>t.result?.status==='uncertain'&&(!submissionIntent(t)||job.status!=='running')).length,inFlight=job.status==='running'?tasks.filter(submissionIntent).length:0,notAttempted=tasks.filter(t=>t.result?.status==='notAttempted').length;
 const processed=Math.min(total,submitted+failed+uncertain),elapsedMs=elapsed(job,'copyStep3',time,job.status==='running');
 const terminal=['copiesConcluded','copiesInProcess','copyNeedsAttention','interrupted'].includes(job.status),complete=['copiesConcluded','copiesInProcess','copyNeedsAttention'].includes(job.status),stalled=job.status==='running'&&Number.isFinite(job.copyStep3ProgressAt)&&time-job.copyStep3ProgressAt>=180000;
 const throughput=elapsedMs>0?processed*60000/elapsedMs:0;
 let estimate='Calculating ETA…';
 if(stalled||job.status==='interrupted')estimate='Progress paused — ETA unavailable';
 else if(complete||total>0&&processed>=total)estimate='';
 else if(job.status==='running'&&processed>=20&&elapsedMs>=15000&&throughput>0&&processed<total){const remaining=(total-processed)/throughput*60000;if(Number.isFinite(remaining)&&remaining>=0)estimate=`ETA: ${duration(remaining)}`;}
 return {processed,total,percent:percent(processed,total),submitted,failed,uncertain,inFlight,notAttempted,elapsed:duration(elapsedMs),throughput:throughput.toFixed(1),showThroughput:elapsedMs>0,terminal,estimate};
}
module.exports={duration,percent,step2,step3};

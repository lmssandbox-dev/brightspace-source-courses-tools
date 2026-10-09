'use strict';
require('dotenv').config();
const {MongoClient}=require('mongodb');
const {createHash}=require('node:crypto');
const {databaseConfig}=require('../src/shared/database');
const LEVELS=9;
function distributionRows(values,total){
 const bins=Array.from({length:LEVELS},(_,level)=>Math.max(0,Number(values?.[level])||0)),measured=bins.reduce((sum,value)=>sum+value,0);
 return {measuredMs:measured,rows:bins.map((ms,level)=>({level,milliseconds:Math.round(ms),percent:measured?Number((ms/measured*100).toFixed(2)):'unknown'})),average:measured?bins.reduce((sum,ms,level)=>sum+ms*level,0)/measured:null,peak:measured?Math.max(...bins.map((ms,level)=>ms>0?level:0)):null,reportedTotal:total};
}
function buildReport(job){
 const measurement=job?.performance?.dateStep2Utilization;
 if(measurement?.version!==1||!Array.isArray(measurement.httpMs)||!Array.isArray(measurement.permitMs))return {available:false,jobId:job?._id,status:job?.status,reason:'Step 2 discovery measurements unavailable for this job.'};
 const http=distributionRows(measurement.httpMs,measurement.coveredMs),permits=distributionRows(measurement.permitMs,measurement.coveredMs),workers=distributionRows(measurement.workerMs,measurement.coveredMs);
 const duration=Number.isFinite(measurement.discoveryDurationMs)?measurement.discoveryDurationMs:null,coverage=http.measuredMs;
 const terminal=['ready','failed','cancelled'].includes(job.status),close=duration!=null&&Math.abs(coverage-duration)<=Math.max(1000,duration*.02),recovered=Boolean(job.resuming);
 return {available:true,complete:terminal&&close&&!recovered,recovered,measurement,http,permits,workers,jobId:job._id,status:job.status,activityCount:job.totals?.total??null,discoveryDurationMs:duration,coverageMs:coverage,pendingNoHttpMs:Number.isFinite(measurement.pendingNoHttpMs)?measurement.pendingNoHttpMs:null,waits:Object.fromEntries(['apiPermitAcquisitionMs','httpAdmissionWaitMs','localReservationQueueMs','mongoReservationMs','deniedReservationReadMs','permitContentionWaitMs','pacingBudgetWaitMs','mixedWaitMs','checkpointWaitMs','gateWaitUnionMs','pacingWaitUnionMs','permitContentionUnionMs','httpAdmissionUnionMs'].map(key=>[key,measurement[key]]))};
}
function formatDuration(value){return Number.isFinite(value)?`${Math.round(value)} ms`:'unknown';}
function findJob(collection,namespace,jobId){
 const filter={namespace,kind:'dates',...(jobId?{_id:jobId}:{'performance.dateStep2Utilization.version':1})};
 return collection.findOne(filter,{projection:{_id:1,kind:1,status:1,totals:1,performance:1,resuming:1},sort:{createdAt:-1}});
}
function printDistribution(title,stats){
 console.log(`\n${title} (percent of ${Math.round(stats.measuredMs)} measured ms)`);
 console.table(stats.rows.map(row=>({level:row.level,milliseconds:row.milliseconds,percent:row.percent==='unknown'?'unknown':`${row.percent}%`})));
 console.log(`Average: ${stats.average==null?'unknown':stats.average.toFixed(2)}; peak: ${stats.peak??'unknown'}`);
}
async function main(argv=process.argv.slice(2),env=process.env){
 if(argv.length>1)throw Error('Usage: node scripts/date-step2-utilization-report.js [job-id]');
 const uri=env.MONGODB_URL;databaseConfig(uri);if(!env.BS_URL||!env.BS_DEPLOYMENT_ID)throw Error('Missing deployment configuration');
 const namespace=createHash('sha256').update(`${env.BS_URL}|${env.BS_DEPLOYMENT_ID}`).digest('hex'),client=new MongoClient(uri,{serverSelectionTimeoutMS:10000});
 try{
  await client.connect();const job=await findJob(client.db().collection('bulk_date_jobs'),namespace,argv[0]);
  if(!job){console.log(argv[0]?'Date Manager job not found in this deployment.':'No Date Manager job with Step 2 utilization measurements was found.');return;}
  const report=buildReport(job);console.log(`Job: ${report.jobId}\nStatus: ${report.status}\nActivities: ${report.activityCount??'unknown'}`);
  if(!report.available){console.log(report.reason);return;}
  console.log(`Discovery duration: ${formatDuration(report.discoveryDurationMs)}\nMeasured coverage: ${formatDuration(report.coverageMs)}\nMeasurement status: ${report.complete?'complete':report.recovered?'incomplete; recovered job; uncheckpointed work interval is unavailable':'incomplete; percentages cover measured intervals only'}`);
  printDistribution('HTTP concurrency: active discovery Brightspace requests',report.http);
  printDistribution('API permit occupancy: permits held by this discovery job',report.permits);
  printDistribution('Discovery course workers: active workers',report.workers);
  console.log(`\nPending work with no discovery HTTP request executing: ${formatDuration(report.pendingNoHttpMs)}`);
  console.log('\nWaits (request-duration sums can overlap; union metrics count wall time with at least one attributed request waiting; checkpoint wait is the worker-wait union)');
  console.table(Object.entries(report.waits).map(([name,milliseconds])=>({category:name,milliseconds:formatDuration(milliseconds)})));
  console.log('\nCapacity interpretation: permit occupancy is attributed to this job only. Global permit occupancy from other processes/workflows is unavailable, so idle global capacity cannot be inferred from this report. Pending work with no HTTP execution can include local activity processing, checkpoint waits, and gate pacing.');
 }finally{await client.close();}
}
if(require.main===module)main().catch(()=>{console.error('Could not read Step 2 utilization. Check environment and MongoDB access.');process.exitCode=1;});
module.exports={buildReport,distributionRows,findJob,main};

'use strict';
require('dotenv').config();
const {MongoClient}=require('mongodb');
const {createHash}=require('node:crypto');
const {databaseConfig}=require('../src/shared/database');
const LEVELS=5;
function distributionRows(values,total){
 const bins=Array.from({length:LEVELS},(_,level)=>Math.max(0,Number(values?.[level])||0));
 const measured=bins.reduce((sum,value)=>sum+value,0);
 return {measuredMs:measured,rows:bins.map((ms,level)=>({level,milliseconds:Math.round(ms),percent:measured?Number((ms/measured*100).toFixed(2)):'unknown'})),average:measured?bins.reduce((sum,ms,level)=>sum+ms*level,0)/measured:null,peak:measured?Math.max(...bins.map((ms,level)=>ms>0?level:0)):null,reportedTotal:total};
}
function buildReport(job){
 const measurement=job?.performance?.dateStep3Utilization;
 if(measurement?.version!==1||!Array.isArray(measurement.httpMs)||!Array.isArray(measurement.permitMs))return {available:false,jobId:job?._id,status:job?.status,activityCount:job?.totals?.total??null,recordedDurationMs:job?.step3ElapsedMs??null,reason:'Measurements unavailable for this job.'};
 const http=distributionRows(measurement.httpMs,measurement.coveredMs),permits=distributionRows(measurement.permitMs,measurement.coveredMs),duration=Number.isFinite(job.step3ElapsedMs)?job.step3ElapsedMs:null;
 const completed=['completed','completedWithErrors'].includes(job.status),close=duration!=null&&Math.abs(http.measuredMs-duration)<=Math.max(1000,duration*.02);
 const complete=completed&&close;
 return {available:true,complete,measurement,http,permits,jobId:job._id,status:job.status,activityCount:job.totals?.total??null,recordedDurationMs:duration,coverageMs:http.measuredMs,waits:{apiPermitAcquisitionMs:measurement.apiPermitAcquisitionMs,httpAdmissionWaitMs:measurement.httpAdmissionWaitMs,localReservationQueueMs:measurement.localReservationQueueMs,mongoReservationMs:measurement.mongoReservationMs,deniedReservationReadMs:measurement.deniedReservationReadMs,permitContentionWaitMs:measurement.permitContentionWaitMs,pacingBudgetWaitMs:measurement.pacingBudgetWaitMs,mixedWaitMs:measurement.mixedWaitMs,checkpointWaitMs:measurement.checkpointWaitMs}};
}
function formatDuration(value){return Number.isFinite(value)?`${Math.round(value)} ms`:'unknown';}
function findJob(collection,namespace,jobId){
 const filter={namespace,kind:'dates',...(jobId?{_id:jobId}:{'performance.dateStep3Utilization.version':1})};
 return collection.findOne(filter,{projection:{_id:1,kind:1,status:1,totals:1,step3ElapsedMs:1,performance:1},sort:{createdAt:-1}});
}
function printDistribution(title,stats){
 console.log(`\n${title} (percent of ${Math.round(stats.measuredMs)} measured ms)`);
 console.table(stats.rows.map(row=>({level:row.level,milliseconds:row.milliseconds,percent:row.percent==='unknown'?'unknown':`${row.percent}%`})));
 console.log(`Average: ${stats.average==null?'unknown':stats.average.toFixed(2)}; peak: ${stats.peak??'unknown'}`);
}
async function main(argv=process.argv.slice(2),env=process.env){
 if(argv.length>1)throw Error('Usage: node scripts/date-step3-utilization-report.js [job-id]');
 const uri=env.MONGODB_URL;databaseConfig(uri);
 if(!env.BS_URL||!env.BS_DEPLOYMENT_ID)throw Error('Missing deployment configuration');
 const namespace=createHash('sha256').update(`${env.BS_URL}|${env.BS_DEPLOYMENT_ID}`).digest('hex');
 const client=new MongoClient(uri,{serverSelectionTimeoutMS:10000});
 try{
  await client.connect();const jobs=client.db().collection('bulk_date_jobs');
  const job=await findJob(jobs,namespace,argv[0]);
  if(!job){console.log(argv[0]?'Date Manager job not found in this deployment.':'No Date Manager job with Step 3 utilization measurements was found.');return;}
  const report=buildReport(job);
  console.log(`Job: ${report.jobId}\nStatus: ${report.status}\nActivities: ${report.activityCount??'unknown'}\nRecorded Step 3 duration: ${formatDuration(report.recordedDurationMs)}`);
  if(!report.available){console.log(report.reason);return;}
  console.log(`Measurement coverage: ${formatDuration(report.coverageMs)}\nMeasurement status: ${report.complete?'complete':'incomplete; percentages cover measured intervals only'}`);
  printDistribution('HTTP concurrency: active ordinary Brightspace requests',report.http);
  printDistribution('API permit occupancy: permits held by this Step 3 job',report.permits);
  console.log('\nAggregated waiting durations (API permit acquisition is inclusive; request waits may overlap; checkpoint wait is the union of overlapping waits)');
  console.table(Object.entries(report.waits).map(([name,milliseconds])=>({category:name,milliseconds:formatDuration(milliseconds)})));
 }finally{await client.close();}
}
if(require.main===module)main().catch(()=>{console.error('Could not read Step 3 utilization. Check environment and MongoDB access.');process.exitCode=1;});
module.exports={buildReport,distributionRows,findJob,main};

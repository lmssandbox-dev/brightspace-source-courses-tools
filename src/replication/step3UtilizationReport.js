'use strict';

const CONCURRENCY_LABELS=['0','1','2','3','4','5','6','7','8+'];
const seconds=value=>Number.isFinite(value)&&value>=0?`${(value/1000).toFixed(2)} s`:'unknown';
const count=value=>Number.isFinite(value)&&value>=0?String(value):'unknown';
const average=(total,denominator)=>Number.isFinite(total)&&Number.isFinite(denominator)&&denominator>0?(total/denominator).toFixed(2):'unknown';
function concurrencySummary(bins,coveredMs){
 if(!Array.isArray(bins)||!bins.some(Number.isFinite)||!Number.isFinite(coveredMs)||coveredMs<=0)return 'unknown';
 const durations=bins.map(value=>Number.isFinite(value)&&value>=0?value:0),mean=durations.reduce((sum,value,index)=>sum+value*index,0)/coveredMs;
 let peak=-1;for(let index=0;index<durations.length;index++)if(durations[index]>0)peak=index;
 const timeInUse=durations.slice(1).reduce((sum,value)=>sum+value,0)/coveredMs*100;
 return `${mean.toFixed(2)} average; peak ${peak<0?'unknown':CONCURRENCY_LABELS[peak]}; active ${timeInUse.toFixed(1)}% of measured wall time`;
}
function formatDeploymentStep3Report(job){
 const measurement=job?.performance?.deploymentStep3Utilization;
 const lines=[`Job: ${job?._id||'unknown'}`,`Build SHA: ${job?.buildSha||'unknown'}`];
 if(!measurement||measurement.version!==1){lines.push('Step 3 measurements: unknown (not recorded; historical jobs are supported)');return lines.join('\n');}
 const coveredMs=Number.isFinite(measurement.coveredMs)?measurement.coveredMs:0;
 lines.push(`Coverage: ${measurement.coverage==='complete'?'complete':measurement.coverage==='interrupted'?'interrupted':'incomplete'}`);
 lines.push(`Step 3 elapsed wall time through latest telemetry checkpoint: ${seconds(measurement.elapsedMs)} (HTTP concurrency coverage: ${seconds(coveredMs)})`);
 lines.push(`Active Brightspace HTTP concurrency: ${concurrencySummary(measurement.httpMs,coveredMs)}`);
 lines.push(`Active source-group workers: ${concurrencySummary(measurement.sourceGroupWorkerMs,coveredMs)}`);
 lines.push('Operation elapsed time (sum across operations; includes API/gate and associated checkpoint waits, overlaps across workers and with separately reported waits):');
 for(const [key,label] of [['deactivation','Deactivation'],['deploymentSubmission','Deployment submission'],['reactivation','Reactivation']]){
  const operation=measurement.operations?.[key];lines.push(`  ${label}: ${seconds(operation?.elapsedMs)} across ${count(operation?.calls)} operations`);
 }
 lines.push('Checkpoint timings:');
 lines.push(`  Logical requests: ${count(measurement.logicalCheckpointRequests)}`);
 lines.push(`  Physical persisted batches: ${count(measurement.physicalCheckpoints)}`);
 lines.push(`  Caller wait (save request through returned promise settling): ${seconds(measurement.checkpointCallerWaitMs)} summed across requests; ${seconds(measurement.checkpointCallerWaitUnionMs)} union wall time`);
 lines.push(`  Pre-flush wait (request until batch persistence starts): ${seconds(measurement.checkpointPreFlushWaitMs)} summed across requests; ${seconds(measurement.checkpointPreFlushWaitUnionMs)} union wall time`);
 lines.push(`  Post-flush wait (persistence start until caller promise settles): ${seconds(measurement.checkpointPostFlushWaitMs)} summed across requests; ${seconds(measurement.checkpointPostFlushWaitUnionMs)} union wall time`);
 lines.push(`  Queue wait: ${seconds(measurement.checkpointQueueWaitMs)} summed across requests (overlapping); ${seconds(measurement.checkpointQueueWaitUnionMs)} union wall time`);
 lines.push(`  Persistence: ${seconds(measurement.checkpointPersistenceMs)} summed across saves (${count(measurement.checkpointPersistenceSamples)} measured saves)`);
 const buckets=measurement.checkpointBatchSizes;
 lines.push(`  Successful batch-size distribution: ${buckets&&typeof buckets==='object'?Object.entries(buckets).map(([size,value])=>`${size}=${count(value)}`).join(', '):'unknown'}`);
 lines.push('API admission and gate waits (summed request durations; concurrent requests overlap; permit acquisition includes its component waits, so do not add those values together):');
 for(const [key,label] of [['httpAdmissionWaitMs','Local HTTP admission'],['apiPermitAcquisitionMs','API permit acquisition'],['localReservationQueueMs','Local Mongo reservation queue'],['mongoReservationMs','Mongo reservation'],['deniedReservationReadMs','Denied-reservation read'],['permitContentionWaitMs','Permit contention'],['pacingBudgetWaitMs','Pacing/budget wait'],['mixedWaitMs','Mixed gate wait']])lines.push(`  ${label}: ${seconds(measurement.gateWaitMs?.[key])}`);
 lines.push(`  Gate-wait union wall time: ${seconds(measurement.gateWaitUnionMs)}`);
 lines.push('API reservation diagnostics (bounded aggregates for Source Deployer requests):');
 const diagnosticsAvailable=measurement.apiGateDiagnosticsVersion===1&&['logicalApiRequests','reservationAttempts','deniedReservationReads','admissionBlockedEpisodes','admissionBlockedUnionMs'].every(key=>Number.isFinite(measurement[key])&&measurement[key]>=0);
 if(!diagnosticsAvailable)lines.push('  Measurement coverage: unknown (not recorded by this job version)');
 else {
  const coverage=measurement.apiGateDiagnosticsCoverage==='partial'?'partial (older checkpoints lack these counters)':measurement.coverage==='complete'?'complete through latest durable telemetry checkpoint':measurement.coverage==='interrupted'?'interrupted at latest durable telemetry checkpoint':'incomplete through latest durable telemetry checkpoint';
  lines.push(`  Measurement coverage: ${coverage}`);
  lines.push(`  Logical Source Deployer API requests: ${count(measurement.logicalApiRequests)} total`);
  lines.push(`  Atomic Mongo reservation attempts: ${count(measurement.reservationAttempts)} total; ${average(measurement.reservationAttempts,measurement.logicalApiRequests)} average per logical API request`);
  lines.push(`  Denied-reservation follow-up reads: ${count(measurement.deniedReservationReads)} total; ${average(measurement.deniedReservationReads,measurement.logicalApiRequests)} average per logical API request`);
  lines.push(`  Gate-wait/local-slot-queue overlap: ${seconds(measurement.admissionBlockedUnionMs)} wall-time union across ${count(measurement.admissionBlockedEpisodes)} overlap episodes`);
 }
 return lines.join('\n');
}
module.exports={formatDeploymentStep3Report};

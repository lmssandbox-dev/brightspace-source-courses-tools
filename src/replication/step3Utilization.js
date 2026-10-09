'use strict';
const {performance}=require('node:perf_hooks');

const WAIT_NAMES=['httpAdmissionWaitMs','apiPermitAcquisitionMs','localReservationQueueMs','mongoReservationMs','deniedReservationReadMs','permitContentionWaitMs','pacingBudgetWaitMs','mixedWaitMs'];
const OP_NAMES=['deactivation','deploymentSubmission','reactivation'];
const CONCURRENCY_LEVELS=9;
const BATCH_BUCKETS=[['1',1],['2',2],['3',3],['4',4],['5-8',8],['9-16',16],['17-32',32]];
const finite=value=>Number.isFinite(value)&&value>=0?value:0;

function createDeploymentStep3Utilization({monotonicNow=()=>performance.now(),prior}={}){
 const saved=prior?.version===1?prior:{};
 const httpMs=Array.from({length:CONCURRENCY_LEVELS},(_,i)=>finite(saved.httpMs?.[i]));
 const sourceGroupWorkerMs=Array.from({length:CONCURRENCY_LEVELS},(_,i)=>finite(saved.sourceGroupWorkerMs?.[i]));
 const gateWaitMs=Object.fromEntries(WAIT_NAMES.map(name=>[name,finite(saved.gateWaitMs?.[name])]));
 const operations=Object.fromEntries(OP_NAMES.map(name=>[name,{calls:finite(saved.operations?.[name]?.calls),elapsedMs:finite(saved.operations?.[name]?.elapsedMs)}]));
 const checkpointBatchSizes=Object.fromEntries(BATCH_BUCKETS.map(([label])=>[label,finite(saved.checkpointBatchSizes?.[label])]).concat([['33+',finite(saved.checkpointBatchSizes?.['33+'])]]));
 let httpActive=0,sourceGroupWorkers=0,gateWaiters=0,checkpointWaiters=0,checkpointCallerWaiters=0,checkpointPostFlushWaiters=0;
 let lastAt=monotonicNow(),finished=false,checkpointQueueWaitMs=finite(saved.checkpointQueueWaitMs),checkpointQueueWaitUnionMs=finite(saved.checkpointQueueWaitUnionMs);
 let checkpointCallerWaitMs=finite(saved.checkpointCallerWaitMs),checkpointCallerWaitUnionMs=finite(saved.checkpointCallerWaitUnionMs);
 let checkpointPreFlushWaitMs=finite(saved.checkpointPreFlushWaitMs),checkpointPreFlushWaitUnionMs=finite(saved.checkpointPreFlushWaitUnionMs);
 let checkpointPostFlushWaitMs=finite(saved.checkpointPostFlushWaitMs),checkpointPostFlushWaitUnionMs=finite(saved.checkpointPostFlushWaitUnionMs);
 let checkpointPersistenceMs=finite(saved.checkpointPersistenceMs),physicalCheckpoints=finite(saved.physicalCheckpoints);
 let logicalCheckpointRequests=finite(saved.logicalCheckpointRequests),checkpointPersistenceSamples=finite(saved.checkpointPersistenceSamples);
 function accumulate(time=monotonicNow()){
  if(finished)return;
  const elapsed=Math.max(0,time-lastAt);
  httpMs[Math.min(CONCURRENCY_LEVELS-1,httpActive)]+=elapsed;
  sourceGroupWorkerMs[Math.min(CONCURRENCY_LEVELS-1,sourceGroupWorkers)]+=elapsed;
  if(gateWaiters>0)gateWaitUnionMs+=elapsed;
  if(checkpointWaiters>0)checkpointQueueWaitUnionMs+=elapsed;
  if(checkpointCallerWaiters>0)checkpointCallerWaitUnionMs+=elapsed;
  if(checkpointCallerWaiters>checkpointPostFlushWaiters)checkpointPreFlushWaitUnionMs+=elapsed;
  if(checkpointPostFlushWaiters>0)checkpointPostFlushWaitUnionMs+=elapsed;
  lastAt=time;
 }
 // Restore gate union only for newly collected time; prior is already durable.
 let gateWaitUnionMs=finite(saved.gateWaitUnionMs);
 function change(name,delta){accumulate();if(name==='http')httpActive=Math.max(0,httpActive+delta);else if(name==='workers')sourceGroupWorkers=Math.max(0,sourceGroupWorkers+delta);}
 function changeWait(_name,delta){accumulate();if(delta>0)gateWaiters++;else if(gateWaiters>0)gateWaiters--;}
 function add(name,value){if(Object.hasOwn(gateWaitMs,name))gateWaitMs[name]+=finite(value);}
 function operation(name,fn){const entry=operations[name];if(!entry)return Promise.resolve().then(fn);const started=monotonicNow();entry.calls++;return Promise.resolve().then(fn).finally(()=>{entry.elapsedMs+=Math.max(0,monotonicNow()-started);});}
 function checkpointEnqueued(){accumulate();checkpointWaiters++;}
 function checkpointRequested(){logicalCheckpointRequests++;}
 function checkpointSaveStarted(){accumulate();checkpointCallerWaiters++;return {startedAt:monotonicNow(),flushStartedAt:null,tracker:api};}
 function checkpointDequeued(waitMs,timing){accumulate();checkpointQueueWaitMs+=finite(waitMs);checkpointWaiters=Math.max(0,checkpointWaiters-1);if(timing&&timing.flushStartedAt==null){timing.flushStartedAt=monotonicNow();checkpointPreFlushWaitMs+=Math.max(0,timing.flushStartedAt-timing.startedAt);checkpointPostFlushWaiters++;}}
 function checkpointAbandoned(){accumulate();checkpointWaiters=Math.max(0,checkpointWaiters-1);}
 function checkpointSaveSettled(timing){if(!timing||timing.settled)return;accumulate();timing.settled=true;const endedAt=monotonicNow();checkpointCallerWaitMs+=Math.max(0,endedAt-timing.startedAt);if(timing.flushStartedAt!=null){checkpointPostFlushWaitMs+=Math.max(0,endedAt-timing.flushStartedAt);checkpointPostFlushWaiters=Math.max(0,checkpointPostFlushWaiters-1);}else checkpointPreFlushWaitMs+=Math.max(0,endedAt-timing.startedAt);checkpointCallerWaiters=Math.max(0,checkpointCallerWaiters-1);}
 function checkpointBatchPersisted(batchSize){physicalCheckpoints++;const bucket=BATCH_BUCKETS.find(([,maximum])=>batchSize<=maximum);checkpointBatchSizes[bucket?.[0]||'33+']++;}
 function checkpointPersisted(elapsedMs){checkpointPersistenceMs+=finite(elapsedMs);checkpointPersistenceSamples++;}
 function snapshot(coverage='running',elapsedMs=0){accumulate();return {version:1,coverage,elapsedMs:finite(elapsedMs),coveredMs:httpMs.reduce((a,b)=>a+b,0),httpMs:[...httpMs],sourceGroupWorkerMs:[...sourceGroupWorkerMs],gateWaitMs:{...gateWaitMs},gateWaitUnionMs,operations:Object.fromEntries(OP_NAMES.map(name=>[name,{...operations[name]}])),logicalCheckpointRequests,checkpointQueueWaitMs,checkpointQueueWaitUnionMs,checkpointCallerWaitMs,checkpointCallerWaitUnionMs,checkpointPreFlushWaitMs,checkpointPreFlushWaitUnionMs,checkpointPostFlushWaitMs,checkpointPostFlushWaitUnionMs,checkpointPersistenceMs,checkpointPersistenceSamples,physicalCheckpoints,checkpointBatchSizes:{...checkpointBatchSizes}};}
 function finish(coverage,elapsedMs){accumulate();const result=snapshot(coverage,elapsedMs);finished=true;httpActive=0;sourceGroupWorkers=0;gateWaiters=0;checkpointWaiters=0;checkpointCallerWaiters=0;checkpointPostFlushWaiters=0;return result;}
 const api={changeHttp:delta=>change('http',delta),changeSourceGroupWorkers:delta=>change('workers',delta),changePermit:()=>{},changeWait,add,operation,checkpointRequested,checkpointEnqueued,checkpointSaveStarted,checkpointSaveSettled,checkpointDequeued,checkpointAbandoned,checkpointBatchPersisted,checkpointPersisted,snapshot,finish};
 return api;
}
function getBuildSha(value=process.env.RENDER_GIT_COMMIT){return typeof value==='string'&&/^[a-f\d]{7,40}$/i.test(value.trim())?value.trim().toLowerCase():'unknown';}
module.exports={createDeploymentStep3Utilization,getBuildSha};

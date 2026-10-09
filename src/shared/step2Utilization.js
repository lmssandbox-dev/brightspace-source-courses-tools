'use strict';
const {AsyncLocalStorage}=require('node:async_hooks');
const {performance}=require('node:perf_hooks');
const context=new AsyncLocalStorage();
const LEVELS=9;
const DURATIONS=['httpAdmissionWaitMs','apiPermitAcquisitionMs','localReservationQueueMs','mongoReservationMs','deniedReservationReadMs','permitContentionWaitMs','pacingBudgetWaitMs','mixedWaitMs'];
const finite=value=>Number.isFinite(value)&&value>=0?value:0;
function createStep2Utilization({monotonicNow=()=>performance.now(),prior}={}){
 const saved=prior?.version===1?prior:{};
 const bins=key=>Array.from({length:LEVELS},(_,i)=>finite(saved[key]?.[i]));
 const httpMs=bins('httpMs'),permitMs=bins('permitMs'),workerMs=bins('workerMs');
 const totals=Object.fromEntries([...DURATIONS,'checkpointWaitMs','pendingNoHttpMs','discoveryDurationMs','gateWaitUnionMs','pacingWaitUnionMs','permitContentionUnionMs','httpAdmissionUnionMs'].map(key=>[key,finite(saved[key])]));
 let httpActive=0,permitsHeld=0,workers=0,pending=0,checkpointWaiters=0,lastAt=monotonicNow(),segmentStartedAt=lastAt,finished=false;
 const waits={httpAdmission:0,permitContention:0,pacingBudget:0,mixed:0};
 function accumulate(time=monotonicNow()){
  if(finished)return;
  const elapsed=Math.max(0,time-lastAt);httpMs[Math.min(LEVELS-1,httpActive)]+=elapsed;permitMs[Math.min(LEVELS-1,permitsHeld)]+=elapsed;workerMs[Math.min(LEVELS-1,workers)]+=elapsed;
  if(checkpointWaiters>0)totals.checkpointWaitMs+=elapsed;
  if(pending>0&&httpActive===0)totals.pendingNoHttpMs+=elapsed;
  if(Object.values(waits).some(value=>value>0))totals.gateWaitUnionMs+=elapsed;
  if(waits.pacingBudget>0||waits.mixed>0)totals.pacingWaitUnionMs+=elapsed;
  if(waits.permitContention>0||waits.mixed>0)totals.permitContentionUnionMs+=elapsed;
  if(waits.httpAdmission>0)totals.httpAdmissionUnionMs+=elapsed;
  lastAt=time;
 }
 function change(which,delta){accumulate();if(which==='http')httpActive=Math.max(0,httpActive+delta);else if(which==='permit')permitsHeld=Math.max(0,permitsHeld+delta);else if(which==='worker')workers=Math.max(0,workers+delta);}
 function add(name,value){if(Object.hasOwn(totals,name))totals[name]+=finite(value);}
 function checkpointWait(delta){accumulate();if(delta>0)checkpointWaiters++;else if(checkpointWaiters>0)checkpointWaiters--;}
 function changeWait(name,delta){if(!Object.hasOwn(waits,name))return;accumulate();waits[name]=Math.max(0,waits[name]+delta);}
 function courseStarted(){accumulate();workers++;}
 function courseFinished(){accumulate();workers=Math.max(0,workers-1);pending=Math.max(0,pending-1);}
 function setPending(value){accumulate();pending=Math.max(0,Number(value)||0);}
 function snapshot(){accumulate();const duration=totals.discoveryDurationMs+Math.max(0,lastAt-segmentStartedAt);return {version:1,coveredMs:httpMs.reduce((a,b)=>a+b,0),httpMs:[...httpMs],permitMs:[...permitMs],workerMs:[...workerMs],...totals,discoveryDurationMs:duration};}
 function finish(){accumulate();totals.discoveryDurationMs+=Math.max(0,lastAt-segmentStartedAt);segmentStartedAt=lastAt;finished=true;return snapshot();}
 return {changeHttp:d=>change('http',d),changePermit:d=>change('permit',d),add,checkpointWait,changeWait,courseStarted,courseFinished,setPending,snapshot,finish};
}
function currentStep2Utilization(){return context.getStore()||null;}
function withStep2Utilization(tracker,operation){return context.run(tracker,operation);}
module.exports={createStep2Utilization,currentStep2Utilization,withStep2Utilization};

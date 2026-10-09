'use strict';
const {AsyncLocalStorage}=require('node:async_hooks');
const {performance}=require('node:perf_hooks');
const context=new AsyncLocalStorage();
const LEVELS=5;
const DURATIONS=['httpAdmissionWaitMs','apiPermitAcquisitionMs','localReservationQueueMs','mongoReservationMs','deniedReservationReadMs','permitContentionWaitMs','pacingBudgetWaitMs','mixedWaitMs'];
function finite(value){return Number.isFinite(value)&&value>=0?value:0;}
function createStep3Utilization({monotonicNow=()=>performance.now(),prior}={}){
 const saved=prior?.version===1?prior:{};
 const httpMs=Array.from({length:LEVELS},(_,i)=>finite(saved.httpMs?.[i]));
 const permitMs=Array.from({length:LEVELS},(_,i)=>finite(saved.permitMs?.[i]));
 const totals=Object.fromEntries([...DURATIONS,'checkpointWaitMs'].map(key=>[key,finite(saved[key])]));
 let httpActive=0,permitsHeld=0,checkpointWaiters=0,checkpointStartedAt=null;
 let lastAt=monotonicNow(),finished=false;
 function accumulate(time=monotonicNow()){
  if(finished)return;
  const elapsed=Math.max(0,time-lastAt);httpMs[Math.min(LEVELS-1,httpActive)]+=elapsed;permitMs[Math.min(LEVELS-1,permitsHeld)]+=elapsed;
  if(checkpointWaiters>0)totals.checkpointWaitMs+=elapsed;
  lastAt=time;
 }
 function change(which,delta){accumulate();if(which==='http')httpActive=Math.max(0,httpActive+delta);else permitsHeld=Math.max(0,permitsHeld+delta);}
 function add(name,value){if(Object.hasOwn(totals,name))totals[name]+=finite(value);}
 function checkpointWait(delta){
  const time=monotonicNow();accumulate(time);
  if(delta>0){if(checkpointWaiters++===0)checkpointStartedAt=time;}
  else if(checkpointWaiters>0)checkpointWaiters--;
 }
 function snapshot(){accumulate();return {version:1,coveredMs:httpMs.reduce((a,b)=>a+b,0),httpMs:[...httpMs],permitMs:[...permitMs],...totals};}
 function finish(){accumulate();finished=true;httpActive=0;permitsHeld=0;checkpointWaiters=0;checkpointStartedAt=null;return snapshot();}
 return {changeHttp:delta=>change('http',delta),changePermit:delta=>change('permit',delta),add,checkpointWait,snapshot,finish};
}
function currentStep3Utilization(){return context.getStore()||null;}
function withStep3Utilization(tracker,operation){return context.run(tracker,operation);}
module.exports={createStep3Utilization,currentStep3Utilization,withStep3Utilization};

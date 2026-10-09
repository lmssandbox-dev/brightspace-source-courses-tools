'use strict';
const {performance}=require('node:perf_hooks');
const {currentStep3Utilization}=require('./step3Utilization');
// Coalesce ready workers into one atomic checkpoint. Every caller waits for its
// own batch to persist; a failed batch poisons the queue and rejects all waiters.
function createCheckpointQueue(persist,{delayMs=10}={}){
 const states=new WeakMap();
 return function checkpoint(job,dirty,callerTiming){
  let state=states.get(job);if(!state){state={pending:[],running:false};states.set(job,state);}
  const tracker=currentStep3Utilization()||callerTiming?.tracker;
  const timing=callerTiming||(tracker?.checkpointSaveStarted?.()??null),ownsTiming=!callerTiming&&Boolean(timing);
  if(state.failure){const rejected=Promise.reject(state.failure);return ownsTiming?rejected.catch(error=>{tracker?.checkpointSaveSettled?.(timing);throw error;}):rejected;}
  tracker?.checkpointEnqueued?.();
  const result=new Promise((resolve,reject)=>state.pending.push({dirty,resolve,reject,tracker,timing,ownsTiming,enqueuedAt:performance.now()}));
  if(!state.running){state.running=true;schedule();}
  function schedule(){setTimeout(()=>void flush(),delayMs);}
  async function flush(){
   const batch=state.pending.splice(0);let merged;
   const flushStarted=performance.now();
   for(const item of batch){item.dequeued=true;item.tracker?.checkpointDequeued?.(Math.max(0,flushStarted-item.enqueuedAt),item.timing);}
   if(batch.every(item=>item.dirty)){
    merged={};for(const {dirty} of batch)for(const [field,indices] of Object.entries(dirty))merged[field]=[...new Set([...(merged[field]||[]),...indices])];
   }
   try{
    for(const tracker of new Set(batch.map(item=>item.tracker).filter(Boolean)))tracker.checkpointBatchPersisted?.(batch.length);
    await persist(job,merged);
    for(const item of batch){item.resolve();if(item.ownsTiming)item.tracker?.checkpointSaveSettled?.(item.timing);}
   }
   catch(error){state.failure=error;for(const item of [...batch,...state.pending.splice(0)]){if(!item.dequeued)item.tracker?.checkpointAbandoned?.();item.reject(error);if(item.ownsTiming)item.tracker?.checkpointSaveSettled?.(item.timing);}}
   if(state.pending.length&&!state.failure)schedule();else state.running=false;
  }
  return result;
 };
}
module.exports={createCheckpointQueue};

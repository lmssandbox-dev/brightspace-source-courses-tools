'use strict';
// Coalesce ready workers into one atomic checkpoint. Every caller waits for its
// own batch to persist; a failed batch poisons the queue and rejects all waiters.
function createCheckpointQueue(persist,{delayMs=10}={}){
 const states=new WeakMap();
 return function checkpoint(job,dirty){
  let state=states.get(job);if(!state){state={pending:[],running:false};states.set(job,state);}
  if(state.failure)return Promise.reject(state.failure);
  const result=new Promise((resolve,reject)=>state.pending.push({dirty,resolve,reject}));
  if(!state.running){state.running=true;schedule();}
  function schedule(){setTimeout(()=>void flush(),delayMs);}
  async function flush(){
   const batch=state.pending.splice(0);let merged;
   if(batch.every(item=>item.dirty)){
    merged={};for(const {dirty} of batch)for(const [field,indices] of Object.entries(dirty))merged[field]=[...new Set([...(merged[field]||[]),...indices])];
   }
   try{await persist(job,merged);for(const item of batch)item.resolve();}
   catch(error){state.failure=error;for(const item of [...batch,...state.pending.splice(0)])item.reject(error);}
   if(state.pending.length&&!state.failure)schedule();else state.running=false;
  }
  return result;
 };
}
module.exports={createCheckpointQueue};

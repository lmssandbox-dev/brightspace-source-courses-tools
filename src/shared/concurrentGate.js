'use strict';
const {randomUUID,createHash}=require('node:crypto');
const {MongoClient}=require('mongodb');
const {performance}=require('node:perf_hooks');
const {currentStep3Utilization}=require('./step3Utilization');
const {currentStep2Utilization}=require('./step2Utilization');
const hash=s=>createHash('sha256').update(s).digest('hex');
const LIMIT=4,RESOLUTION_LIMIT=8,RESERVATION_LIMIT=2,BUDGET=30000;
const isCodeResolution=config=>{const url=new URL(config.url);return String(config.method||'GET').toUpperCase()==='GET'&&/^\/d2l\/api\/lp\/[^/]+\/orgstructure\/$/.test(url.pathname)&&Boolean(url.searchParams.get('exactOrgUnitCode'));};
const dateDiscoveryPath=/^\/d2l\/api\/le\/[^/]+\/[1-9]\d*\/(?:dropbox\/folders\/|quizzes\/|discussions\/forums\/|discussions\/forums\/[1-9]\d*\/topics\/)$/;
const isDateDiscovery=config=>{const url=new URL(config.url);return String(config.method||'GET').toUpperCase()==='GET'&&dateDiscoveryPath.test(url.pathname);};
const isCopyRequest=config=>{const path=new URL(config.url).pathname,method=String(config.method||'GET').toUpperCase();return method==='POST'&&/^\/d2l\/api\/le\/[^/]+\/import\/[1-9]\d*\/copy\/$/.test(path)||method==='GET'&&/^\/d2l\/api\/le\/[^/]+\/import\/[1-9]\d*\/copy\/[^/]+$/.test(path);};
// Deployment metadata/status reads and writes share the total eight-request ceiling.
const isDeploymentRequest=config=>{
 const path=new URL(config.url).pathname,method=String(config.method||'GET').toUpperCase();
 return method==='GET'&&/^\/d2l\/api\/(?:lp\/[^/]+\/(?:courses\/[1-9]\d*|orgstructure\/[1-9]\d*|sourceCourses\/[1-9]\d*\/reofferedCourses)|le\/[^/]+\/ccb\/logs)$/.test(path)
 ||method==='PUT'&&/^\/d2l\/api\/lp\/[^/]+\/courses\/[1-9]\d*$/.test(path)
 ||method==='POST'&&/^\/d2l\/api\/lp\/[^/]+\/sourceCourses\/[1-9]\d*\/deploy$/.test(path);
};
function createConcurrentGate({uri,key,now=Date.now,monotonicNow=()=>performance.now(),mongoClient}){
 const client=mongoClient||new MongoClient(uri,{serverSelectionTimeoutMS:10000});let ready,initialized;let notBefore=0,slotRetryAt=0,ordinarySlotRetryAt=0,slotWait=250,reservationActive=0;const reservationWaiters=[];
 const pendingCompletion=new Map();
 async function collection(){ready ||= client.connect().catch(e=>{ready=null;throw e;});await ready;return client.db().collection('api_rate_limits');}
 async function initialize(c,time){
  initialized ||= c.updateOne({_id:key},{$setOnInsert:{nextAt:0,pauseUntil:0,permits:[],budgetStart:time,budgetUsed:0}},{upsert:true}).catch(e=>{if(e.code!==11000){initialized=null;throw e;}});
  await initialized;
 }
 async function reserve(route,{resolution=false,copy=false,dateDiscovery=false}={}){
   const pacingDeadline=notBefore,permitDeadline=Math.max(slotRetryAt,...(resolution||copy||dateDiscovery?[]:[ordinarySlotRetryAt]));
   const deferred=Math.max(pacingDeadline,permitDeadline)-now();if(deferred>0)return {wait:deferred,waitReason:waitReason(pacingDeadline,permitDeadline)};
   const c=await collection(),time=now(),token=randomUUID(),costPath='$costs.'+hash(route)+'.maxCost';
   await initialize(c,time);
   const cost={$max:[1,{$ifNull:[costPath,125]},{$ifNull:['$costs.'+hash(route)+'.fallbackCost',0]}]},fresh={$lte:[{$ifNull:['$budgetStart',0]},time-60000]},used={$cond:[fresh,0,{$ifNull:['$budgetUsed',0]}]};
   const active={$filter:{input:{$ifNull:['$permits',[]]},as:'permit',cond:{$gt:['$$permit.until',time]}}};
   const ordinary={$filter:{input:active,as:'permit',cond:{$and:[{$eq:[{$ifNull:['$$permit.resolution',false]},false]},{$eq:[{$ifNull:['$$permit.copy',false]},false]},{$eq:[{$ifNull:['$$permit.dateDiscovery',false]},false]}]}}};
   const reservationStarted=monotonicNow();
   const result=await c.findOneAndUpdate({_id:key,nextAt:{$lte:time},$expr:{$and:[{$lte:[{$ifNull:['$pauseUntil',0]},time]},{$lt:[{$size:active},RESOLUTION_LIMIT]},...(resolution||copy||dateDiscovery?[]:[{$lt:[{$size:ordinary},LIMIT]}]),{$lte:[{$add:[used,cost]},BUDGET]}]}},[{$set:{
    permits:{$concatArrays:[active,[{token,until:time+45000,resolution,copy,dateDiscovery}]]},
    nextAt:{$add:[time,{$max:[20,{$multiply:[cost,2]},{$ifNull:['$adaptiveSpacing',0]}]}]},
    budgetStart:{$cond:[fresh,time,{$ifNull:['$budgetStart',time]}]},budgetUsed:{$add:[used,cost]},
    lastReservationCost:cost
   }}],{returnDocument:'after'});
   const mongoReservationMs=Math.max(0,monotonicNow()-reservationStarted);
   if(result.value){notBefore=Math.max(notBefore,result.value.nextAt||0);slotWait=250;return {token,reservedCost:result.value.lastReservationCost,mongoReservationMs,deniedReservationReadMs:0};}
   const deniedReadStarted=monotonicNow();
   const row=await c.findOne({_id:key});
   const deniedReservationReadMs=Math.max(0,monotonicNow()-deniedReadStarted);
   if(!row)throw Error('API gate missing');
   const estimate=Math.max(1,row.costs?.[hash(route)]?.maxCost??125,row.costs?.[hash(route)]?.fallbackCost||0);
   if(estimate>BUDGET)throw Error('Observed API cost exceeds the application budget');
   const current=now(),windowEnd=(row.budgetStart??0)+60000;
   const rowPacingDeadline=Math.max(row.pauseUntil||0,row.nextAt||0,windowEnd>current&&(row.budgetUsed||0)+estimate>BUDGET?windowEnd:0);
   notBefore=Math.max(notBefore,rowPacingDeadline);
   const totalFull=(row.permits||[]).filter(p=>p.until>current).length>=RESOLUTION_LIMIT;
   const ordinaryFull=!resolution&&!copy&&!dateDiscovery&&(row.permits||[]).filter(p=>p.until>current&&!p.resolution&&!p.copy&&!p.dateDiscovery).length>=LIMIT;
   if(totalFull)slotRetryAt=current+slotWait;
   if(ordinaryFull)ordinarySlotRetryAt=current+slotWait;
   if(totalFull||ordinaryFull)slotWait=Math.min(1000,slotWait*2);
   const requestPermitDeadline=Math.max(slotRetryAt,...(resolution||copy||dateDiscovery?[]:[ordinarySlotRetryAt]));
   return {wait:Math.max(20,Math.max(notBefore,requestPermitDeadline)-current),waitReason:waitReason(notBefore,requestPermitDeadline),mongoReservationMs,deniedReservationReadMs};
 }
 return {
  reserve(route,options){
   const queuedAt=monotonicNow();
   const pending=(async()=>{
    await acquireReservationSlot();
    try {
    const localReservationQueueMs=Math.max(0,monotonicNow()-queuedAt);
    const result=await reserve(route,options);
    return {...result,localReservationQueueMs};
    }finally{releaseReservationSlot();}
   })();return pending;
  },
  async complete(permit,sample){
   const c=await collection(),time=now(),prefix='costs.'+hash(sample.route);
   const update={$pull:{permits:{token:permit.token}},$set:{[prefix+'.route']:sample.route,[prefix+'.lastSeenAt']:time,lastResetMs:sample.resetMs,adaptiveSpacing:sample.adaptiveSpacing||0},$inc:{[prefix+'.requests']:1,[prefix+'.timedRequests']:1,[prefix+'.totalLatencyMs']:sample.latencyMs||0,[prefix+'.totalGateWaitMs']:sample.gateWaitMs||0},$max:{[prefix+'.maxLatencyMs']:sample.latencyMs||0}};
   if(sample.cost!=null){update.$inc[prefix+'.observedRequests']=1;update.$inc[prefix+'.totalCredits']=sample.cost;update.$min={[prefix+'.minCost']:sample.cost};update.$max[prefix+'.maxCost']=sample.cost;update.$inc.budgetUsed=Math.max(0,sample.cost-permit.reservedCost);}
   if(sample.cost==null)update.$max[prefix+'.fallbackCost']=125;
   if(sample.remaining!=null)update.$set.lastRemainingCredits=sample.remaining;
   if(sample.status===429)update.$inc.rateLimitResponses=1;
   if(sample.pauseMs)update.$max.pauseUntil=time+sample.pauseMs+1000;
   update.$inc[prefix+'.gateTimingRequests']=1;
   for(const [name,value] of Object.entries(sample.gateTimings||{})){
    if(!Number.isFinite(value)||value<0)continue;
    update.$inc[prefix+'.'+name+'TotalMs']=value;
    update.$inc[prefix+'.'+name+'Samples']=1;
   }
   const flush=[...pendingCompletion.entries()];pendingCompletion.clear();
   for(const [routeHash,value] of flush){
    const completionPrefix='costs.'+routeHash;
    update.$inc[completionPrefix+'.completionPersistenceTotalMs']=value.totalMs;
    update.$inc[completionPrefix+'.completionPersistenceSamples']=value.samples;
   }
   const completionStarted=monotonicNow();
   let r;
   try{r=await c.updateOne({_id:key,'permits.token':permit.token},update);}
   catch(error){restorePending(flush);throw error;}
   const completionPersistenceMs=Math.max(0,monotonicNow()-completionStarted);
   if(r.matchedCount!==1){restorePending(flush);throw Error('API permit lost');}
   const routeHash=hash(sample.route),buffered=pendingCompletion.get(routeHash)||{totalMs:0,samples:0};
   buffered.totalMs+=completionPersistenceMs;buffered.samples++;pendingCompletion.set(routeHash,buffered);
   slotRetryAt=0;ordinarySlotRetryAt=0;slotWait=250;if(sample.pauseMs)notBefore=Math.max(notBefore,time+sample.pauseMs+1000);
  },
  async close(){await client.close();}
 };
 function acquireReservationSlot(){
  if(reservationActive<RESERVATION_LIMIT){reservationActive++;return Promise.resolve();}
  return new Promise(resolve=>reservationWaiters.push(resolve));
 }
 function releaseReservationSlot(){
  const next=reservationWaiters.shift();if(next)next();else reservationActive--;
 }
 function restorePending(entries){for(const [routeHash,value] of entries){const current=pendingCompletion.get(routeHash)||{totalMs:0,samples:0};current.totalMs+=value.totalMs;current.samples+=value.samples;pendingCompletion.set(routeHash,current);}}
 function waitReason(pacingDeadline,permitDeadline){
  const pacing=pacingDeadline>now(),permit=permitDeadline>now();
  if(pacing&&permit)return 'mixed';
  if(pacing)return 'pacingBudget';
  if(permit)return 'permitContention';
  return 'mixed';
 }
}
function createConcurrentHttp({http,gate,baseUrl,now=Date.now,monotonicNow=()=>performance.now(),delay=ms=>new Promise(r=>setTimeout(r,ms)),maxRetries=5,seconds}){
 const origin=new URL(baseUrl).origin;let active=0,ordinaryActive=0,poisoned=false;const waiting=[];
 async function run(config,tracker){
  const url=new URL(config.url);if(url.origin!==origin||!url.pathname.startsWith('/d2l/api/'))throw Error('Rate-limited transport only accepts tenant API URLs');
  const route=String(config.method||'GET').toUpperCase()+' '+url.pathname.replace(/(\/copy\/)[^/]+$/,'$1:token').replace(/\/\d+(?=\/|$)/g,'/:id');
  for(let attempt=0;;attempt++){
   if(poisoned)throw Error('API gate unavailable; requests stopped');
   const waitingAt=now();let permit;
   const acquisitionStartedAt=monotonicNow();let acquisitionRecorded=false;
   const gateTimings={localReservationQueue:0,mongoReservation:0,deniedReservationRead:0,permitContentionWait:0,pacingBudgetWait:0,mixedWait:0};
   const recordReservation=sample=>{if(!tracker)return;tracker.add('localReservationQueueMs',sample.localReservationQueueMs);tracker.add('mongoReservationMs',sample.mongoReservationMs);tracker.add('deniedReservationReadMs',sample.deniedReservationReadMs);};
   try{while(!(permit=await gate.reserve(route,{resolution:isCodeResolution(config),copy:isCopyRequest(config)||isDeploymentRequest(config),dateDiscovery:isDateDiscovery(config)})).token){
    recordReservation(permit);
    gateTimings.localReservationQueue+=permit.localReservationQueueMs||0;
    gateTimings.mongoReservation+=permit.mongoReservationMs||0;
    gateTimings.deniedReservationRead+=permit.deniedReservationReadMs||0;
    const waitName=permit.waitReason==='permitContention'?'permitContention':permit.waitReason==='pacingBudget'?'pacingBudget':'mixed';tracker?.changeWait?.(waitName,1);
    const waitedAt=monotonicNow();try{await delay(permit.wait);}finally{tracker?.changeWait?.(waitName,-1);}const waited=Math.max(0,monotonicNow()-waitedAt);
    if(permit.waitReason==='permitContention'){gateTimings.permitContentionWait+=waited;tracker?.add('permitContentionWaitMs',waited);}
    else if(permit.waitReason==='pacingBudget'){gateTimings.pacingBudgetWait+=waited;tracker?.add('pacingBudgetWaitMs',waited);}
    else {gateTimings.mixedWait+=waited;tracker?.add('mixedWaitMs',waited);}
    if(poisoned)throw Error('API gate unavailable');
   }
   recordReservation(permit);
   tracker?.add('apiPermitAcquisitionMs',Math.max(0,monotonicNow()-acquisitionStartedAt));acquisitionRecorded=true;
   gateTimings.localReservationQueue+=permit.localReservationQueueMs||0;
   gateTimings.mongoReservation+=permit.mongoReservationMs||0;
   gateTimings.deniedReservationRead+=permit.deniedReservationReadMs||0;
   }catch(e){if(!acquisitionRecorded)tracker?.add('apiPermitAcquisitionMs',Math.max(0,monotonicNow()-acquisitionStartedAt));poisoned=true;throw e;}
   tracker?.changePermit(1);
   const startedAt=now();let response,error;
   if(tracker)tracker.changeHttp(1);
   try{response=await http({...config,timeout:Math.min(config.timeout||15000,30000),maxRedirects:0});}catch(e){error=e;}finally{tracker?.changeHttp(-1);}
   const headers=(response||error?.response)?.headers||{},read=name=>headers.get?.(name)??headers[name]??Object.entries(headers).find(([k])=>k.toLowerCase()===name)?.[1];
   const status=error?.response?.status??response?.status,reset=Math.max(seconds(read('retry-after'),now())||0,seconds(read('x-rate-limit-reset'),now())||0);
   const cost=Number(read('x-request-cost')??NaN),remaining=Number(read('x-rate-limit-remaining')??NaN),known=Number.isFinite(cost)&&cost>=0;
   const pauseMs=status===429||Number.isFinite(remaining)&&remaining<=Math.max(10000,known?cost:125)?Math.max(60000,reset):0;
   try{await gate.complete(permit,{route,status,cost:known?cost:null,remaining:Number.isFinite(remaining)?remaining:null,resetMs:reset,pauseMs,latencyMs:now()-startedAt,gateWaitMs:startedAt-waitingAt,gateTimings,adaptiveSpacing:known&&remaining>10000&&reset>0?Math.ceil(cost*reset/(remaining-10000)):0});}catch(e){poisoned=true;throw e;}finally{tracker?.changePermit(-1);}
   if(!error)return response;
   if(status!==429||attempt>=maxRetries)throw error;
  }
 }
 function drain(){
  for(let i=0;i<waiting.length&&active<RESOLUTION_LIMIT;){
   const entry=waiting[i];if(!entry.elevated&&ordinaryActive>=LIMIT){i++;continue;}
   waiting.splice(i,1);active++;if(!entry.elevated)ordinaryActive++;entry.resolve();
  }
 }
 return async config=>{
  const elevated=isCodeResolution(config)||isCopyRequest(config)||isDeploymentRequest(config)||isDateDiscovery(config);
  const tracker=isDateDiscovery(config)?currentStep2Utilization():elevated?null:currentStep3Utilization(),queuedAt=monotonicNow();
  tracker?.changeWait?.('httpAdmission',1);try{await new Promise(resolve=>{waiting.push({elevated,resolve});drain();});}finally{tracker?.changeWait?.('httpAdmission',-1);}
  if(tracker)tracker.add('httpAdmissionWaitMs',Math.max(0,monotonicNow()-queuedAt));
  try{return await run(config,tracker);}finally{active--;if(!elevated)ordinaryActive--;drain();}
 };
}
module.exports={createConcurrentGate,createConcurrentHttp,LIMIT,RESOLUTION_LIMIT};

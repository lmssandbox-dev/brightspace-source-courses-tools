'use strict';
const {randomUUID,createHash}=require('node:crypto');
const {MongoClient}=require('mongodb');
const hash=s=>createHash('sha256').update(s).digest('hex');
const LIMIT=4,RESOLUTION_LIMIT=8,BUDGET=30000;
const isCodeResolution=config=>{const url=new URL(config.url);return String(config.method||'GET').toUpperCase()==='GET'&&/^\/d2l\/api\/lp\/[^/]+\/orgstructure\/$/.test(url.pathname)&&Boolean(url.searchParams.get('exactOrgUnitCode'));};
const isCopyRequest=config=>{const path=new URL(config.url).pathname,method=String(config.method||'GET').toUpperCase();return method==='POST'&&/^\/d2l\/api\/le\/[^/]+\/import\/[1-9]\d*\/copy\/$/.test(path)||method==='GET'&&/^\/d2l\/api\/le\/[^/]+\/import\/[1-9]\d*\/copy\/[^/]+$/.test(path);};
// Deployment metadata/status reads and writes share the total eight-request ceiling.
const isDeploymentRequest=config=>{
 const path=new URL(config.url).pathname,method=String(config.method||'GET').toUpperCase();
 return method==='GET'&&/^\/d2l\/api\/(?:lp\/[^/]+\/(?:courses\/[1-9]\d*|orgstructure\/[1-9]\d*|sourceCourses\/[1-9]\d*\/reofferedCourses)|le\/[^/]+\/ccb\/logs)$/.test(path)
 ||method==='PUT'&&/^\/d2l\/api\/lp\/[^/]+\/courses\/[1-9]\d*$/.test(path)
 ||method==='POST'&&/^\/d2l\/api\/lp\/[^/]+\/sourceCourses\/[1-9]\d*\/deploy$/.test(path);
};
function createConcurrentGate({uri,key,now=Date.now,mongoClient}){
 const client=mongoClient||new MongoClient(uri,{serverSelectionTimeoutMS:10000});let ready,initialized;let notBefore=0,slotRetryAt=0,slotWait=250,reservations=Promise.resolve();
 async function collection(){ready ||= client.connect().catch(e=>{ready=null;throw e;});await ready;return client.db().collection('api_rate_limits');}
 async function initialize(c,time){
  initialized ||= c.updateOne({_id:key},{$setOnInsert:{nextAt:0,pauseUntil:0,permits:[],budgetStart:time,budgetUsed:0}},{upsert:true}).catch(e=>{if(e.code!==11000){initialized=null;throw e;}});
  await initialized;
 }
 async function reserve(route,{resolution=false,copy=false}={}){
   const deferred=Math.max(notBefore,slotRetryAt)-now();if(deferred>0)return {wait:deferred};
   const c=await collection(),time=now(),token=randomUUID(),costPath='$costs.'+hash(route)+'.maxCost';
   await initialize(c,time);
   const cost={$max:[1,{$ifNull:[costPath,125]},{$ifNull:['$costs.'+hash(route)+'.fallbackCost',0]}]},fresh={$lte:[{$ifNull:['$budgetStart',0]},time-60000]},used={$cond:[fresh,0,{$ifNull:['$budgetUsed',0]}]};
   const active={$filter:{input:{$ifNull:['$permits',[]]},as:'permit',cond:{$gt:['$$permit.until',time]}}};
   const ordinary={$filter:{input:active,as:'permit',cond:{$and:[{$eq:[{$ifNull:['$$permit.resolution',false]},false]},{$eq:[{$ifNull:['$$permit.copy',false]},false]}]}}};
   const result=await c.findOneAndUpdate({_id:key,nextAt:{$lte:time},$expr:{$and:[{$lte:[{$ifNull:['$pauseUntil',0]},time]},{$lt:[{$size:active},RESOLUTION_LIMIT]},...(resolution||copy?[]:[{$lt:[{$size:ordinary},LIMIT]}]),{$lte:[{$add:[used,cost]},BUDGET]}]}},[{$set:{
    permits:{$concatArrays:[active,[{token,until:time+45000,resolution,copy}]]},
    nextAt:{$add:[time,{$max:[20,{$multiply:[cost,2]},{$ifNull:['$adaptiveSpacing',0]}]}]},
    budgetStart:{$cond:[fresh,time,{$ifNull:['$budgetStart',time]}]},budgetUsed:{$add:[used,cost]},
    lastReservationCost:cost
   }}],{returnDocument:'after'});
   if(result.value){notBefore=Math.max(notBefore,result.value.nextAt||0);slotWait=250;return {token,reservedCost:result.value.lastReservationCost};}
   const row=await c.findOne({_id:key});if(!row)throw Error('API gate missing');
   const estimate=Math.max(1,row.costs?.[hash(route)]?.maxCost??125,row.costs?.[hash(route)]?.fallbackCost||0);
   if(estimate>BUDGET)throw Error('Observed API cost exceeds the application budget');
   const current=now(),windowEnd=(row.budgetStart??0)+60000;
   notBefore=Math.max(notBefore,row.pauseUntil||0,row.nextAt||0,windowEnd>current&&(row.budgetUsed||0)+estimate>BUDGET?windowEnd:0);
   if((row.permits||[]).filter(p=>p.until>current).length>=RESOLUTION_LIMIT||!resolution&&!copy&&(row.permits||[]).filter(p=>p.until>current&&!p.resolution&&!p.copy).length>=LIMIT){slotRetryAt=current+slotWait;slotWait=Math.min(1000,slotWait*2);}
   return {wait:Math.max(20,Math.max(notBefore,slotRetryAt)-current)};
 }
 return {
  reserve(route,options){
   // Serialize short reservation attempts locally; HTTP requests still overlap.
   const pending=reservations.then(()=>reserve(route,options));reservations=pending.catch(()=>{});return pending;
  },
  async complete(permit,sample){
   const c=await collection(),time=now(),prefix='costs.'+hash(sample.route);
   const update={$pull:{permits:{token:permit.token}},$set:{[prefix+'.route']:sample.route,[prefix+'.lastSeenAt']:time,lastResetMs:sample.resetMs,adaptiveSpacing:sample.adaptiveSpacing||0},$inc:{[prefix+'.requests']:1,[prefix+'.timedRequests']:1,[prefix+'.totalLatencyMs']:sample.latencyMs||0,[prefix+'.totalGateWaitMs']:sample.gateWaitMs||0},$max:{[prefix+'.maxLatencyMs']:sample.latencyMs||0}};
   if(sample.cost!=null){update.$inc[prefix+'.observedRequests']=1;update.$inc[prefix+'.totalCredits']=sample.cost;update.$min={[prefix+'.minCost']:sample.cost};update.$max[prefix+'.maxCost']=sample.cost;update.$inc.budgetUsed=Math.max(0,sample.cost-permit.reservedCost);}
   if(sample.cost==null)update.$max[prefix+'.fallbackCost']=125;
   if(sample.remaining!=null)update.$set.lastRemainingCredits=sample.remaining;
   if(sample.status===429)update.$inc.rateLimitResponses=1;
   if(sample.pauseMs)update.$max.pauseUntil=time+sample.pauseMs+1000;
   const r=await c.updateOne({_id:key,'permits.token':permit.token},update);if(r.matchedCount!==1)throw Error('API permit lost');
   slotRetryAt=0;slotWait=250;if(sample.pauseMs)notBefore=Math.max(notBefore,time+sample.pauseMs+1000);
  },
  async close(){await client.close();}
 };
}
function createConcurrentHttp({http,gate,baseUrl,now=Date.now,delay=ms=>new Promise(r=>setTimeout(r,ms)),maxRetries=5,seconds}){
 const origin=new URL(baseUrl).origin;let active=0,ordinaryActive=0,poisoned=false;const waiting=[];
 async function run(config){
  const url=new URL(config.url);if(url.origin!==origin||!url.pathname.startsWith('/d2l/api/'))throw Error('Rate-limited transport only accepts tenant API URLs');
  const route=String(config.method||'GET').toUpperCase()+' '+url.pathname.replace(/(\/copy\/)[^/]+$/,'$1:token').replace(/\/\d+(?=\/|$)/g,'/:id');
  for(let attempt=0;;attempt++){
   if(poisoned)throw Error('API gate unavailable; requests stopped');
   const waitingAt=now();let permit;
   try{while(!(permit=await gate.reserve(route,{resolution:isCodeResolution(config),copy:isCopyRequest(config)||isDeploymentRequest(config)})).token){await delay(permit.wait);if(poisoned)throw Error('API gate unavailable');}}catch(e){poisoned=true;throw e;}
   const startedAt=now();let response,error;
   try{response=await http({...config,timeout:Math.min(config.timeout||15000,30000),maxRedirects:0});}catch(e){error=e;}
   const headers=(response||error?.response)?.headers||{},read=name=>headers.get?.(name)??headers[name]??Object.entries(headers).find(([k])=>k.toLowerCase()===name)?.[1];
   const status=error?.response?.status??response?.status,reset=Math.max(seconds(read('retry-after'),now())||0,seconds(read('x-rate-limit-reset'),now())||0);
   const cost=Number(read('x-request-cost')??NaN),remaining=Number(read('x-rate-limit-remaining')??NaN),known=Number.isFinite(cost)&&cost>=0;
   const pauseMs=status===429||Number.isFinite(remaining)&&remaining<=Math.max(10000,known?cost:125)?Math.max(60000,reset):0;
   try{await gate.complete(permit,{route,status,cost:known?cost:null,remaining:Number.isFinite(remaining)?remaining:null,resetMs:reset,pauseMs,latencyMs:now()-startedAt,gateWaitMs:startedAt-waitingAt,adaptiveSpacing:known&&remaining>10000&&reset>0?Math.ceil(cost*reset/(remaining-10000)):0});}catch(e){poisoned=true;throw e;}
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
  const elevated=isCodeResolution(config)||isCopyRequest(config)||isDeploymentRequest(config);
  await new Promise(resolve=>{waiting.push({elevated,resolve});drain();});
  try{return await run(config);}finally{active--;if(!elevated)ordinaryActive--;drain();}
 };
}
module.exports={createConcurrentGate,createConcurrentHttp,LIMIT,RESOLUTION_LIMIT};

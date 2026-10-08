'use strict';
const {createHash}=require('node:crypto');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function seconds(value,now){
 if(value==null)return null;
 const n=Number(value);if(Number.isFinite(n)&&n>=0)return n*1000;
 const date=Date.parse(value);return Number.isFinite(date)?Math.max(0,date-now):null;
}
function createRateLimitedHttp({http,gate,baseUrl,now=Date.now,monotonicNow,delay=sleep,intervalMs=20,maxRetries=5}){
 if(gate.reserve)return require('./concurrentGate').createConcurrentHttp({http,gate,baseUrl,now,monotonicNow,delay,maxRetries,seconds});
 let queue=Promise.resolve();
 const origin=new URL(baseUrl).origin;
 async function run(config){
  const url=new URL(config.url);
  if(url.origin!==origin||!url.pathname.startsWith('/d2l/api/'))throw Error('Rate-limited transport only accepts tenant API URLs');
  for(let attempt=0;;attempt++){
   let wait;while((wait=await gate.acquire())>0)await delay(Math.min(wait,30000));
   const startedAt=now();
   let response,error;
   try{response=await http({...config,timeout:Math.min(config.timeout||15000,30000),maxRedirects:0});}catch(e){error=e;}
   const headers=(response||error?.response)?.headers||{};
   const read=name=>headers.get?.(name)??headers[name]??Object.entries(headers).find(([key])=>key.toLowerCase()===name)?.[1];
   const status=error?.response?.status;
   const reset=Math.max(seconds(read('retry-after'),now())||0,seconds(read('x-rate-limit-reset'),now())||0);
   const remaining=Number(read('x-rate-limit-remaining')??NaN),cost=Number(read('x-request-cost')??NaN);
   // Target at most 30,000 credits/minute; reserve 10,000 server credits.
   // Space request starts, so network time already counts toward pacing.
   const knownCost=Number.isFinite(cost)&&cost>0;
   const reserve=10000;
   const budgetSpacing=knownCost?Math.ceil(cost*60000/30000):250;
   const adaptiveSpacing=knownCost&&Number.isFinite(remaining)&&remaining>reserve&&reset>0
    ?Math.ceil(cost*reset/(remaining-reserve)):0;
   const pacing=Math.max(intervalMs,budgetSpacing,adaptiveSpacing);
   const pause=status===429?Math.max(reset,60000):Number.isFinite(remaining)&&remaining<=Math.max(reserve,knownCost?cost:10)?Math.max(reset,60000):0;
   await gate.release(Math.max(startedAt+pacing,now()+(pause?pause+1000:0)),{route:String(config.method||'GET').toUpperCase()+' '+url.pathname.replace(/(\/copy\/)[^/]+$/, '$1:token').replace(/\/\d+(?=\/|$)/g,'/:id'),cost:Number.isFinite(cost)&&cost>=0?cost:null,remaining:Number.isFinite(remaining)?remaining:null,resetMs:reset,status:status||response?.status});
   if(!error)return response;
   // Only explicit rejection is replayed. Timeouts and ambiguous writes propagate.
   if(status!==429||attempt>=maxRetries)throw error;
  }
 }
 return config=>{const result=queue.then(()=>run(config));queue=result.catch(()=>{});return result;};
}
const rateLimitKey=(baseUrl,clientId)=>createHash('sha256').update(`${new URL(baseUrl).origin}|${clientId}`).digest('hex');
module.exports={createRateLimitedHttp,createMongoGate:require('./concurrentGate').createConcurrentGate,rateLimitKey,seconds};

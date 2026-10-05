'use strict';
const {randomUUID,createHash}=require('node:crypto');
const {MongoClient}=require('mongodb');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function seconds(value,now){
 if(value==null)return null;
 const n=Number(value);if(Number.isFinite(n)&&n>=0)return n*1000;
 const date=Date.parse(value);return Number.isFinite(date)?Math.max(0,date-now):null;
}
// All API paths share a durable gate. A failed database operation fails closed.
function createMongoGate({uri,key,now=Date.now}){
 const client=new MongoClient(uri,{serverSelectionTimeoutMS:10000});let ready;
 const owner=randomUUID();
 async function collection(){ready ||= client.connect().catch(e=>{ready=null;throw e;});await ready;return client.db().collection('api_rate_limits');}
 return {
  async acquire(){
   const c=await collection(),time=now();
   try{await c.updateOne({_id:key},{$setOnInsert:{until:0,nextAt:0}},{upsert:true});}catch(error){if(error.code!==11000)throw error;}
   const result=await c.findOneAndUpdate({_id:key,until:{$lte:time},nextAt:{$lte:time}},{$set:{owner,until:time+60000}},{returnDocument:'after'});
   if(result.value)return 0;
   const row=await c.findOne({_id:key});return Math.max(250,Math.max(row.until,row.nextAt)-time);
  },
  async release(nextAt,sample){
   const c=await collection();const update={$set:{until:0},$max:{nextAt}};
   if(sample){
    const prefix='costs.'+createHash('sha256').update(sample.route).digest('hex');
    update.$set[prefix+'.route']=sample.route;update.$set[prefix+'.lastSeenAt']=now();
    update.$inc={[prefix+'.requests']:1};
    if(sample.cost!=null){update.$inc[prefix+'.observedRequests']=1;update.$inc[prefix+'.totalCredits']=sample.cost;update.$min={[prefix+'.minCost']:sample.cost};update.$max[prefix+'.maxCost']=sample.cost;update.$set[prefix+'.lastCost']=sample.cost;}
    if(sample.remaining!=null)update.$set.lastRemainingCredits=sample.remaining;
    update.$set.lastResetMs=sample.resetMs;
    if(sample.status===429)update.$inc.rateLimitResponses=1;
   }
   const r=await c.updateOne({_id:key,owner},update);if(r.matchedCount!==1)throw Error('API rate-limit lease lost');
  },
  async close(){await client.close();}
 };
}
function createRateLimitedHttp({http,gate,baseUrl,now=Date.now,delay=sleep,intervalMs=250,maxRetries=5}){
 let queue=Promise.resolve();
 const origin=new URL(baseUrl).origin;
 async function run(config){
  const url=new URL(config.url);
  if(url.origin!==origin||!url.pathname.startsWith('/d2l/api/'))throw Error('Rate-limited transport only accepts tenant API URLs');
  for(let attempt=0;;attempt++){
   let wait;while((wait=await gate.acquire())>0)await delay(Math.min(wait,30000));
   let response,error;
   try{response=await http({...config,timeout:Math.min(config.timeout||15000,30000),maxRedirects:0});}catch(e){error=e;}
   const headers=(response||error?.response)?.headers||{};
   const read=name=>headers.get?.(name)??headers[name]??Object.entries(headers).find(([key])=>key.toLowerCase()===name)?.[1];
   const status=error?.response?.status;
   const reset=Math.max(seconds(read('retry-after'),now())||0,seconds(read('x-rate-limit-reset'),now())||0);
   const remaining=Number(read('x-rate-limit-remaining')??NaN),cost=Number(read('x-request-cost')??NaN);
   // Keep 1,000 credits in reserve; pace expensive routes proportionally.
   const pacing=Math.max(intervalMs,Number.isFinite(cost)&&cost>0?cost*25:intervalMs);
   const pause=status===429?Math.max(reset,60000):Number.isFinite(remaining)&&remaining<Math.max(1000,Number.isFinite(cost)?cost:10)?Math.max(reset,60000):0;
   await gate.release(now()+Math.max(pacing,pause?pause+1000:0),{route:String(config.method||'GET').toUpperCase()+' '+url.pathname.replace(/\/\d+(?=\/|$)/g,'/:id'),cost:Number.isFinite(cost)&&cost>=0?cost:null,remaining:Number.isFinite(remaining)?remaining:null,resetMs:reset,status:status||response?.status});
   if(!error)return response;
   // Only explicit rejection is replayed. Timeouts and ambiguous writes propagate.
   if(status!==429||attempt>=maxRetries)throw error;
  }
 }
 return config=>{const result=queue.then(()=>run(config));queue=result.catch(()=>{});return result;};
}
const rateLimitKey=(baseUrl,clientId)=>createHash('sha256').update(`${new URL(baseUrl).origin}|${clientId}`).digest('hex');
module.exports={createRateLimitedHttp,createMongoGate,rateLimitKey,seconds};

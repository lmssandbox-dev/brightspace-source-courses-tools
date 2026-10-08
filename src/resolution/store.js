'use strict';
const {MongoClient}=require('mongodb');
const {createHash,randomUUID}=require('node:crypto');
const {databaseConfig}=require('../shared/database');
const {pool}=require('../shared/pool');
const digest=s=>createHash('sha256').update(s).digest('hex');
function namespaceFor(baseUrl,clientId){return digest(new URL(baseUrl).origin+'|'+clientId);}
function mergeMatches(code,base,overlay,byId,fullAt){
 if(!overlay||overlay.verifiedAt<=fullAt)return base.filter(r=>r.Code===code&&!r.deleted);
 const records=new Map();
 for(const record of overlay.matches){const newer=byId.get(record.Identifier);if(newer&&newer.observedAt>overlay.verifiedAt){if(!newer.deleted&&newer.Code===code)records.set(newer.Identifier,newer);}else records.set(record.Identifier,record);}
 for(const record of base)if(record.observedAt>overlay.verifiedAt&&!record.deleted&&record.Code===code)records.set(record.Identifier,record);
 return [...records.values()];
}
function createResolutionStore({uri,namespace,mongoClient,now=Date.now}){
 databaseConfig(uri);const client=mongoClient||new MongoClient(uri,{serverSelectionTimeoutMS:10000,socketTimeoutMS:30000});let ready;
 async function db(){ready ||= (async()=>{await client.connect();const d=client.db();await d.collection('org_resolution_units').createIndex({namespace:1,generation:1,Code:1});await d.collection('org_resolution_units').createIndex({namespace:1,generation:1,Identifier:1},{unique:true});return d;})().catch(e=>{ready=null;throw e;});return ready;}
 const metaId=namespace,liveId=code=>namespace+':'+digest(code);
 return {
  async lookup(codes){const d=await db(),meta=await d.collection('org_resolution_state').findOne({_id:metaId}),found=new Map();
   const parts=Array.from({length:Math.ceil(codes.length/500)},(_,i)=>codes.slice(i*500,(i+1)*500)),results=new Array(parts.length);
   await pool(parts,4,async(part,index)=>{const overlays=await d.collection('org_resolution_live').find({_id:{$in:part.map(liveId)},namespace}).toArray();
    const ids=overlays.flatMap(o=>o.matches.map(r=>r.Identifier));const records=meta?.generation?await d.collection('org_resolution_units').find({namespace,generation:meta.generation,$or:[{Code:{$in:part}},{Identifier:{$in:ids}}]}).toArray():[];
    const byId=new Map(records.map(r=>[r.Identifier,r])),byCode=new Map(),live=new Map(overlays.filter(r=>r.verifiedAt>(meta?.liveInvalidBefore||0)).map(r=>[r.code,r]));
    for(const r of records){if(!byCode.has(r.Code))byCode.set(r.Code,[]);byCode.get(r.Code).push(r);}
    const batch=new Map();for(const code of part){const matches=mergeMatches(code,byCode.get(code)||[],live.get(code),byId,meta?.fullAt||0);if(matches.length)batch.set(code,matches);}results[index]=batch;
   });
   for(const batch of results)for(const [code,matches] of batch)found.set(code,matches);
   return found;
  },
  async remember(code,matches,verifiedAt){if(!matches.length)return;const d=await db();await d.collection('org_resolution_live').updateOne({_id:liveId(code)},[{$set:{namespace,code:{$literal:code},matches:{$cond:[{$gt:[{$ifNull:['$verifiedAt',0]},verifiedAt]},'$matches',{$literal:matches}]},verifiedAt:{$max:[{$ifNull:['$verifiedAt',0]},verifiedAt]}}}],{upsert:true});},
  async status(){return (await db()).collection('org_resolution_state').findOne({_id:metaId});},
  async requestSync(){
   const state=(await db()).collection('org_resolution_state');
   try{await state.updateOne({_id:metaId},{$setOnInsert:{namespace,nextRunAt:0,leaseUntil:0}},{upsert:true});}catch(e){if(e.code!==11000)throw e;}
   const result=await state.updateOne({_id:metaId,leaseUntil:{$lte:now()},$or:[{manualRequestedAt:{$lte:now()-60000}},{manualRequestedAt:{$exists:false}}]},{$set:{manualRequested:true,manualRequestedAt:now(),nextRunAt:0}});
   if(result.matchedCount===1)return 'queued';
   const current=await state.findOne({_id:metaId});return current?.leaseUntil>now()||current?.manualRequested?'running':'cooldown';
  },
  async claim(force=false){const d=await db(),state=d.collection('org_resolution_state');try{await state.updateOne({_id:metaId},{$setOnInsert:{namespace,nextRunAt:0,leaseUntil:0}},{upsert:true});}catch(e){if(e.code!==11000)throw e;}
   const token=randomUUID();const r=await state.findOneAndUpdate({_id:metaId,leaseUntil:{$lte:now()},...(!force?{nextRunAt:{$lte:now()}}:{})},{$set:{token,leaseUntil:now()+120000,startedAt:now(),status:'running'}},{returnDocument:'after'});return r?.value?token:null;
  },
  async renew(token){const r=await (await db()).collection('org_resolution_state').updateOne({_id:metaId,token,leaseUntil:{$gt:now()}},{$set:{leaseUntil:now()+120000}});if(r.matchedCount!==1)throw Object.assign(Error('Sync lease lost'),{code:'RESOLUTION_LEASE_LOST'});},
  async stage(generation,records){if(!records.length)return;await (await db()).collection('org_resolution_units').bulkWrite(records.map(r=>({updateOne:{filter:{namespace,generation,Identifier:r.Identifier},update:{$set:{...r,namespace,generation,stagedAt:now()}},upsert:true}})),{ordered:true});},
  async clone(source,generation,check=async()=>{}){
   if(source===generation)throw Error('Directory staging must be separate');
   const cursor=(await db()).collection('org_resolution_units').find({namespace,generation:source}).batchSize(500);
   let batch=[];
   try{for await(const row of cursor){
    await check();const {_id,namespace:ignoredNamespace,generation:ignoredGeneration,stagedAt,...record}=row;
    batch.push(record);if(batch.length===500){await this.stage(generation,batch);batch=[];}
   }if(batch.length)await this.stage(generation,batch);}finally{await cursor.close();}
  },
  async publish(token,generation,fullAt,asOf,summary){
   const state=(await db()).collection('org_resolution_state'),previous=await state.findOne({_id:metaId,token});
   const update={$set:{generation,fullAt,asOf,...summary}};
   if(previous?.generation&&previous.generation!==generation)update.$push={retired:{generation:previous.generation,retiredAt:now()}};
   const r=await state.updateOne({_id:metaId,token,leaseUntil:{$gt:now()},$or:[{asOf:{$lte:asOf}},{asOf:{$exists:false}}]},update);
   if(r.matchedCount!==1)throw Object.assign(Error('Snapshot not published'),{code:'RESOLUTION_PUBLISH_REJECTED'});
  },
  async finish(token,nextRunAt,error){await (await db()).collection('org_resolution_state').updateOne({_id:metaId,token},{$set:{status:error?'failed':'ready',lastError:error?{name:/^[A-Za-z0-9_]{1,80}$/.test(error.name||'')?error.name:'Error',code:/^[A-Za-z0-9_:-]{1,100}$/.test(String(error.code||''))?String(error.code):'',status:Number.isInteger(error.status??error.response?.status)?(error.status??error.response?.status):null}:null,finishedAt:now(),nextRunAt,leaseUntil:0},$unset:{token:'',manualRequested:''}});},
  async cleanup(generation,fullAt){
   const d=await db(),state=d.collection('org_resolution_state'),meta=await state.findOne({_id:metaId}),cutoff=now()-86400000;
   // Retention starts at replacement, not import time: a weekly-old snapshot can still have readers.
   const retained=(meta?.retired||[]).filter(r=>r.retiredAt>=cutoff).map(r=>r.generation);
   await d.collection('org_resolution_units').deleteMany({namespace,generation:{$nin:[generation,meta?.generation,...retained].filter(Boolean)},stagedAt:{$lt:cutoff}});
   await state.updateOne({_id:metaId},{$pull:{retired:{retiredAt:{$lt:cutoff}}}});
   await d.collection('org_resolution_live').deleteMany({namespace,verifiedAt:{$lte:Math.max(fullAt,meta?.liveInvalidBefore||0)}});
  },
  async discard(generation){const d=await db(),state=await d.collection('org_resolution_state').findOne({_id:metaId});if(state?.generation!==generation)await d.collection('org_resolution_units').deleteMany({namespace,generation});},
  close:()=>client.close()
 };
}
module.exports={createResolutionStore,namespaceFor,mergeMatches};

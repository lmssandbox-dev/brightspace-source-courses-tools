'use strict';
const {randomUUID,createHash}=require('node:crypto');
const {normalize,fail}=require('./extract');
const {logFailure}=require('../shared/diagnostics');
function nextNight(now,hour){const date=new Date(now);date.setUTCHours(hour,0,0,0);if(date.getTime()<=now)date.setUTCDate(date.getUTCDate()+1);return date.getTime();}
function extractList(rows,schemaId){
 const seen=new Set();
 return rows.filter(r=>r.SchemaId===schemaId&&['Full','Differential'].includes(r.BdsType)).map(r=>{
  const at=Date.parse(r.QueuedForProcessingDate);
  if(!Number.isFinite(at)||!r.DownloadLink||typeof r.Version!=='string')throw fail('DATASET_EXTRACT_INVALID');
  // Metadata identity excludes signed download URLs, which can change between listings.
  const key=createHash('sha256').update(JSON.stringify([r.SchemaId,r.PluginId||'',r.BdsType,at,r.CreatedDate||'',r.Version])).digest('hex');
  return {...r,at,key};
 }).sort((a,b)=>a.at-b.at||a.key.localeCompare(b.key)).filter(r=>{if(seen.has(r.key))return false;seen.add(r.key);return true;});
}
function selectExtracts(rows,schemaId){
 const usable=extractList(rows,schemaId),full=usable.filter(r=>r.BdsType==='Full').at(-1);
 if(!full)throw fail('DATASET_FULL_MISSING');
 return [full,...usable.filter(r=>r.BdsType==='Differential'&&r.at>full.at)];
}
function planSync(rows,schemaId,state){
 const available=extractList(rows,schemaId),full=available.filter(r=>r.BdsType==='Full').at(-1);
 const tracked=state?.generation&&state.syncVersion===3&&state.schemaId===schemaId&&Array.isArray(state.appliedExtracts);
 const rebuild=!tracked||full&&(full.at>state.fullAt||full.at===state.fullAt&&full.key!==state.fullKey);
 if(rebuild){
  if(!full)throw fail('DATASET_FULL_MISSING');
  const extracts=[full,...available.filter(r=>r.BdsType==='Differential'&&r.at>full.at)];
  // A new baseline must not discard already known changes whose files have expired.
  if(tracked&&state.appliedExtracts.some(r=>r.at>full.at&&!extracts.some(e=>e.key===r.key)))throw fail('DATASET_HISTORY_UNAVAILABLE');
  if(state?.asOf>extracts.at(-1).at)throw fail('DATASET_HISTORY_UNAVAILABLE');
  return {mode:'full',extracts,fullAt:full.at,fullKey:full.key,version:full.Version,applied:[]};
 }
 const known=new Set(state.appliedExtracts.map(r=>r.key));
 const extracts=available.filter(r=>r.BdsType==='Differential'&&r.at>state.fullAt&&!known.has(r.key));
 if(!extracts.length)return {mode:'current',extracts:[]};
 // Do not replay late/reissued older files over newer changes.
 if(extracts.some(r=>r.at<=state.asOf))throw fail('DATASET_HISTORY_CHANGED');
 // Require overlap with the last committed extract, without assuming a daily cadence.
 if(!available.some(r=>r.at===state.asOf&&known.has(r.key)))throw fail('DATASET_HISTORY_UNAVAILABLE');
 return {mode:'differential',extracts,fullAt:state.fullAt,fullKey:state.fullKey,version:state.datasetVersion,applied:state.appliedExtracts};
}
function datasetSummary(schemas){
 const safe=value=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f-\x9f]/g,' ').slice(0,200):'';
 return schemas.map(s=>({schemaId:safe(s.SchemaId),fullName:safe(s.Full?.Name),differentialName:safe(s.Differential?.Name),fullAvailable:Boolean(s.Full),extractsLinkAvailable:Boolean(s.ExtractsLink)}));
}
function selectSchema(schemas,schemaId=''){
 // Names may be human-readable or compact plugin names. Do not match ancestors/descendants.
 const normalize=value=>String(value||'').toLowerCase().replace(/[\s_()\-]/g,'');
 const names=new Set(['organizationalunits','organizationalunitsfull','organisationalunits','organisationalunitsfull']);
 const matches=schemas.filter(s=>schemaId?String(s.SchemaId).toLowerCase()===schemaId.trim().toLowerCase():names.has(normalize(s.Full?.Name)));
 if(!matches.length)throw fail('DATASET_SCHEMA_NOT_FOUND');
 if(matches.length!==1)throw fail('DATASET_SCHEMA_AMBIGUOUS');
 if(!matches[0].Full)throw fail('DATASET_FULL_UNAVAILABLE');
 if(!matches[0].ExtractsLink)throw fail('DATASET_EXTRACT_LINK_MISSING');
 return matches[0];
}
function createDirectorySync({store,api,root,readExtract,schemaId='',hour=6,now=Date.now,enabled=true}){
 let busy=false;
 async function run({force=false}={}){
  if(busy)return {skipped:'running'};busy=true;
  let token,generation,published=false,heartbeat,leaseError;
  try{
   token=await store.claim(force);if(!token)return {skipped:'not_due_or_running'};
   heartbeat=setInterval(()=>store.renew(token).catch(error=>{leaseError=error;}),30000);heartbeat.unref?.();
   const check=async()=>{if(leaseError)throw leaseError;};
   const schemas=await api.list(root+'/datasets/bds',undefined,{check,maxPages:100,maxItems:10000});
   const schema=selectSchema(schemas,schemaId),state=await store.status();
   const plan=planSync(await api.list(schema.ExtractsLink,undefined,{check,maxPages:100,maxItems:10000}),schema.SchemaId,state);
   const {extracts,fullAt}=plan;
   if(plan.mode==='current'){await store.finish(token,nextNight(now(),hour));return {skipped:'already_current',asOf:state.asOf};}
   if(plan.applied.length+extracts.length>10000)throw fail('DATASET_HISTORY_LIMIT');
   if(extracts.some(r=>r.Version!==plan.version))throw fail('DATASET_VERSION_MISMATCH');
   const asOf=extracts.at(-1).at;
   generation=randomUUID();let rows=0,fullRows=plan.mode==='differential'?state.fullRows:0;
   // Clone locally for atomic publication; differential mode downloads no old dataset files.
   if(plan.mode==='differential')await store.clone(state.generation,generation,check);
   for(const extract of extracts){
    await check();let batch=[],count=0;const seen=new Set();
    await readExtract(extract,async row=>{
     await check();let record;
     try{record=normalize(row,extract.at);}catch(error){error.datasetRecord=count+1;error.datasetExtract=extract.BdsType;throw error;}
     if(seen.has(record.Identifier))throw fail('DATASET_DUPLICATE_ID');seen.add(record.Identifier);
     batch.push(record);count++;rows++;
     if(batch.length>=500){await store.stage(generation,batch);batch=[];}
    });
    if(batch.length)await store.stage(generation,batch);
    if(extract.BdsType==='Full'){fullRows=count;if(!count)throw fail('DATASET_EMPTY_FULL');}
   }
   await check();await store.renew(token);
   await store.publish(token,generation,fullAt,asOf,{schemaId:schema.SchemaId,syncVersion:3,liveInvalidBefore:state?.syncVersion===3?(state.liveInvalidBefore||0):now(),syncMode:plan.mode,fullKey:plan.fullKey,datasetVersion:plan.version,appliedExtracts:[...plan.applied,...extracts.map(r=>({key:r.key,at:r.at}))],fullRows,importedRows:rows,extracts:extracts.length});published=true;
   await store.finish(token,nextNight(now(),hour));
   await store.cleanup(generation,fullAt);
   return {status:'ready',mode:plan.mode,fullRows,importedRows:rows,extracts:extracts.length,asOf};
  }catch(error){
   logFailure('org_directory_sync_failed',error);
   if(token)await store.finish(token,now()+3600000,error).catch(e=>logFailure('org_directory_status_failed',e));
   if(generation&&!published)await store.discard(generation).catch(e=>logFailure('org_directory_cleanup_failed',e));
   throw error;
  }finally{clearInterval(heartbeat);busy=false;}
 }
 return {run,async tick(){try{if(enabled||(await store.status())?.manualRequested)await run();}catch{/* Logged; old published directory remains usable. */}}};
}
module.exports={createDirectorySync,nextNight,selectExtracts,selectSchema,datasetSummary,planSync};

'use strict';
const {randomUUID}=require('node:crypto');
const {normalize,fail}=require('./extract');
const {logFailure}=require('../shared/diagnostics');
function nextNight(now,hour){const date=new Date(now);date.setUTCHours(hour,0,0,0);if(date.getTime()<=now)date.setUTCDate(date.getUTCDate()+1);return date.getTime();}
function selectExtracts(rows,schemaId){
 const usable=rows.filter(r=>r.SchemaId===schemaId&&['Full','Differential'].includes(r.BdsType)).map(r=>{
  const at=Date.parse(r.QueuedForProcessingDate);
  if(!Number.isFinite(at)||!r.DownloadLink||typeof r.Version!=='string')throw fail('DATASET_EXTRACT_INVALID');return {...r,at};
 });
 const full=usable.filter(r=>r.BdsType==='Full').sort((a,b)=>b.at-a.at)[0];
 if(!full)throw fail('DATASET_FULL_MISSING');
 const differences=usable.filter(r=>r.BdsType==='Differential'&&r.at>full.at).sort((a,b)=>a.at-b.at);
 const ordered=[full,...differences];
 for(let i=1;i<ordered.length;i++)if(ordered[i].at-ordered[i-1].at>36*3600000)throw fail('DATASET_DIFFERENTIAL_GAP');
 const seen=new Set();return ordered.filter(r=>{if(seen.has(r.DownloadLink))return false;seen.add(r.DownloadLink);return true;});
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
   const schema=selectSchema(schemas,schemaId),extracts=selectExtracts(await api.list(schema.ExtractsLink,undefined,{check,maxPages:100,maxItems:10000}),schema.SchemaId);
   if(extracts.some(r=>r.Version!==extracts[0].Version))throw fail('DATASET_VERSION_MISMATCH');
   const fullAt=extracts[0].at,asOf=extracts.at(-1).at,state=await store.status();
   // Rebuild from a full plus its available differentials, not from yesterday's partial cache.
   if(state?.asOf>=asOf){await store.finish(token,nextNight(now(),hour));return {skipped:'already_current',asOf:state.asOf};}
   generation=randomUUID();let rows=0,fullRows=0;
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
   await store.publish(token,generation,fullAt,asOf,{schemaId:schema.SchemaId,fullRows,importedRows:rows,extracts:extracts.length});published=true;
   await store.finish(token,nextNight(now(),hour));
   await store.cleanup(generation,fullAt);
   return {status:'ready',fullRows,importedRows:rows,extracts:extracts.length,asOf};
  }catch(error){
   logFailure('org_directory_sync_failed',error);
   if(token)await store.finish(token,now()+3600000,error).catch(e=>logFailure('org_directory_status_failed',e));
   if(generation&&!published)await store.discard(generation).catch(e=>logFailure('org_directory_cleanup_failed',e));
   throw error;
  }finally{clearInterval(heartbeat);busy=false;}
 }
 return {run,async tick(){if(enabled)try{await run();}catch{/* Logged; old published directory remains usable. */}}};
}
module.exports={createDirectorySync,nextNight,selectExtracts,selectSchema,datasetSummary};

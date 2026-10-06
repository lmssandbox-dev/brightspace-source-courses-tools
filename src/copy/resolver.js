'use strict';
const {id}=require('../shared/id');
// Cache only within one validation job. Never infer uniqueness from a partial inventory.
function createCopyResolver({api,root,sourceClient}){
 async function pages(url,{limit=100,check=async()=>{},progress=async()=>{}}={}){
  const rows=[],seen=new Set();let next=url;
  for(let page=0;next;page++){
   if(page>=limit||rows.length>=50000)return null;
   await check();if(seen.has(next))throw Error('Repeated org-unit page');seen.add(next);
   const result=await api.read(next);
   if(!result||!Array.isArray(result.Items)||typeof result.PagingInfo?.HasMoreItems!=='boolean')throw Error('Invalid org-unit listing');
   rows.push(...result.Items);if(rows.length>50000)return null;await progress(page+1,rows.length);
   if(!result.PagingInfo.HasMoreItems)return rows;
   const bookmark=result.PagingInfo.Bookmark;if(!['string','number'].includes(typeof bookmark)||String(bookmark)==='')throw Error('Missing org-unit bookmark');
   const follow=new URL(url);follow.searchParams.set('bookmark',String(bookmark));next=follow.href;
  }
  return rows;
 }
 return async function prepare(rows,check,progress){
  const originalCheck=check;check=async()=>{try{await originalCheck();}catch(e){e.persistenceFailure=true;throw e;}};
  const originalProgress=progress;progress=async(...args)=>{try{await originalProgress(...args);}catch(e){e.persistenceFailure=true;throw e;}};
  const codes=[...new Set(rows.filter(r=>r.status==='pending').flatMap(r=>[r.originCode,r.destinationCode]).filter(Boolean))];
  const codeCache=new Map(),idCache=new Map(),validated=new Map();
  let inventory;
  if(codes.length>=250){
   // At most one inventory request per four requested codes, capped at 100 pages.
   try{inventory=await pages(`${root}/orgstructure/`,{limit:Math.min(100,Math.floor(codes.length/4)),check,progress});}
   catch(e){if(e.code==='JOB_CANCELLED'||e.persistenceFailure)throw e;inventory=null;}
  }
  if(inventory){
   const wanted=new Set(codes),matches=new Map();
   for(const row of inventory)if(wanted.has(row.Code)){const list=matches.get(row.Code)||[];list.push(row);matches.set(row.Code,list);}
   for(const code of codes)codeCache.set(code,Promise.resolve(matches.get(code)||[]));
  }
  const readCode=code=>{
   if(!codeCache.has(code)){const url=new URL(`${root}/orgstructure/`);url.searchParams.set('exactOrgUnitCode',code);codeCache.set(code,pages(url.href,{check}).then(value=>{if(!value)throw Error('Code lookup exceeded its page limit');return value;}));}
   return codeCache.get(code);
  };
  return async (row,side)=>{
   await check();let value=row[side+'Id'],record;
   if(row[side+'Code']){
    const matches=await readCode(row[side+'Code']);const unique=new Map(matches.filter(r=>r.Code===row[side+'Code']).map(r=>[id(r.Identifier),r]));
    if(unique.size!==1)throw Error('Course code must match exactly one accessible org unit');
    record=[...unique.values()][0];const resolved=id(record.Identifier);
    if(value&&value!==resolved)throw Error('ID and code identify different org units.');value=resolved;
    idCache.set(value,Promise.resolve(record));
   }else{
    if(!idCache.has(value))idCache.set(value,api.read(`${root}/orgstructure/${id(value)}`));
    record=await idCache.get(value);
   }
   if(!Number.isSafeInteger(Number(value)))throw Error('Org-unit ID exceeds supported numeric precision');
   if(id(record.Identifier)!==value||typeof record.Name!=='string')throw Error('Invalid org-unit metadata');
   // Standard type codes only; custom or unrecognized types retain authoritative validation.
   const type=String(record.Type?.Code||'').replace(/[^a-z]/gi,'').toLowerCase();
   const offering=type==='courseoffering',source=type==='sourcecourse';
   if(side==='origin'&&source)throw Error('Origin must be a Course Offering.');
   if(!offering&&!(side==='destination'&&source)){
    const key=side+':'+value;
    if(!validated.has(key))validated.set(key,(async()=>{
     await check();if(side==='origin')return sourceClient.target(value);
     try{return await sourceClient.target(value);}catch(e){if((e.httpStatus??e.status)!==404)throw e;await check();return sourceClient.source(value);}
    })());
    await validated.get(key);
   }
   return {orgUnitId:value,name:record.Name};
  };
 };
}
module.exports={createCopyResolver};

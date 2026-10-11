'use strict';
const {id}=require('../shared/id');
const {logFailure}=require('../shared/diagnostics');
function createOrgResolver({store,api,root,now=Date.now}){
 return {async prepare(codes,check=async()=>{}){
  const unique=[...new Set(codes.filter(Boolean))];if(!unique.length)return {resolve:async()=>{throw Error('Code missing');}};
  await check();const found=await store.lookup(unique),pending=new Map();
  return {resolve(code,check=async()=>{}){if(!pending.has(code))pending.set(code,(async()=>{
   await check();let records=found.get(code);
   // A filtered directory cannot prove that an excluded org-unit type does not share this code.
   // Only an exact-code API snapshot made after the latest directory sync is authoritative.
   if(!found.safeCodes?.has(code)||!records||new Set(records.map(r=>id(r.Identifier))).size!==1){const started=now(),url=new URL(root+'/orgstructure/');url.searchParams.set('exactOrgUnitCode',code);
    const live=(await api.list(url.href,undefined,{check,maxPages:100,maxItems:5000})).filter(r=>r.Code===code).map(r=>({Identifier:id(r.Identifier),Code:code,Name:typeof r.Name==='string'?r.Name:'',Type:r.Type}));
    // Creation records participate in ambiguity detection, but never stand in for the live exact-code check.
    records=[...live,...(found.get(code)||[]).filter(r=>r.provenance==='creation')];
    await check();try{await store.remember(code,records,started);}catch(error){logFailure('resolution_cache_write_failed',error);}
   }
   const matches=new Map(records.map(r=>[id(r.Identifier),r]));if(matches.size!==1)throw Object.assign(Error(matches.size===0?'Course code was not found by the Brightspace exact-code lookup.':`Brightspace exact-code lookup returned ${matches.size} org units for this code. Use a destination/origin ID without a code to identify the intended course.`),{code:matches.size===0?'CODE_NOT_FOUND':'CODE_NOT_UNIQUE'});
   return [...matches.values()][0];
  })());return pending.get(code);}};
 }};
}
module.exports={createOrgResolver};

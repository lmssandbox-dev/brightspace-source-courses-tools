'use strict';
const {id}=require('../shared/id');
const {logFailure}=require('../shared/diagnostics');
function createOrgResolver({store,api,root,now=Date.now}){
 return {async prepare(codes,check=async()=>{}){
  const unique=[...new Set(codes.filter(Boolean))];if(!unique.length)return {resolve:async()=>{throw Error('Code missing');}};
  await check();const found=await store.lookup(unique),pending=new Map();
  return {resolve(code){if(!pending.has(code))pending.set(code,(async()=>{
   await check();let records=found.get(code);
   if(!records){const started=now(),url=new URL(root+'/orgstructure/');url.searchParams.set('exactOrgUnitCode',code);
    records=(await api.list(url.href,undefined,{check,maxPages:100,maxItems:5000})).filter(r=>r.Code===code).map(r=>({Identifier:id(r.Identifier),Code:code,Name:typeof r.Name==='string'?r.Name:'',Type:r.Type}));
    await check();try{await store.remember(code,records,started);}catch(error){logFailure('resolution_cache_write_failed',error);}
   }
   const matches=new Map(records.map(r=>[id(r.Identifier),r]));if(matches.size!==1)throw Object.assign(Error('Course code must match exactly one accessible org unit'),{code:'CODE_NOT_UNIQUE'});
   return [...matches.values()][0];
  })());return pending.get(code);}};
 }};
}
module.exports={createOrgResolver};

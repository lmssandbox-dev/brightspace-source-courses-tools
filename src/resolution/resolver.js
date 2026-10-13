'use strict';
const {id}=require('../shared/id');
const {logFailure}=require('../shared/diagnostics');
const {pool}=require('../shared/pool');
function createOrgResolver({store,api,root,now=Date.now,departmentTypeId=null,departmentConfigurationError='BS_STD_DEPARTMENT_TYPE_ID is not configured or is invalid.'}){
 const requireDepartmentTypeId=()=>{if(!Number.isSafeInteger(departmentTypeId)||departmentTypeId<=0)throw Object.assign(Error(departmentConfigurationError),{code:'DEPARTMENT_TYPE_UNCONFIGURED'});return departmentTypeId;};
 const normalizeLiveType=type=>{
  if(!type||typeof type!=='object')return type;
  const result={...type};
  const value=Number(type.Id);
  if(Number.isSafeInteger(value)&&value>0)result.Id=value;
  if(typeof type.Name==='string')result.Name=type.Name;
  return result;
 };
 const lifecycleOf=record=>record?.lifecycle||'unknown';
 const uniqueById=records=>[...new Map(records.map(record=>[id(record.Identifier),record])).values()];
 const resultFor=records=>{const unique=uniqueById(records),unknown=unique.filter(record=>lifecycleOf(record)==='unknown');if(unknown.length)throw Object.assign(Error('One or more matching org units have unknown deletion or recycling status. Refresh the Org Library before resolving this code.'),{code:'CODE_STATUS_UNKNOWN'});const current=unique.filter(record=>lifecycleOf(record)==='current');if(current.length!==1)throw Object.assign(Error(current.length===0?'Course code was not found as a current org unit.':`Brightspace exact-code lookup returned ${current.length} current org units for this code. Use an ID to identify the intended org unit.`),{code:current.length===0?'CODE_NOT_FOUND':'CODE_NOT_UNIQUE'});return current[0];};
 return {isStandardDepartment(record){return record?.Type?.Id===requireDepartmentTypeId();},async lookupByIds(identifiers){if(!store.lookupByIds)return new Map();return store.lookupByIds([...new Set(identifiers.map(id))]);},async lookupById(identifier){const key=id(identifier);if(!store.lookupByIds)return null;return (await store.lookupByIds([key])).get(key)||null;},async lookupDepartmentById(identifier){
  const typeId=requireDepartmentTypeId(),key=id(identifier);
  if(!store.lookupByIds)return null;
  const found=await store.lookupByIds([key]),record=found.get(key);
  return record?.Type?.Id===typeId?record:null;
 },async prepare(codes,check=async()=>{}){
  const unique=[...new Set(codes.filter(Boolean))];if(!unique.length)return {resolve:async()=>{throw Error('Code missing');}};
  await check();const found=await store.lookup(unique),pending=new Map();
  return {resolve(code,check=async()=>{}){if(!pending.has(code))pending.set(code,(async()=>{
   await check();let records=found.get(code);
   // A filtered directory cannot prove that an excluded org-unit type does not share this code.
   // Only an exact-code API snapshot made after the latest directory sync is authoritative.
   if(!found.safeCodes?.has(code)||!records){const started=now(),url=new URL(root+'/orgstructure/');url.searchParams.set('exactOrgUnitCode',code);
    const evidence=new Map(uniqueById(found.get(code)||[]).map(record=>[id(record.Identifier),record]));
    const live=(await api.list(url.href,undefined,{check,maxPages:100,maxItems:5000})).filter(r=>r.Code===code).map(r=>{const identifier=id(r.Identifier),known=evidence.get(identifier);return {Identifier:identifier,Code:code,Name:typeof r.Name==='string'?r.Name:'',Type:normalizeLiveType(r.Type),lifecycle:known?lifecycleOf(known):'unknown',deleted:known?known.deleted:true,provenance:'live'};});
    // Creation records classify a matching live ID but never stand in for the live exact-code check.
    records=live;
    await check();if(records.every(record=>lifecycleOf(record)!=='unknown'))try{await store.remember(code,records,started);}catch(error){logFailure('resolution_cache_write_failed',error);}
   }
   return resultFor(records);
  })());return pending.get(code);}};
 },async lookupMatches(codes,check=async()=>{}){
  const unique=[...new Set(codes.filter(Boolean))],found=await store.lookup(unique),results=new Map();
  await pool(unique,8,async code=>{
   await check();try{let records=found.get(code)||[];
   if(!found.safeCodes?.has(code)||!found.has(code)){
    const started=now(),url=new URL(root+'/orgstructure/');url.searchParams.set('exactOrgUnitCode',code);
    const known=new Map(uniqueById(records).map(record=>[id(record.Identifier),record]));
    const live=(await api.list(url.href,undefined,{check,maxPages:100,maxItems:5000})).filter(record=>record.Code===code).map(record=>{
     const identifier=id(record.Identifier),prior=known.get(identifier);
     return {Identifier:identifier,Code:code,Name:typeof record.Name==='string'?record.Name:'',Type:normalizeLiveType(record.Type),lifecycle:prior?lifecycleOf(prior):'unknown',deleted:prior?prior.deleted:true,provenance:'live'};
    });
    records=live;
    if(records.every(record=>lifecycleOf(record)!=='unknown'))try{await store.remember(code,records,started);}catch(error){logFailure('resolution_cache_write_failed',error);}
   }
   if(records.some(record=>lifecycleOf(record)==='unknown'))throw Object.assign(Error('One or more matching org units have unknown deletion or recycling status. Refresh the Org Library before resolving this code.'),{code:'CODE_STATUS_UNKNOWN'});
   results.set(code,uniqueById(records));}catch(error){if(error.code==='JOB_CANCELLED'||error.persistenceFailure)throw error;results.set(code,{error});}
  },async()=>{await check();return true;});
  return results;
 },async discover(codes){return store.lookup([...new Set(codes.filter(Boolean))]);}};
}
module.exports={createOrgResolver};

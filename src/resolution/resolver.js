'use strict';
const {id}=require('../shared/id');
const {logFailure}=require('../shared/diagnostics');
const {pool}=require('../shared/pool');

const LIVE_TTL_MS=15*60*1000;
function resolutionError(code,message){return Object.assign(Error(message),{code});}
function createOrgResolver({store,api,root,now=Date.now,departmentTypeId=null,departmentConfigurationError='BS_STD_DEPARTMENT_TYPE_ID is not configured or is invalid.'}){
 const requireDepartmentTypeId=()=>{if(!Number.isSafeInteger(departmentTypeId)||departmentTypeId<=0)throw Object.assign(Error(departmentConfigurationError),{code:'DEPARTMENT_TYPE_UNCONFIGURED'});return departmentTypeId;};
 const lifecycleOf=record=>record?.lifecycle||'unknown';
 const uniqueById=records=>[...new Map(records.map(record=>[id(record.Identifier),record])).values()];
 const normalizeLiveType=type=>{
  if(!type||typeof type!=='object'||Array.isArray(type))throw resolutionError('LIVE_LOOKUP_INCOMPLETE','Brightspace exact-code lookup returned incomplete organizational-unit type information.');
  const result={};
  const typeId=Number(type.Id);
  if(Number.isSafeInteger(typeId)&&typeId>0)result.Id=typeId;
  if(typeof type.Code==='string'&&type.Code.trim())result.Code=type.Code.trim();
  if(typeof type.Name==='string')result.Name=type.Name;
  if(!result.Id&&!result.Code)throw resolutionError('LIVE_LOOKUP_INCOMPLETE','Brightspace exact-code lookup returned incomplete organizational-unit type information.');
  return result;
 };
 const liveLookup=async(code,knownRecords,check)=>{
  const url=new URL(root+'/orgstructure/');url.searchParams.set('exactOrgUnitCode',code);
  let rows;
  try{rows=await api.list(url.href,undefined,{check,maxPages:100,maxItems:5000});}
  catch(error){if(error.code==='JOB_CANCELLED'||error.persistenceFailure)throw error;const incomplete=/^(Brightspace list exceeds its limit|Brightspace pagination cycle detected|Invalid paging metadata|Missing pagination bookmark|Invalid Brightspace list response|Invalid Brightspace pagination link)$/.test(error.message||'');throw Object.assign(Error(incomplete?'Brightspace live exact-code verification was incomplete.':'Brightspace live exact-code verification failed.'),{code:incomplete?'LIVE_LOOKUP_INCOMPLETE':'LIVE_LOOKUP_FAILED',status:Number.isInteger(error.status)?error.status:Number.isInteger(error.response?.status)?error.response.status:null});}
  if(!Array.isArray(rows))throw resolutionError('LIVE_LOOKUP_INCOMPLETE','Brightspace exact-code lookup returned an incomplete response.');
  const verifiedAt=now(),known=new Map(uniqueById(knownRecords||[]).map(record=>[id(record.Identifier),record]));
  const matches=[];
  for(const row of rows){
   if(!row||typeof row!=='object'||Array.isArray(row))throw resolutionError('LIVE_LOOKUP_INCOMPLETE','Brightspace exact-code lookup returned a malformed result.');
   let identifier;try{identifier=id(row.Identifier);}catch{throw resolutionError('LIVE_LOOKUP_INCOMPLETE','Brightspace exact-code lookup returned an invalid organizational-unit ID.');}
   if(!Number.isSafeInteger(Number(identifier))||Number(identifier)<=0||typeof row.Code!=='string'||!row.Code||(row.Name!=null&&typeof row.Name!=='string'))throw resolutionError('LIVE_LOOKUP_INCOMPLETE','Brightspace exact-code lookup returned incomplete organizational-unit information.');
   const type=normalizeLiveType(row.Type);
   if(row.Code!==code)continue;
   const prior=known.get(identifier),priorStatus=lifecycleOf(prior);
   const lifecycle=['deleted','recycled'].includes(priorStatus)?priorStatus:priorStatus==='current'?'current':'live-verified';
   matches.push({Identifier:identifier,Code:row.Code,Name:typeof row.Name==='string'?row.Name:'',Type:type,lifecycle,deleted:lifecycle==='deleted',provenance:lifecycle==='live-verified'?'live-verified':'live',verifiedAt});
  }
  await check();
  // Cache empty complete lookups too, so absent/archived codes do not trigger one request per job.
  try{await store.remember?.(code,matches,verifiedAt);}catch(error){logFailure('resolution_cache_write_failed',error);}
  return matches;
 };
 const resultFor=records=>{
  const unique=uniqueById(records),blocked=unique.filter(record=>['deleted','recycled'].includes(lifecycleOf(record)));
  if(blocked.length)throw resolutionError('CODE_STATUS_UNKNOWN','This code has known deleted or recycled organizational-unit evidence.');
  if(unique.length!==1)throw resolutionError(unique.length?'CODE_NOT_UNIQUE':'CODE_NOT_FOUND',unique.length?`Brightspace exact-code lookup returned ${unique.length} organizational units for this code.`:'Course code was not found as a current org unit.');
  const record=unique[0];
  if(!['current','live-verified'].includes(lifecycleOf(record)))throw resolutionError('CODE_STATUS_UNKNOWN','Organizational-unit lifecycle could not be verified.');
  return record;
 };
 return {isStandardDepartment(record){return record?.Type?.Id===requireDepartmentTypeId();},async lookupByIds(identifiers){if(!store.lookupByIds)return new Map();return store.lookupByIds([...new Set(identifiers.map(id))]);},async lookupById(identifier){const key=id(identifier);if(!store.lookupByIds)return null;return (await store.lookupByIds([key])).get(key)||null;},async lookupDepartmentById(identifier){
  const typeId=requireDepartmentTypeId(),key=id(identifier);
  if(!store.lookupByIds)return null;
  const found=await store.lookupByIds([key]),record=found.get(key);
  return record?.Type?.Id===typeId?record:null;
 },async prepare(codes,check=async()=>{}){
  const unique=[...new Set(codes.filter(Boolean))];if(!unique.length)return {resolve:async()=>{throw Error('Code missing');}};
  await check();const found=await store.lookup(unique),pending=new Map();
  return {resolve(code,check=async()=>{}){if(!pending.has(code))pending.set(code,(async()=>{
   await check();let records=found.get(code)||[];
   if(!found.safeCodes?.has(code))records=await liveLookup(code,records,check);
   return resultFor(records);
  })());return pending.get(code);}};
 },async lookupMatches(codes,check=async()=>{}){
  const unique=[...new Set(codes.filter(Boolean))],found=await store.lookup(unique),results=new Map();
  await pool(unique,8,async code=>{
   await check();try{let records=found.get(code)||[];
    if(!found.safeCodes?.has(code))records=await liveLookup(code,records,check);
    results.set(code,uniqueById(records));
   }catch(error){if(error.code==='JOB_CANCELLED'||error.persistenceFailure)throw error;results.set(code,{error});}
  },async()=>{await check();return true;});
  return results;
 },async discover(codes){return store.lookup([...new Set(codes.filter(Boolean))]);}};
}
module.exports={createOrgResolver,LIVE_TTL_MS};

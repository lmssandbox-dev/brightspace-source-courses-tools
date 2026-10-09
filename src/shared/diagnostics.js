'use strict';
// Never log request bodies, URLs, headers, credentials, or upstream error messages.
function logFailure(event,error,context={}){
 const safe=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,100}$/.test(value)?value:undefined;
 const datasetField=['OrgUnitId','Code','Name','Type','IsDeleted'].includes(error?.datasetField)?error.datasetField:undefined;
 const datasetReason=['unsupported_boolean','not_text','too_long','invalid_id'].includes(error?.datasetReason)?error.datasetReason:undefined;
 console.error(JSON.stringify({datasetField,datasetReason,datasetRecord:Number.isSafeInteger(error?.datasetRecord)&&error.datasetRecord>0?error.datasetRecord:undefined,datasetExtract:['Full','Differential'].includes(error?.datasetExtract)?error.datasetExtract:undefined,event,time:new Date().toISOString(),kind:safe(context.kind),action:safe(context.action),jobId:safe(context.jobId),error:safe(error?.name)||'Error',code:safe(String(error?.code||'')),httpStatus:Number.isInteger(error?.status??error?.response?.status)?(error?.status??error?.response?.status):undefined}));
}
const MONGODB_OPERATIONS=new Set(['api_gate_completion','planning_metadata_save','job_checkpoint_save']);
const SAFE_MONGO_FIELDS=new Set(['_id','namespace','worker','status','updatedAt','progress','phase','processed','total','activities','step2StartedAt','step2ProgressAt','step2CourseProgressAt','step2RatePerMs','step2SampleAt','step2SampleProcessed','step2SamplePhase','step2SampleCount','performance','dateStep2Utilization','dateChunks','rows','courses','tasks','totals','permits','until','resolution','copy','dateDiscovery','token','nextAt','reservationSequence','budgetStart','budgetUsed','lastReservationCost','lastResetMs','adaptiveSpacing','pauseUntil','lastRemainingCredits','rateLimitResponses','costs','route','lastSeenAt','requests','timedRequests','totalLatencyMs','totalGateWaitMs','maxLatencyMs','gateTimingRequests','observedRequests','totalCredits','minCost','maxCost','costObservationSequence','fallbackCost','completionPersistenceTotalMs','completionPersistenceSamples','localReservationQueueTotalMs','localReservationQueueSamples','mongoReservationTotalMs','mongoReservationSamples','deniedReservationReadTotalMs','deniedReservationReadSamples','permitContentionWaitTotalMs','permitContentionWaitSamples','pacingBudgetWaitTotalMs','pacingBudgetWaitSamples','mixedWaitTotalMs','mixedWaitSamples','expiry','expiresAt','confirmedAt','resuming','message','kind','owner','createdAt','dateChunks','storageVersion']);
function sanitizeConflictPath(path){
 if(typeof path!=='string'||!path.length||path.length>512)return null;
 const parts=path.split('.');if(parts.length>24)return null;
 return parts.map((part,index)=>{
  if(index>0&&parts[index-1]==='costs'&&/^[a-f\d]{64}$/i.test(part))return '<routeHash>';
  if(/^\d+$/.test(part))return '<index>';
  if(/^[a-f\d]{24}$/i.test(part)||/^[a-f\d-]{36}$/i.test(part))return '<id>';
  return SAFE_MONGO_FIELDS.has(part)?part:'<redacted>';
 }).join('.');
}
function sanitizedMongoMessage(message){
 if(typeof message!=='string'||message.length>2048)return undefined;
 const match=/^Updating the path '([^']{1,512})' would create a conflict at '([^']{1,512})'/.exec(message);
 if(!match)return undefined;
 const path=sanitizeConflictPath(match[1]),conflict=sanitizeConflictPath(match[2]);
 return path&&conflict?`Updating the path '${path}' would create a conflict at '${conflict}'`:undefined;
}
function logMongoOperationFailure(operation,error){
 try{
  if(!MONGODB_OPERATIONS.has(operation)||!error||typeof error!=='object'||!(typeof error.name==='string'&&error.name.startsWith('Mongo')))return;
  const name=typeof error.name==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(error.name)?error.name:'MongoError';
  const code=Number.isSafeInteger(error.code)?error.code:undefined;
  const codeName=typeof error.codeName==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(error.codeName)?error.codeName:undefined;
  const message=sanitizedMongoMessage(error.message);
  console.error(JSON.stringify({event:'mongodb_operation_failed',time:new Date().toISOString(),operation,error:name,code,codeName,message}));
 }catch{}
}
module.exports={logFailure,logMongoOperationFailure};

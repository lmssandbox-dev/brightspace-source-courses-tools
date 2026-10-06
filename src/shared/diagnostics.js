'use strict';
// Never log request bodies, URLs, headers, credentials, or upstream error messages.
function logFailure(event,error,context={}){
 const safe=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,100}$/.test(value)?value:undefined;
 const datasetField=['OrgUnitId','Code','Name','Type','IsDeleted'].includes(error?.datasetField)?error.datasetField:undefined;
 const datasetReason=['unsupported_boolean','not_text','too_long','invalid_id'].includes(error?.datasetReason)?error.datasetReason:undefined;
 console.error(JSON.stringify({datasetField,datasetReason,datasetRecord:Number.isSafeInteger(error?.datasetRecord)&&error.datasetRecord>0?error.datasetRecord:undefined,datasetExtract:['Full','Differential'].includes(error?.datasetExtract)?error.datasetExtract:undefined,event,time:new Date().toISOString(),kind:safe(context.kind),action:safe(context.action),jobId:safe(context.jobId),error:safe(error?.name)||'Error',code:safe(String(error?.code||'')),httpStatus:Number.isInteger(error?.status??error?.response?.status)?(error?.status??error?.response?.status):undefined}));
}
module.exports={logFailure};

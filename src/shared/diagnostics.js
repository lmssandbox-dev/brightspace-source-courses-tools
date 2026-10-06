'use strict';
// Never log request bodies, URLs, headers, credentials, or upstream error messages.
function logFailure(event,error,context={}){
 const safe=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,100}$/.test(value)?value:undefined;
 console.error(JSON.stringify({event,time:new Date().toISOString(),kind:safe(context.kind),action:safe(context.action),jobId:safe(context.jobId),error:safe(error?.name)||'Error',code:safe(String(error?.code||'')),httpStatus:Number.isInteger(error?.status??error?.response?.status)?(error?.status??error?.response?.status):undefined}));
}
module.exports={logFailure};

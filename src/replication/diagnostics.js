 'use strict';
// Persist only selected response fields, never Axios request/config or complete headers.
function deploymentDiagnostics(response,token){
 const secrets=[token].filter(Boolean),body=response?.data;
 const sensitive=/token|secret|password|authorization|cookie|assertion|private.?key/i;
 function collect(value,depth=0){
  if(!value||typeof value!=='object'||depth>5)return;
  for(const [key,item] of Object.entries(value).slice(0,100)){
   if(sensitive.test(key)&&typeof item==='string'&&item)secrets.push(item);
   else if(typeof item==='object')collect(item,depth+1);
  }
 }
 collect(body);
 const clean=value=>{
  let text=String(value).slice(0,16000);
  for(const secret of secrets.sort((a,b)=>b.length-a.length))text=text.split(secret).join('[REDACTED]');
  return text.replace(/-----BEGIN [\s\S]*?-----END [^-]+-----/g,'[REDACTED KEY]')
   .replace(/Bearer\s+[^\s"<>]+/gi,'Bearer [REDACTED]')
   .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[REDACTED TOKEN]')
   .replace(/((?:password|client_secret|access_token|refresh_token|authorization|cookie|assertion)\s*[=:]\s*)[^\s,;<>]+/gi,'$1[REDACTED]')
   .replace(/https?:\/\/[^\s<>"?]+\?[^\s<>" ]+/gi,'[URL WITH QUERY REDACTED]')
   .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,'[REDACTED EMAIL]')
   .replace(/[\x00-\x1f]/g,' ').slice(0,1000);
 };
 const messages=[];
 function extract(value,depth=0){
  if(!value||typeof value!=='object'||depth>4||messages.length>=10)return;
  for(const [key,item] of Object.entries(value)){
   if(/^(message|detail|title|errorcode|code)$/i.test(key)&&['string','number'].includes(typeof item))messages.push(clean(item));
   else if(/^(errors|error)$/i.test(key)&&typeof item==='object'){
    for(const entry of Array.isArray(item)?item.slice(0,10):[item]){
     if(typeof entry==='string')messages.push(clean(entry));else extract(entry,depth+1);
    }
   }
  }
 }
 if(typeof body==='string'){
  // HTML/proxy error pages may contain unrelated or reflected request data.
  if(!/<[a-z!]/i.test(body))messages.push(clean(body));
 }else extract(body);
 const headers=Object.fromEntries(Object.entries(response?.headers||{}).map(([k,v])=>[k.toLowerCase(),v]));
 const ids=[];
 for(const key of ['x-request-id','x-correlation-id','request-id','correlation-id','x-d2l-request-id','traceparent'])if(typeof headers[key]==='string')ids.push(`${key}: ${clean(headers[key])}`);
 if(body&&typeof body==='object')for(const [key,value] of Object.entries(body))if(/^(requestid|correlationid|traceid)$/i.test(key)&&typeof value==='string')ids.push(`${key}: ${clean(value)}`);
 return {...(Number.isInteger(response?.status)?{httpStatus:response.status}:{}),...(messages.length?{responseDetails:[...new Set(messages)].slice(0,10).join(' | ')}:{}),...(ids.length?{requestId:ids.slice(0,6).join(' | ')}:{})};
}
function diagnosticText(error){return [error?.message,error?.httpStatus?`HTTP ${error.httpStatus}`:'',error?.responseDetails,error?.requestId?`Request/correlation ID: ${error.requestId}`:''].filter(Boolean).join(' · ');}
module.exports={deploymentDiagnostics,diagnosticText};

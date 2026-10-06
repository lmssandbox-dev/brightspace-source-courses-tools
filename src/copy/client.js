'use strict';
const {id}=require('../shared/id');
const {atLeast}=require('../shared/client');
const {COMPONENTS}=require('./jobs');
function createCopyClient({api,http,oauth,leRoot,sourceClient,lpVersion}){
 const version=new URL(leRoot).pathname.split('/').pop();
 const configured=()=>{if(!atLeast(version,'1.97'))throw Error('Bulk Course Copy requires LE API 1.97 or later.');};
 const path=value=>`${leRoot}/import/${id(value)}/copy/`;
 return {
  prepareResolution:async(rows,check,progress,options)=>{configured();if(!/^\d+\.\d+$/.test(lpVersion||''))throw Error('Invalid LP version');const root=new URL(leRoot).origin+'/d2l/api/lp/'+lpVersion;return require('./resolver').createCopyResolver({api,root,sourceClient})(rows,check,progress,options);},
  resolveCode:code=>sourceClient.resolveCode(code),
  async origin(value){configured();return sourceClient.target(value);},
  async destination(value){configured();try{return await sourceClient.target(value);}catch(e){if((e.httpStatus??e.status)!==404)throw e;return sourceClient.source(value);}},
  async copy(origin,destination,components,beforeSend){
   configured();const source=Number(id(origin));id(destination);
   if(!Number.isSafeInteger(source)||String(origin)===String(destination)||components!==null&&(!Array.isArray(components)||!components.length||components.some(c=>!COMPONENTS.includes(c))))throw Error('Invalid copy request');
   let token;try{token=await oauth.getAccessToken();}catch{return {status:'failed',systemic:true,message:'Authentication failed; copy was not sent.'};}
   await beforeSend();
   try{
    const response=await http({method:'POST',url:path(destination),timeout:30000,maxRedirects:0,headers:{Authorization:`Bearer ${token}`},data:{SourceOrgUnitId:source,Components:components,CallbackUrl:null}});
    if(response.status!==202||typeof response.data?.JobToken!=='string'||!response.data.JobToken||response.data.JobToken.length>512)throw Error('Unexpected response');
    return {status:'PENDING',jobToken:response.data.JobToken};
   }catch(e){const status=e.response?.status??e.status;const rejected=[400,401,403,404,429].includes(status);return {status:rejected?'failed':'uncertain',httpStatus:status??null,systemic:!rejected||[401,403,429].includes(status),message:rejected?'Copy request rejected. Review permissions and mapping before a new job.':'Submission outcome unconfirmed. Inspect Brightspace before creating another copy.'};}
  },
  async check(destination,token){configured();if(typeof token!=='string'||!token||token.length>512)throw Error('Invalid job token');const result=await api.read(path(destination)+encodeURIComponent(token));if(!['PENDING','PROCESSING','COMPLETE','COMPLETE_WITH_ERRORS','FAILED','CANCELLED'].includes(result?.Status))throw Error('Unknown copy status');return result.Status;}
 };
}
module.exports={createCopyClient};

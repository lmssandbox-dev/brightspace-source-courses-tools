'use strict';
const { id }=require('../shared/id');
const {deploymentDiagnostics}=require('./diagnostics');
function createSourceDeploymentClient({api,http,oauth,baseUrl,lpVersion,delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),now=Date.now}) {
  const base=new URL(baseUrl);
  const version=/^\d+\.\d+$/.test(lpVersion||'')?lpVersion:null;
  const root=version?`${base.origin}/d2l/api/lp/${version}`:null;
  function configured(){const [major,minor]=(version||'0.0').split('.').map(Number);if(base.protocol!=='https:'||major<1||(major===1&&minor<53))throw Object.assign(Error('Source deployment requires LP 1.53 or later.'),{code:'LP_VERSION_UNSUPPORTED'});}
  const safeNumber=value=>{const n=Number(id(value));if(!Number.isSafeInteger(n))throw Error('ID exceeds JSON number precision');return n;};
  // Only an explicit rate-limit rejection may be retried; never retry an ambiguous write.
  async function rateLimited(request,beforeRetry){
    for(let attempt=0;;attempt++){
      try{return await request();}catch(error){
        const status=error?.response?.status??error?.status;
        if(status!==429||attempt>=2)throw error;
        const header=error.response?.headers?.['retry-after'];
        const wait=header==null?1000*2**attempt:/^\d+(\.\d+)?$/.test(String(header))?Number(header)*1000:Date.parse(header)-now();
        if(!Number.isFinite(wait)||wait>60000)throw error;
        await delay(Math.max(0,wait));
        if(beforeRetry){try{await beforeRetry();}catch(error){throw Object.assign(error,{persistenceFailure:true});}}
      }
    }
  }
  const read=url=>rateLimited(()=>api.read(url));
  const errorInfo=error=>({httpStatus:error?.httpStatus??error?.status??error?.response?.status??null});
  function validationFailure(error,stage,orgUnitId,code){
    const status=error?.status??error?.response?.status;
    const httpStatus=Number.isInteger(status)?status:null;
    code=code||(error?.code==='LP_VERSION_UNSUPPORTED'?'LP_VERSION_UNSUPPORTED':'API_READ_FAILED');
    const label={source:'Source Course validation',sourceMetadata:'Source display-name lookup',replica:'Replica Course Offering lookup'}[stage];
    const detail=code==='LP_VERSION_UNSUPPORTED'?'Set D2L_LP_VERSION to 1.53 or later.':code==='INVALID_RESPONSE'?'Brightspace returned an incomplete or unexpected response.':httpStatus===403?'Check the OAuth read scopes and Service User permissions.':httpStatus===404?'Check the ID, org-unit type and supported LP version.':httpStatus===401?'Check API authentication and granted read scopes.':httpStatus===429?'Brightspace rate limit reached; try a new preview later.':'Check API connectivity and availability.';
    return Object.assign(new Error(`${label} for ${orgUnitId} failed (LP ${version||'invalid'}${httpStatus?`, HTTP ${httpStatus}`:''}). ${detail}`),{code:'REPLICATION_VALIDATION',stage,orgUnitId,httpStatus,reason:code});
  }
  async function validationRead(path,stage,orgUnitId){
    try{configured();return await read(`${root}/${path}`);}
    catch(error){throw validationFailure(error,stage,orgUnitId);}
  }
  return {
    async resolveCode(code){
      configured();const url=new URL(`${root}/orgstructure/`);url.searchParams.set('exactOrgUnitCode',code);
      const matches=await api.list(url.href);
      const ids=[...new Set(matches.filter(row=>row.Code===code).map(row=>id(row.Identifier)))];
      if(ids.length!==1)throw Error('Course code must match exactly one accessible org unit');
      return ids[0];
    },
    async source(value){
      const orgUnitId=id(value);
      // This authoritative source-specific GET must succeed. Display metadata is optional.
      const result=await validationRead(`sourceCourses/${orgUnitId}/reofferedCourses`,'source',orgUnitId);
      if(!result||!Array.isArray(result.ReofferedCourses))throw validationFailure(null,'source',orgUnitId,'INVALID_RESPONSE');
      let row;
      try{row=await validationRead(`orgstructure/${orgUnitId}`,'sourceMetadata',orgUnitId);}
      catch(error){
        if(error.httpStatus!==403)throw error;
        return {orgUnitId,name:`Source Course ${orgUnitId}`,code:null,warning:`Source Course ${orgUnitId} validated. Its display name is unavailable (HTTP 403); the source ID will be used.`};
      }
      if(String(row?.Identifier)!==orgUnitId||typeof row?.Name!=='string')throw validationFailure(null,'sourceMetadata',orgUnitId,'INVALID_RESPONSE');
      return {orgUnitId,name:row.Name,code:row.Code??null};
    },
    async target(value){
      const orgUnitId=id(value),row=await validationRead(`courses/${orgUnitId}`,'replica',orgUnitId);
      if(String(row?.Identifier)!==orgUnitId||typeof row?.Name!=='string'||typeof row?.IsActive!=='boolean')throw validationFailure(null,'replica',orgUnitId,'INVALID_RESPONSE');
      return {orgUnitId,name:row.Name,code:row.Code??null,isActive:row.IsActive};
    },
    async setActive(value,desired,beforeWrite){
      configured();const orgUnitId=id(value),url=`${root}/courses/${orgUnitId}`;
      if(typeof desired!=='boolean')throw Error('Invalid active state');
      let row,payload,token;
      const failure=(message,writeAttempted=false,verifiedActive=null,info={})=>({status:'failed',writeAttempted,verifiedActive,error:{...info,message}});
      try{
        row=await read(url);
        if(id(row.Identifier)!==orgUnitId||typeof row.IsActive!=='boolean')throw Error();
        if(row.IsActive===desired)return {status:'unchanged',writeAttempted:false,verifiedActive:desired};
        payload=courseStatusPayload(row,desired,version);
        try{token=await oauth.getAccessToken();}catch{throw {status:401};}
      }catch(error){return failure('Could not read complete course settings or obtain authorization. No status update was sent.',false,null,errorInfo(error));}
      // Persist intent before sending; storage failures must propagate to stop the worker.
      if(beforeWrite)await beforeWrite();
      let writeError;
      try{await rateLimited(()=>http({method:'PUT',url,timeout:15000,maxRedirects:0,headers:{Authorization:`Bearer ${token}`},data:payload}),beforeWrite);}catch(error){if(error.persistenceFailure)throw error;writeError=error; /* Resolve uncertain transport outcomes through read-back, never repeat PUT. */ }
      try{
        const verified=await read(url);
        if(id(verified.Identifier)!==orgUnitId)throw Error();
        const actual=courseStatusPayload(verified,desired,version);
        if(verified.IsActive!==desired||JSON.stringify(actual)!==JSON.stringify(payload))return failure('Course status or preserved settings did not verify. Inspect the offering in Brightspace.',true,verified.IsActive,errorInfo(writeError));
        return {status:'updated',writeAttempted:true,verifiedActive:desired};
      }catch(error){return failure('Status update outcome could not be verified. Inspect the offering in Brightspace.',true,null,errorInfo(writeError||error));}
    },
    async deploy(sourceId,targetIds,beforeSend){
      configured();const source=id(sourceId),targets=[...new Set(targetIds.map(id))];
      if(!targets.length||targets.length>100||targets.includes(source))throw Error('Invalid deployment targets');
      const data={TargetCourseOfferingIds:targets.map(safeNumber)};
      // Fetch credentials before recording the POST attempt. A transport loss after POST is uncertain.
      let token;try{token=await oauth.getAccessToken();}catch{return {status:'failed',writeAttempted:false,error:{httpStatus:401,message:'Token exchange failed; deployment was not sent.'},targets:targets.map(orgUnitId=>({orgUnitId,status:'failed'}))};}
      if(beforeSend)await beforeSend();
      let received;
      try{
        const response=await rateLimited(()=>http({method:'POST',url:`${root}/sourceCourses/${source}/deploy`,timeout:30000,maxRedirects:0,headers:{Authorization:`Bearer ${token}`},data}),beforeSend);
        received=response;
        if(response.status===200 && Number.isSafeInteger(response.data)&&response.data>0){return {status:'submitted',writeAttempted:true,deploymentId:String(response.data),targets:targets.map(orgUnitId=>({orgUnitId,status:'submitted'}))};}
        const body=response.data;
        if(response.status===207 && body && Array.isArray(body.FailedOrgUnitsIds)){
          const failed=body.FailedOrgUnitsIds.map(id);
          if(failed.some(x=>!targets.includes(x)))throw Error('Unexpected failed target');
          const deploymentId=body.SourceCourseDeployId==null?null:id(body.SourceCourseDeployId);
          return {status:'submittedWithErrors',writeAttempted:true,deploymentId,targets:targets.map(orgUnitId=>({orgUnitId,status:failed.includes(orgUnitId)?'failed':deploymentId?'submitted':'uncertain'})),error:{...deploymentDiagnostics(response,token),message:'Brightspace reported partial success. Check each target in Brightspace before any new deployment.'}};
        }
        throw Error('Unexpected deployment response');
      }catch(error){
        if(error.persistenceFailure)throw error;
        const httpStatus=error.response?.status;
        // A received non-success response is documented as not initiating deployment.
        const rejected=Number.isInteger(httpStatus)&&httpStatus>=400&&httpStatus<500;
        return {status:rejected?'failed':'uncertain',writeAttempted:true,error:{...deploymentDiagnostics(error.response||received,token),message:rejected?'Brightspace rejected deployment; no deployment was initiated.':'Deployment outcome is unknown. Check Brightspace before retrying; do not submit again blindly.'},targets:targets.map(orgUnitId=>({orgUnitId,status:rejected?'failed':'uncertain'}))};
      }
    }
  };
}
function courseStatusPayload(row,active,version){
  for(const key of ['Name','Code'])if(typeof row[key]!=='string')throw Error('Missing course setting');
  for(const key of ['StartDate','EndDate'])if(row[key]!==null&&(typeof row[key]!=='string'||!Number.isFinite(Date.parse(row[key]))))throw Error('Missing course date');
  if(typeof row.CanSelfRegister!=='boolean'||!row.Description)throw Error('Missing course setting');
  const description=typeof row.Description.Html==='string'?{Content:row.Description.Html,Type:'Html'}:typeof row.Description.Text==='string'?{Content:row.Description.Text,Type:'Text'}:null;
  if(!description)throw Error('Missing description');
  const payload={Name:row.Name,Code:row.Code,StartDate:row.StartDate,EndDate:row.EndDate,IsActive:active,Description:description,CanSelfRegister:row.CanSelfRegister};
  const [major,minor]=version.split('.').map(Number);
  if(major>1||minor>=54){
    if((row.LocaleId!==null&&!Number.isInteger(row.LocaleId))||typeof row.ForceLocale!=='boolean'||typeof row.ShowAddressBook!=='boolean')throw Error('Missing locale/address book setting');
    Object.assign(payload,{LocaleId:row.LocaleId,ForceLocale:row.ForceLocale,ShowAddressBook:row.ShowAddressBook});
  }
  return payload;
}
module.exports={createSourceDeploymentClient,courseStatusPayload};

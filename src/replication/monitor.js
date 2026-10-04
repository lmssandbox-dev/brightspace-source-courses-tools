 'use strict';
const {deploymentDiagnostics}=require('./diagnostics');
const {atLeast}=require('../shared/client');
const {targetStatus}=require('./outcomes');
function createCopyMonitor({store,api,leRoot,now=Date.now}){
 let busy=false;
 const supported=atLeast(new URL(leRoot).pathname.split('/').at(-1),'1.91');
 return {async tick(){
  if(busy)return;busy=true;
  try{
   const job=await store.claimCopyMonitor();if(!job)return;
   const targets=job.tasks.flatMap(task=>task.targets.filter(target=>['submitted','uncertain'].includes(targetStatus(task,target))).map(target=>({task,target})));
   const cursor=job.copyMonitorCursor||0,updates={};
   for(const {task,target} of targets.slice(cursor,cursor+10)){
    const result={checkedAt:now(),status:'Awaiting copy logs',details:''};
    try{
     if(!supported)throw Error('version');
     if(!task.submittedAt){result.status='Unable to match copy logs';result.details='This older job has no saved submission timestamp.';}
     else {
      const end=await store.nextCopySubmission(job._id,task.sourceId,target.orgUnitId,task.submittedAt);
      const url=new URL(leRoot+'/ccb/logs');url.searchParams.set('sourceOrgUnitId',task.sourceId);url.searchParams.set('destinationOrgUnitId',target.orgUnitId);url.searchParams.set('startDate',new Date(task.submittedAt).toISOString());url.searchParams.set('pageSize','100');if(end)url.searchParams.set('endDate',new Date(end).toISOString());
      const response=await api.read(url.href);
      const logs=response?.Objects;
      if(!Array.isArray(logs))throw Error('shape');
      const ids=new Set(logs.map(log=>String(log.CopyCourseJobId)));
      if(logs.some(log=>log.CopyCourseJobId==null||typeof log.Message!=='string'))throw Error('shape');
      result.status=response.Next||ids.size>1?'Unable to match copy logs':logs.length?'Copy logs available — completion unconfirmed':'Awaiting copy logs';
      result.details=logs.slice(0,10).map(log=>`Copy job ${log.CopyCourseJobId}: ${deploymentDiagnostics({data:{Message:log.Message}}).responseDetails||'Message unavailable'}`).join(' | ').slice(0,4000);
      if(response.Next||ids.size>1)result.details='Multiple copy jobs or additional log pages found. The deployment cannot be matched conclusively. '+result.details;
      if(end&&!logs.length){result.status='Unable to confirm';result.details='A newer deployment was submitted for this replica; no matching earlier logs were found.';}
     }
    }catch(error){
     const status=error.status??error.response?.status;
     if(status!==404){result.status='Monitoring unavailable';result.details=!supported?'Copy logs require LE 1.91 or later.':status===403?'The Service User needs permission to view course-copy logs.':status?`Copy log lookup returned HTTP ${status}.`:'Copy log lookup failed or returned an unexpected response.';}
    }
    updates[target.orgUnitId]=result;
   }
   const next=cursor+10>=targets.length?0:cursor+10;
   await store.saveCopyMonitor(job,updates,next,now());
  }catch{ /* Monitoring never interrupts deployments; expired claims can be retried. */ }
  finally{busy=false;}
 }};
}
module.exports={createCopyMonitor};

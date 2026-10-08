'use strict';
const {randomUUID}=require('node:crypto');

const startedAt=Symbol('bulkStatusDiagnostic');
const milliseconds=(start,end=process.hrtime.bigint())=>Number(end-start)/1e6;
function write(timing,phase,fields={},error=false){
 const entry={event:'bulk_status_timing',phase,trace:timing.trace,at:new Date().toISOString(),...fields};
 (error?console.error:console.log)(JSON.stringify(entry));
}
function installBulkStatusDiagnostics(app){
 app.use((req,res,next)=>{
  if(req.method!=='POST'||req.path!=='/bulk/status')return next();
  const timing={trace:randomUUID(),started:process.hrtime.bigint(),handlerStarted:null,phaseDurations:{},size:'unknown',stage:'before_lti'};
  Object.defineProperty(req,startedAt,{value:timing});
  write(timing,'request_start',{size:timing.size});
  res.once('finish',()=>{
   const ended=process.hrtime.bigint();
   write(timing,'request_complete',{status:res.statusCode,size:timing.size,middleware_ms:timing.handlerStarted===null?milliseconds(timing.started,ended):milliseconds(timing.started,timing.handlerStarted),handler_ms:timing.handlerStarted===null?null:milliseconds(timing.handlerStarted,ended),authorization_ms:timing.phaseDurations.authorization??null,get_status_ms:timing.phaseDurations.get_status??null,render_ms:timing.phaseDurations.render??null,total_ms:milliseconds(timing.started,ended)});
  });
  res.once('close',()=>{
   if(!res.writableFinished){const ended=process.hrtime.bigint();write(timing,'response_closed',{size:timing.size,middleware_ms:timing.handlerStarted===null?milliseconds(timing.started,ended):milliseconds(timing.started,timing.handlerStarted),handler_ms:timing.handlerStarted===null?null:milliseconds(timing.handlerStarted,ended),total_ms:milliseconds(timing.started,ended),stage:timing.stage},true);}
  });
  next();
 });
}
function markBulkStatusHandler(req){
 const timing=req[startedAt];if(!timing)return null;
 timing.handlerStarted=process.hrtime.bigint();timing.stage='authorization';
 write(timing,'handler_entry',{middleware_ms:milliseconds(timing.started,timing.handlerStarted),size:timing.size});
 return timing;
}
function startBulkStatusPhase(req,name){
 const started=process.hrtime.bigint(),timing=req[startedAt];
 if(timing){timing.stage=name;write(timing,`${name}_start`,{size:timing.size});}
 return started;
}
function recordBulkStatusPhase(req,name,start){
 const timing=req[startedAt];if(!timing)return;
 const duration=milliseconds(start);timing.phaseDurations[name]=duration;
 timing.stage=name;
 write(timing,`${name}_complete`,{duration_ms:duration,size:timing.size});
}
function setBulkStatusSize(req,job){
 const timing=req[startedAt];if(!timing)return;
 const courses=Number(job?.courseTotal),activities=Number(job?.totals?.total);
 if(Number.isFinite(courses)||Number.isFinite(activities))timing.size=(courses>=1000||activities>=10000)?'large':'small';
}
function recordBulkStatusError(req,stage,error){
 const timing=req[startedAt];if(!timing)return;
 timing.stage=stage;
 const name=typeof error?.name==='string'&&/^[A-Za-z0-9_.:-]{1,60}$/.test(error.name)?error.name:'Error';
 write(timing,'request_error',{stage,error:name,size:timing.size},true);
}
module.exports={installBulkStatusDiagnostics,markBulkStatusHandler,startBulkStatusPhase,recordBulkStatusPhase,setBulkStatusSize,recordBulkStatusError};

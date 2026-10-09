'use strict';
const {parse}=require('csv-parse/sync');
const {id}=require('../shared/id');
const {pool}=require('../shared/pool');
const COMPONENTS='AttendanceRegisters Awards Checklists Competencies CompletionTracking Content CourseAppearance CourseFiles Discussions DisplaySettings Dropbox Faq Forms Glossary Grades GradesSettings Groups Homepages IntelligentAgents LearningOutcomes Links LtiLink LtiTP Navbars News QuestionLibrary Quizzes ReleaseConditions Rubrics S3Model Schedule SelfAssessments Surveys ToolNames Widgets'.split(' ');
const HEADERS=['OriginOrgUnitId','OriginOrgUnitCode','DestinationOrgUnitId','DestinationOrgUnitCode'];
const invalid=message=>Object.assign(Error(message),{code:'INVALID_CSV'});
const terminalCopy=new Set(['COMPLETE','COMPLETE_WITH_ERRORS','FAILED','CANCELLED']);
function selection(mode,values){
 if(mode==='all')return null;
 const selected=Array.isArray(values)?values:values?[values]:[];
 if(mode!=='selected'||!selected.length||selected.some(v=>!COMPONENTS.includes(v)))throw invalid('Select at least one valid component, or choose Copy all components.');
 return [...new Set(selected)];
}
function parseCopyCsv(text){
 if(typeof text!=='string'||Buffer.byteLength(text)>5*1024*1024)throw invalid('Use a UTF-8 CSV of at most 5 MB.');
 let records;try{records=parse(text,{bom:true,trim:true,skip_empty_lines:true});}catch{throw invalid('Malformed CSV.');}
 const header=records.shift();
 if(header?.length!==4||!HEADERS.every(h=>header.includes(h)))throw invalid('Headers must be OriginOrgUnitId,OriginOrgUnitCode,DestinationOrgUnitId,DestinationOrgUnitCode.');
 if(!records.length||records.length>10000)throw invalid('Provide between 1 and 10,000 mappings.');
 return records.map((record,i)=>{
  const row={row:i+2,status:'pending'};
  try{
   for(const [side,prefix] of [['origin','Origin'],['destination','Destination']]){
    const raw=record[header.indexOf(prefix+'OrgUnitId')];
    row[side+'Id']=raw?id(raw):'';row[side+'Code']=record[header.indexOf(prefix+'OrgUnitCode')];
    if(!row[side+'Id']&&!row[side+'Code'])throw Error();
    if(raw&&!Number.isSafeInteger(Number(row[side+'Id'])))throw Error();
   }
  }catch{row.status='invalid';row.message='Provide a valid ID or code for both origin and destination.';}
  return row;
 });
}
function createCopyJobs({client,now=Date.now}){
 async function resolve(row,side){
  let value=row[side+'Id'];const code=row[side+'Code'];
  if(code){const resolved=await client.resolveCode(code);if(value&&value!==resolved)throw Error('ID and code identify different org units.');value=resolved;}
  if(!Number.isSafeInteger(Number(value)))throw Error('Org-unit ID exceeds supported numeric precision');row[side+'Id']=value;return value;
 }
 function finish(job){
  job.status=job.tasks.length&&job.tasks.every(t=>t.result?.status==='COMPLETE')?'copiesConcluded':job.tasks.some(t=>t.result?.jobToken&&!terminalCopy.has(t.result.status))?'copiesInProcess':'copyNeedsAttention';
 }
 return {parse:parseCopyCsv,selection,
  async plan(job,save,checkCancelled=async()=>{}){
   const startedAt=now();job.copyStep2ElapsedMs=Number(job.copyStep2ElapsedMs)||0;job.copyStep2StartedAt=startedAt;job.copyStep2ProgressAt=startedAt;
   job.copyStep2SampleAt=startedAt;job.copyStep2SampleProcessed=job.rows.filter(r=>r.status!=='pending').length;job.copyStep2SampleCount=0;job.copyStep2RatePerMs=0;
   const destinations=new Map();
   const resolveMetadata=client.prepareResolution?await client.prepareResolution(job.rows,checkCancelled,async()=>{},{direct:true}):null;
   const resolveRow=async(row,side)=>{
    if(!resolveMetadata)return resolve(row,side);
    const course=await resolveMetadata(row,side);row[side+'Id']=course.orgUnitId;row[side+'Name']=course.name;return course.orgUnitId;
   };
   let processed=job.rows.filter(r=>r.status!=='pending').length;
   job.progress={phase:'mappings',processed,total:job.rows.length};job.copyStep2SampleAt=now();job.copyStep2SampleProcessed=processed;job.copyStep2ProgressAt=job.copyStep2SampleAt;await save(job);
   await pool(job.rows,8,async row=>{
    await checkCancelled();
    if(row.status!=='pending')return;
    try{
     const origin=await resolveRow(row,'origin'),destination=await resolveRow(row,'destination');
     if(origin===destination)throw Error('Origin and destination must differ.');
     const previous=destinations.get(destination);
     if(previous){if(previous.originId===origin){row.status='duplicate';row.message='Duplicate mapping; copied once.';}else {previous.status='invalid';previous.message='Each destination must have only one origin per job.';throw Error(previous.message);}}
     if(!previous){
     destinations.set(destination,row);row.status='valid';
     job.tasks.push({row:row.row,originId:origin,destinationId:destination});}
    }catch(error){if(error.code==='JOB_CANCELLED'||error.persistenceFailure)throw error;row.status='invalid';row.message=error.message;}
    job.progress={phase:'mappings',processed:++processed,total:job.rows.length};
    if(job.progress.processed%25===0){
     const sampledAt=now(),sampleProcessed=job.progress.processed,priorAt=Number(job.copyStep2SampleAt),priorProcessed=Number(job.copyStep2SampleProcessed)||0;
     if(Number.isFinite(priorAt)&&sampledAt>priorAt&&sampleProcessed>priorProcessed){const observed=(sampleProcessed-priorProcessed)/(sampledAt-priorAt);job.copyStep2RatePerMs=job.copyStep2RatePerMs>0?job.copyStep2RatePerMs*.7+observed*.3:observed;job.copyStep2SampleCount=(Number(job.copyStep2SampleCount)||0)+1;}
     job.copyStep2SampleAt=sampledAt;job.copyStep2SampleProcessed=sampleProcessed;job.copyStep2ProgressAt=sampledAt;
     await save(job);
    }
   });
   // Avoid order-dependent chains where a destination is also another mapping's origin.
   const origins=new Set(job.tasks.map(t=>t.originId)),destinationIds=new Set(job.tasks.map(t=>t.destinationId));
   for(const row of job.rows)if(row.status==='valid'&&(origins.has(row.destinationId)||destinationIds.has(row.originId))){row.status='invalid';row.message='A destination cannot also be an origin in the same job.';}
   const eligibleRows=new Set(job.rows.filter(r=>r.status==='valid').map(r=>r.row));
   job.tasks=job.tasks.filter(t=>eligibleRows.has(t.row));
   job.status=!job.tasks.length?'failed':'ready';job.expiresAt=now()+30*60*1000;
   job.copyStep2ElapsedMs=(Number(job.copyStep2ElapsedMs)||0)+Math.max(0,now()-startedAt);job.copyStep2StartedAt=null;
  },
  async execute(job,save,renew){
   if(job.operation==='check'){
    const eligible=job.tasks.filter(task=>task.result?.jobToken&&!terminalCopy.has(task.result.status));
    const startedAt=now();job.copyCheckElapsedMs=0;job.copyCheckStartedAt=startedAt;job.copyCheckProgressAt=startedAt;
    job.copyCheckProgress={processed:0,total:eligible.length,completed:0,stillProcessing:0,needsReview:0};
    await pool(job.tasks,8,async(task,index)=>{
     const result=task.result;if(!result?.jobToken||terminalCopy.has(result.status))return;
     await renew();
     try{result.status=await client.check(task.destinationId,result.jobToken);delete result.message;result.checkedAt=now();}
     catch{result.message='Status check unavailable. Saved results retained; try checking again.';}
     job.copyCheckProgress.processed++;
     if(result.message==='Status check unavailable. Saved results retained; try checking again.'||['COMPLETE_WITH_ERRORS','FAILED','CANCELLED'].includes(result.status))job.copyCheckProgress.needsReview++;
     else if(result.status==='COMPLETE')job.copyCheckProgress.completed++;
     else if(['PENDING','PROCESSING'].includes(result.status))job.copyCheckProgress.stillProcessing++;
     job.copyCheckProgressAt=now();
     await save(job,{tasks:[index]});
    });
    finish(job);job.copyCheckElapsedMs=Math.max(0,now()-startedAt);job.copyCheckStartedAt=null;return;
   }
   let stop=false;
   const startedAt=now();job.copyStep3ElapsedMs=Number(job.copyStep3ElapsedMs)||0;job.copyStep3StartedAt=startedAt;job.copyStep3ProgressAt=startedAt;
   await pool(job.tasks,8,async(task,index)=>{
    if(task.result)return;
    if(stop){task.result={status:'notAttempted',message:'Stopped after an authentication, transport, or server failure.'};await save(job,{tasks:[index]});return;}
    // A durable checkpoint precedes each POST. A restart never repeats an in-flight copy.
    await renew();task.result={status:'uncertain',submissionIntent:true,message:'Submission outcome unconfirmed. Inspect Brightspace before creating another copy.'};await save(job,{tasks:[index]});
    const result=await client.copy(task.originId,task.destinationId,job.components,renew);
    task.result=result;stop ||= result.status==='uncertain'||Boolean(result.systemic);
    if(result.status!=='notAttempted')job.copyStep3ProgressAt=now();
    await save(job,{tasks:[index]});
   });
   finish(job);
   job.copyStep3ElapsedMs=(Number(job.copyStep3ElapsedMs)||0)+Math.max(0,now()-startedAt);job.copyStep3StartedAt=null;
  }
 };
}
module.exports={COMPONENTS,HEADERS,selection,parseCopyCsv,createCopyJobs,terminalCopy};

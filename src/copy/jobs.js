'use strict';
const {parse}=require('csv-parse/sync');
const {id}=require('../shared/id');
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
  const course=await client[side](value);row[side+'Id']=value;row[side+'Name']=course.name;return value;
 }
 function finish(job){
  job.status=job.tasks.length&&job.tasks.every(t=>t.result?.status==='COMPLETE')?'copiesConcluded':job.tasks.some(t=>t.result?.jobToken&&!terminalCopy.has(t.result.status))?'copiesInProcess':'copyNeedsAttention';
 }
 return {parse:parseCopyCsv,selection,
  async plan(job,save,checkCancelled=async()=>{}){
   const destinations=new Map();
   for(const row of job.rows){
    await checkCancelled();
    if(row.status!=='pending')continue;
    try{
     const origin=await resolve(row,'origin'),destination=await resolve(row,'destination');
     if(origin===destination)throw Error('Origin and destination must differ.');
     const previous=destinations.get(destination);
     if(previous){if(previous.originId===origin){row.status='duplicate';row.message='Duplicate mapping; copied once.';continue;}throw Error('Each destination must have only one origin per job.');}
     destinations.set(destination,row);row.status='valid';
     job.tasks.push({row:row.row,originId:origin,destinationId:destination});
    }catch(error){row.status='invalid';row.message=error.message;}
    job.progress={processed:job.rows.filter(r=>r.status!=='pending').length,total:job.rows.length};
    if(job.progress.processed%25===0)await save(job);
   }
   // Avoid order-dependent chains where a destination is also another mapping's origin.
   const origins=new Set(job.tasks.map(t=>t.originId));
   for(const row of job.rows)if(row.status==='valid'&&origins.has(row.destinationId)){row.status='invalid';row.message='A destination cannot also be an origin in the same job.';}
   job.status=job.rows.some(r=>r.status==='invalid')||!job.tasks.length?'failed':'ready';job.expiresAt=now()+30*60*1000;
  },
  async execute(job,save,renew){
   if(job.operation==='check'){
    for(const task of job.tasks){
     const result=task.result;if(!result?.jobToken||terminalCopy.has(result.status))continue;
     await renew();
     try{result.status=await client.check(task.destinationId,result.jobToken);delete result.message;result.checkedAt=now();}
     catch{result.message='Status check unavailable. Saved results retained; try checking again.';}
     await save(job);
    }
    finish(job);return;
   }
   let stop=false;
   for(const task of job.tasks){
    if(task.result)continue;
    if(stop){task.result={status:'notAttempted',message:'Stopped after an authentication, transport, or server failure.'};continue;}
    // A durable checkpoint precedes each POST. A restart never repeats an in-flight copy.
    await renew();task.result={status:'uncertain',message:'Submission outcome unconfirmed. Inspect Brightspace before creating another copy.'};await save(job);
    const result=await client.copy(task.originId,task.destinationId,job.components,renew);
    task.result=result;stop=result.status==='uncertain'||result.systemic;
    await save(job);
   }
   finish(job);
  }
 };
}
module.exports={COMPONENTS,HEADERS,selection,parseCopyCsv,createCopyJobs,terminalCopy};

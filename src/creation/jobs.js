'use strict';
const {parse}=require('csv-parse/sync');
const {id}=require('../shared/id');
const {pool}=require('../shared/pool');
const HEADERS=['SourceCourseName','SourceCourseCode','TemplateId','TemplateCode'];
const invalid=message=>Object.assign(Error(message),{code:'INVALID_CSV'});
function parseCreationCsv(text){
 if(typeof text!=='string'||Buffer.byteLength(text)>5*1024*1024)throw invalid('Use a UTF-8 CSV of at most 5 MB.');
 let records;try{records=parse(text,{bom:true,trim:false,skip_empty_lines:true,relax_column_count:false,info:true});}catch{throw invalid('Malformed CSV.');}
 const header=records.shift()?.record;if(header?.length!==4||new Set(header).size!==4||!HEADERS.every(h=>header.includes(h)))throw invalid(`Headers must be ${HEADERS.join(',')}.`);
 if(!records.length||records.length>10000)throw invalid('Provide between 1 and 10,000 source courses.');
 return records.map(({record,info})=>{const sourceCourseNameInput=record[header.indexOf(HEADERS[0])]||'',sourceCourseCodeInput=record[header.indexOf(HEADERS[1])]||'',templateIdInputRaw=record[header.indexOf(HEADERS[2])]||'',templateCodeInput=record[header.indexOf(HEADERS[3])]||'';return {row:info.lines-record.reduce((n,value)=>n+(String(value).match(/\n/g)||[]).length,0),sourceCourseNameInput,sourceCourseCodeInput,templateIdInputRaw,templateCodeInput,sourceCourseName:sourceCourseNameInput.trim(),sourceCourseCode:sourceCourseCodeInput.trim(),templateIdInput:templateIdInputRaw.trim(),templateCode:templateCodeInput.trim(),status:'pending'};});
}
const typeOf=r=>String(r?.Type?.Code||'').replace(/[^a-z]/gi,'').toLowerCase();
function createCreationJobs({client,orgResolver,store:directoryStore,now=Date.now}){
 async function resolveTemplate(row,session){
  let record;
  if(row.templateIdInput){const templateId=id(row.templateIdInput);if(!Number.isSafeInteger(Number(templateId)))throw Error('Template ID is invalid.');record=await client.orgUnit(templateId);if(String(record.Identifier)!==templateId)throw Error('Template ID did not match the returned organizational unit.');if(row.templateCode&&record.Code!==row.templateCode)throw Error('Template ID and code identify different organizational units.');}
  else {const matches=await session.resolve(row.templateCode);record=matches;}
  if(typeOf(record)!=='coursetemplate')throw Error('The selected parent is not a Course Template.');
  row.templateId=id(record.Identifier);row.resolvedTemplateCode=record.Code||row.templateCode;return record;
 }
 return {
  parse:parseCreationCsv,
  async plan(job,save,check=async()=>{}){
   const started=now();job.tasks=[];for(const row of job.rows){row.status='pending';delete row.message;delete row.templateId;delete row.resolvedTemplateCode;}const codes=job.rows.map(r=>r.templateCode).filter(Boolean),session=await orgResolver.prepare(codes,check),codeCounts=new Map(),sourceCache=new Map();for(const row of job.rows)if(row.sourceCourseCode)codeCounts.set(row.sourceCourseCode,(codeCounts.get(row.sourceCourseCode)||0)+1);let processed=0;
   job.progress={phase:'templates',processed:0,total:job.rows.length};job.step2ElapsedMs=Number(job.step2ElapsedMs)||0;job.step2StartedAt=started;job.step2ProgressAt=started;await save(job);
   await pool(job.rows,4,async row=>{
    await check();if(!row.sourceCourseName.trim()||!row.sourceCourseCode.trim()){row.status='invalid';row.message='Source Course name and code are required.';}
    else if(Boolean(row.templateIdInput)===Boolean(row.templateCode)){row.status='invalid';row.message='Provide exactly one of TemplateId or TemplateCode.';}
    else {
     try{
      if(codeCounts.get(row.sourceCourseCode)>1){row.status='invalid';row.message='Duplicate Source Course code in CSV; every row with this code was excluded.';}
      else {const parent=await resolveTemplate(row,session);const existing=sourceCache.has(row.sourceCourseCode)?sourceCache.get(row.sourceCourseCode):await client.exactCode(row.sourceCourseCode);sourceCache.set(row.sourceCourseCode,existing);
       if(existing.length){const source=existing.filter(r=>typeOf(r)==='sourcecourse');if(existing.length===1&&source.length===1){row.status='skipped';row.message='A Source Course with this code already exists.';}else {row.status='invalid';row.message='This code belongs to another organizational-unit type or is ambiguous.';}}
       else {row.status='eligible';row.templateId=id(parent.Identifier);job.tasks.push({row:row.row,Name:row.sourceCourseName,Code:row.sourceCourseCode,TemplateId:row.templateId,TemplateCode:row.resolvedTemplateCode,result:null});}
      }
     }catch(error){if(error.code==='JOB_CANCELLED'||error.persistenceFailure)throw error;row.status='invalid';row.message=error.code==='CODE_NOT_UNIQUE'?'Template code is ambiguous.':error.code==='CODE_NOT_FOUND'?'Template code was not found.':error.message==='Course code was not found by the Brightspace exact-code lookup.'?'Template code was not found.':'Template could not be verified as a Course Template.';}
    }
    job.progress={phase:'templates',processed:++processed,total:job.rows.length};job.step2ProgressAt=now();if(processed%100===0)await save(job);
   });
   job.tasks.sort((a,b)=>a.row-b.row);job.status=job.tasks.length?'ready':'failed';job.expiresAt=now()+30*60*1000;job.step2ElapsedMs+=Math.max(0,now()-started);job.step2StartedAt=null;job.step2ProgressAt=now();job.progress={phase:'validated',processed:job.rows.length,total:job.rows.length};
  },
  async execute(job,save,renew,isCancelled=async()=>false){
   const start=now();job.step3ElapsedMs=Number(job.step3ElapsedMs)||0;job.step3StartedAt=start;job.step3ProgressAt=start;let stop=false;
   // Registration retries are database-only. A confirmed POST is never repeated.
   for(let i=0;i<job.tasks.length;i++){const task=job.tasks[i];if(task.result?.status==='created'&&task.result.registration!=='ready'){await renew();await this.register(task,job,save,i);}}
   let cursor=0,fatalError=null;const workers=Array.from({length:Math.min(8,job.tasks.length)},async()=>{while(true){const index=cursor++;if(index>=job.tasks.length)return;const task=job.tasks[index];if(task.result)continue;
    try{
    if(stop||job.cancelRequestedAt||await isCancelled(job._id,job.owner)){task.result={status:'notAttempted',message:'Not started because processing was stopped.'};job.step3ProgressAt=now();await save(job,{tasks:[index]});continue;}
    await renew();task.result={status:'uncertain',submissionIntent:true,message:'Creation outcome unconfirmed. Check Brightspace before retrying.'};await save(job,{tasks:[index]});
    // Recheck live code immediately before dispatch to reduce stale-preview conflicts.
    let check;try{check=await client.exactCode(task.Code);}catch(e){task.result={status:'failed',systemic:true,message:'Existing-code check failed; no creation request was sent.'};stop=true;job.step3ProgressAt=now();await save(job,{tasks:[index]});continue;}
    if(check.length){task.result=check.every(r=>typeOf(r)==='sourcecourse')?{status:'skipped',message:'A Source Course with this code now exists; no creation request was sent.'}:{status:'failed',message:'This code now belongs to another organizational-unit type; no creation request was sent.'};job.step3ProgressAt=now();await save(job,{tasks:[index]});continue;}
    const result=await client.create(task,()=>renew());
    if(result.status!=='created'){task.result={...result};stop ||= Boolean(result.systemic)||result.status==='uncertain';job.step3ProgressAt=now();await save(job,{tasks:[index]});continue;}
    task.result={status:'created',CreatedOrgUnitId:result.orgUnitId,registration:'pending',createdAt:now(),message:'Created in Brightspace; registering in Org Library.'};job.step3ProgressAt=now();await save(job,{tasks:[index]});await this.register(task,job,save,index);
    }catch(error){fatalError ||= error;stop=true;throw error;}
   }});
   const settled=await Promise.allSettled(workers);if(fatalError)throw fatalError;const rejected=settled.find(r=>r.status==='rejected');if(rejected)throw rejected.reason;
   if(job.cancelRequestedAt||await isCancelled(job._id,job.owner)){for(let i=0;i<job.tasks.length;i++)if(!job.tasks[i].result){job.tasks[i].result={status:'notAttempted',message:'Not started because the job was cancelled.'};await save(job,{tasks:[i]});}job.status='cancelled';job.message='Cancelled. Confirmed creations and registration outcomes are retained.';}
   else if(job.tasks.some(t=>t.result?.registration==='pending')){job.status='queued';job.resuming=true;job.message='Confirmed Source Courses are awaiting Org Library registration. Brightspace creation requests will not be repeated.';}
   else {job.status=job.tasks.some(t=>['failed','uncertain'].includes(t.result?.status))?'completedWithErrors':'completed';}
   job.step3ElapsedMs+=Math.max(0,now()-start);job.step3StartedAt=null;job.step3ProgressAt=now();
  },
  async register(task,job,save,index){try{await directoryStore.registerCreated({Identifier:task.result.CreatedOrgUnitId,Name:task.Name,Code:task.Code,createdAt:task.result.createdAt,provenance:`bulk-source-creator:${job._id}:${task.row}`});task.result.registration='ready';task.result.message='Created and registered in the Org Library.';job.step3ProgressAt=now();await save(job,{tasks:[index]});}catch(error){task.result.registration='pending';task.result.message='Created in Brightspace; Org Library registration is pending.';job.step3ProgressAt=now();await save(job,{tasks:[index]});throw Object.assign(error,{registrationFailure:true});}}
 };
}
module.exports={HEADERS,parseCreationCsv,createCreationJobs};

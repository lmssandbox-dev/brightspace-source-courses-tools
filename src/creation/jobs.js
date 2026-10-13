'use strict';
const {parse}=require('csv-parse/sync');
const {id}=require('../shared/id');
const {pool}=require('../shared/pool');
const HEADERS=['SourceCourseName','SourceCourseCode','TemplateId','TemplateCode','DepartmentIds','DepartmentCodes'];
const invalid=message=>Object.assign(Error(message),{code:'INVALID_CSV'});
function parseCreationCsv(text){
 if(typeof text!=='string'||Buffer.byteLength(text)>5*1024*1024)throw invalid('Use a UTF-8 CSV of at most 5 MB.');
 let records;try{records=parse(text,{bom:true,trim:false,skip_empty_lines:true,relax_column_count:false,info:true});}catch{throw invalid('Malformed CSV.');}
 const header=records.shift()?.record;if(header?.length!==HEADERS.length||new Set(header).size!==HEADERS.length||!HEADERS.every(h=>header.includes(h)))throw invalid(`Headers must be ${HEADERS.join(',')}.`);
 if(!records.length||records.length>10000)throw invalid('Provide between 1 and 10,000 source courses.');
 return records.map(({record,info})=>{const values=Object.fromEntries(HEADERS.map(name=>[name,record[header.indexOf(name)]||'']));return {row:info.lines-record.reduce((n,value)=>n+(String(value).match(/\n/g)||[]).length,0),sourceCourseNameInput:values.SourceCourseName,sourceCourseCodeInput:values.SourceCourseCode,templateIdInputRaw:values.TemplateId,templateCodeInput:values.TemplateCode,departmentIdsInput:values.DepartmentIds,departmentCodesInput:values.DepartmentCodes,sourceCourseName:values.SourceCourseName.trim(),sourceCourseCode:values.SourceCourseCode.trim(),templateIdInput:values.TemplateId.trim(),templateCode:values.TemplateCode.trim(),departmentIds:values.DepartmentIds.trim(),departmentCodes:values.DepartmentCodes.trim(),status:'pending'};});
}
const typeOf=r=>String(r?.Type?.Code||'').replace(/[^a-z]/gi,'').toLowerCase();
const lifecycleOf=r=>r?.lifecycle||'unknown';
const positiveId=value=>{try{const valueId=id(value);return /^[1-9]\d*$/.test(valueId)&&Number.isSafeInteger(Number(valueId))?valueId:null;}catch{return null;}};
function parseParents(value,isId){
 if(!value)return [];
 const parts=value.split('|').map(part=>part.trim());
 if(parts.some(part=>!part)||new Set(parts).size!==parts.length)throw Error('Department identifiers must be nonempty and unique.');
 if(isId&&parts.some(part=>!positiveId(part)))throw Error('Department IDs must be positive integers.');
 return parts;
}
function createCreationJobs({client,orgResolver,store:directoryStore,now=Date.now}){
 const templateType=record=>typeOf(record)==='coursetemplate';
 const departmentType=record=>orgResolver.isStandardDepartment(record);
 async function resolveTemplate(row,session,byId,cache){
  let record;
  if(row.templateIdInput){const key=positiveId(row.templateIdInput);if(!key)throw Error('Template ID is invalid.');
   if(!cache.has(`id:${key}`))cache.set(`id:${key}`,(async()=>{let found=byId.get(key);if(!found)found=await client.orgUnit(key);if(found.Identifier==null||String(found.Identifier)!==key||!templateType(found))throw Error('The selected parent is not a Course Template.');if(lifecycleOf(found)!=='current')throw Error('Course Template lifecycle evidence is unavailable or not current; refresh the Org Library.');return found;})());record=await cache.get(`id:${key}`);
   if(row.templateCode&&row.templateCode!==record.Code)throw Error('Template ID and code identify different organizational units.');
  } else {const key=`code:${row.templateCode}`;if(!cache.has(key))cache.set(key,session.resolve(row.templateCode));record=await cache.get(key);if(!templateType(record))throw Error('The selected parent is not a Course Template.');}
  row.templateId=id(record.Identifier);row.resolvedTemplateCode=record.Code||row.templateCode;return record;
 }
 async function resolveDepartment(row,session,byId,cache){
  const idInputs=parseParents(row.departmentIds,true),codeInputs=parseParents(row.departmentCodes,false);
  if(Boolean(idInputs.length)===Boolean(codeInputs.length))throw Error('Provide exactly one of DepartmentIds or DepartmentCodes.');
  const records=[];
  for(const value of idInputs){const key=`id:${value}`;if(!cache.has(key))cache.set(key,(async()=>{let record=byId.get(value);if(!record)record=await client.orgUnit(value);if(String(record.Identifier)!==value||!departmentType(record))throw Error('The selected organizational unit is not the configured Standard Department.');if(lifecycleOf(record)!=='current')throw Error('Department lifecycle evidence is unavailable or not current; refresh the Org Library.');return record;})());records.push(await cache.get(key));}
  for(const value of codeInputs){const key=`code:${value}`;if(!cache.has(key))cache.set(key,session.resolve(value));const record=await cache.get(key);if(!departmentType(record))throw Error('The selected code does not identify a Standard Department.');records.push(record);}
  if(new Set(records.map(record=>id(record.Identifier))).size!==records.length)throw Error('Department identifiers resolve to duplicate Departments.');
  records.sort((a,b)=>id(a.Identifier).localeCompare(id(b.Identifier),undefined,{numeric:true}));
  return {ids:records.map(record=>id(record.Identifier)),codes:records.map(record=>String(record.Code||''))};
 }
 async function getCodeMatches(codes,check){
  if(orgResolver.lookupMatches)return orgResolver.lookupMatches(codes,check);
  const output=new Map();await pool(codes,8,async code=>output.set(code,await client.exactCode(code)),async()=>{await check();return true;});return output;
 }
const affected=task=>Boolean(task.result?.submissionAttempted||task.result?.submissionIntent||task.result?.status==='created'||task.result?.status==='uncertain');
 async function reconcile(job,save,renew,templateIds){
  const plans=job.templateReconciliationPlan||[],map=job.templateReconciliation||(job.templateReconciliation={});
  const selected=Array.isArray(templateIds)?new Set(templateIds):null;
  const active=plans.filter(plan=>(!selected||selected.has(plan.templateId))&&(job.tasks||[]).some(task=>task.TemplateId===plan.templateId&&affected(task)));
  if(!active.length)return;
  let rootId=positiveId(job.templateReconciliationRootOrgUnitId);
  if(!rootId){
   try{await renew();rootId=positiveId(await client.rootOrgUnitId());if(!rootId)throw Error('Root Organization could not be identified safely.');job.templateReconciliationRootOrgUnitId=rootId;job.step3ProgressAt=now();await save(job,{});}
   catch(error){if(error.persistenceFailure||error.workerLease)throw error;for(const plan of active){const entry=map[plan.templateId]||(map[plan.templateId]={templateId:plan.templateId,status:'Failed',operations:{}});entry.status='Failed';entry.message='Unable to identify the Root Organization safely.';}job.step3ProgressAt=now();await save(job,{});return;}
  }
  await pool(active,4,async plan=>{
   const key=plan.templateId,entry=map[key]||(map[key]={templateId:key,status:'pending',operations:{}});
   const saveEntry=async()=>{job.step3ProgressAt=now();await save(job,{});};
   const getParents=async()=>{await renew();const parents=await client.parents(key);if(!Array.isArray(parents))throw Error('Parent lookup returned an invalid response.');const parentIds=[];for(const parent of parents){const parentId=positiveId(parent?.Identifier);if(!parentId)throw Error('Parent lookup contained an invalid organizational-unit ID.');parentIds.push(parentId);}return [...new Set(parentIds)];};
   const priorUncertain=Object.values(entry.operations||{}).some(operation=>['intent','uncertain'].includes(operation.status));
   try{
    if(priorUncertain){
     entry.status='recovering';let parents;try{parents=await getParents();}catch(error){throw Object.assign(error,{uncertain:true});}
     for(const operation of Object.values(entry.operations||{})){if(!['intent','uncertain'].includes(operation.status))continue;const present=parents.includes(operation.parentId);operation.status=operation.kind==='add'?(present?'succeeded':'pending'):(present?'pending':'succeeded');operation.message=operation.status==='succeeded'?'Confirmed by a read-only parent lookup.':'Safe to retry after a read-only parent lookup.';}await saveEntry();
    }
    for(const departmentId of plan.departmentIds){const opKey=`add:${departmentId}`,operation=entry.operations[opKey]||(entry.operations[opKey]={kind:'add',parentId:departmentId,status:'pending'});if(operation.status==='succeeded')continue;if(operation.status==='failed')throw Error('A prior Department parent addition failed.');
     operation.status='intent';operation.message='Department parent addition will be submitted.';operation.diagnostics={operation:'addParent',httpMethod:'POST',endpointPattern:'/d2l/api/lp/{LP}/orgstructure/{templateId}/parents/',templateId:key,parentOrgUnitId:departmentId,requestDispatched:null,responseReceived:false,responseConfirmedSuccess:false};await saveEntry();await renew();
     const result=await client.addParent(key,departmentId,()=>renew());operation.status=result.status;operation.message=result.message||'';if(result.diagnostics)operation.diagnostics=result.diagnostics;await saveEntry();if(result.status==='uncertain')throw Object.assign(Error('Parent addition outcome is uncertain.'),{uncertain:true});if(result.status!=='succeeded')throw Error('Parent addition failed.');
    }
    const opKey=`remove:${rootId}`,operation=entry.operations[opKey]||(entry.operations[opKey]={kind:'remove',parentId:rootId,status:'pending'});if(operation.status==='failed')throw Error('A prior Root Organization parent removal failed.');if(operation.status!=='succeeded'){
     operation.status='intent';operation.message='Root parent removal will be submitted after Department additions.';operation.diagnostics={operation:'removeParent',httpMethod:'DELETE',endpointPattern:'/d2l/api/lp/{LP}/orgstructure/{templateId}/parents/{parentOrgUnitId}',templateId:key,parentOrgUnitId:rootId,requestDispatched:null,responseReceived:false,responseConfirmedSuccess:false};await saveEntry();await renew();const result=await client.removeParent(key,rootId,()=>renew());operation.status=result.status;operation.message=result.message||'';if(result.diagnostics)operation.diagnostics=result.diagnostics;await saveEntry();if(result.status==='uncertain')throw Object.assign(Error('Root parent removal outcome is uncertain.'),{uncertain:true});if(result.status!=='succeeded')throw Error('Root parent removal failed.');
    }
    entry.status='Updated';entry.message='Parent relationship updates completed successfully.';
   }catch(error){if(error.persistenceFailure||error.workerLease)throw error;entry.status=error.uncertain?'Uncertain':'Failed';entry.message=error.uncertain?'Parent update outcome is uncertain.':'Unable to restore the intended Department relationships.';entry.errorCode=String(error.code||'').slice(0,80);}
   await saveEntry();
  });
 }
 return {
  parse:parseCreationCsv,
  async plan(job,save,check=async()=>{},saveProgress=async(_job,fields)=>{Object.assign(job,fields);await save(job);return true;}){
   const started=now();job.tasks=[];job.templateReconciliationPlan=[];job.templateReconciliation={};
   const recheckEnabled=Boolean(job.liveSourceCourseRecheck?.enabled);job.liveSourceCourseRecheck={enabled:recheckEnabled,status:'pending',candidateCount:0,checkedCount:0,startedAt:null,progressAt:null,elapsedMs:0,ratePerMs:0};
   for(const row of job.rows){row.status='pending';delete row.message;delete row.templateId;delete row.resolvedTemplateCode;delete row.resolvedDepartmentIds;delete row.resolvedDepartmentCodes;}
   const templateCodes=job.rows.map(row=>row.templateCode).filter(Boolean),departmentCodes=job.rows.flatMap(row=>{try{return parseParents(row.departmentCodes,false);}catch{return []}}),session=await orgResolver.prepare([...new Set([...templateCodes,...departmentCodes])],check);
   const codeCounts=new Map();for(const row of job.rows)if(row.sourceCourseCode)codeCounts.set(row.sourceCourseCode,(codeCounts.get(row.sourceCourseCode)||0)+1);
   const identifierInputs=[...new Set(job.rows.flatMap(row=>[row.templateIdInput,...(row.departmentIds?row.departmentIds.split('|').map(value=>value.trim()):[])].filter(Boolean).map(value=>positiveId(value)).filter(Boolean)))];
   const byId=orgResolver.lookupByIds?await orgResolver.lookupByIds(identifierInputs):new Map();
   const templateCache=new Map(),departmentCache=new Map();let processed=0;
   job.progress={phase:'templates',processed:0,total:job.rows.length};job.step2ElapsedMs=Number(job.step2ElapsedMs)||0;job.step2StartedAt=started;job.step2ProgressAt=started;await save(job);
   const fieldsValid=row=>{
    if(!row.sourceCourseName||!row.sourceCourseCode)throw Error('Source Course name and code are required.');
    if(Boolean(row.templateIdInput)===Boolean(row.templateCode))throw Error('Provide exactly one of TemplateId or TemplateCode.');
    const hasDeptId=Boolean(row.departmentIds),hasDeptCode=Boolean(row.departmentCodes);if(hasDeptId===hasDeptCode)throw Error('Provide exactly one of DepartmentIds or DepartmentCodes.');
    return true;
   };
   const validCodes=job.rows.filter(row=>row.sourceCourseCode&&codeCounts.get(row.sourceCourseCode)===1).map(row=>row.sourceCourseCode);
   let matchesByCode=new Map();try{matchesByCode=await getCodeMatches([...new Set(validCodes)],check);}catch(error){if(error.code==='JOB_CANCELLED'||error.persistenceFailure)throw error;for(const row of job.rows)if(validCodes.includes(row.sourceCourseCode))matchesByCode.set(row.sourceCourseCode,{error});}
   await pool(job.rows,8,async row=>{
    await check();
    try{
     fieldsValid(row);if(codeCounts.get(row.sourceCourseCode)>1)throw Object.assign(Error('Duplicate Source Course code in CSV; every row with this code was excluded.'),{duplicateCsv:true});if(row.status==='invalid'&&row.message)throw Object.assign(Error(row.message),{preserve:true});
     const template=await resolveTemplate(row,session,byId,templateCache),departments=await resolveDepartment(row,session,byId,departmentCache);
     row.templateId=id(template.Identifier);row.resolvedTemplateCode=template.Code||row.templateCode;row.resolvedDepartmentIds=departments.ids.join('|');row.resolvedDepartmentCodes=departments.codes.join('|');
     const duplicateLookup=matchesByCode.get(row.sourceCourseCode);if(duplicateLookup?.error)throw duplicateLookup.error;
     const found=duplicateLookup||[],current=found.filter(record=>lifecycleOf(record)==='current'),source=current.filter(record=>typeOf(record)==='sourcecourse'),other=current.filter(record=>typeOf(record)!=='sourcecourse');
     if(other.length)throw Object.assign(Error('This code belongs to another current organizational-unit type.'),{codeConflict:true});
     if(source.length){row.status='skipped';row.message=`A current Source Course already uses this code (Org Unit ID${source.length===1?'':'s'}: ${source.map(record=>id(record.Identifier)).join(', ')}).`;row.templateId=id(template.Identifier);row.resolvedTemplateCode=template.Code||row.templateCode;return;}
     row.status='eligible';row.templateId=id(template.Identifier);row.resolvedTemplateCode=template.Code||row.templateCode;
     job.tasks.push({row:row.row,Name:row.sourceCourseName,Code:row.sourceCourseCode,TemplateId:row.templateId,TemplateCode:row.resolvedTemplateCode,result:null});
    }catch(error){if(error.code==='JOB_CANCELLED'||error.persistenceFailure)throw error;if(error.preserve){/* retain a batch-level safe failure */}else row.status='invalid';row.message=error.duplicateCsv||error.preserve?error.message:error.code==='CODE_STATUS_UNKNOWN'?'Lifecycle status for this code is unknown; refresh the Org Library before creating.':error.code==='CODE_NOT_UNIQUE'?'Template or Department code is ambiguous.':error.code==='CODE_NOT_FOUND'?'Template or Department code was not found.':error.message||'Row could not be validated.';}
    finally{job.progress={phase:'templates',processed:++processed,total:job.rows.length};job.step2ProgressAt=now();if(processed%100===0)await save(job);}
   },async()=>{await check();return true;});
   if(recheckEnabled){
    const candidates=[...new Set(job.rows.filter(row=>row.status==='skipped'&&row.sourceCourseCode).map(row=>row.sourceCourseCode))];
    const state=job.liveSourceCourseRecheck;state.candidateCount=candidates.length;state.checkedCount=0;
    if(candidates.length){
     job.progress={phase:'Rechecking existing Source Courses',processed:job.rows.length,total:job.rows.length};state.status='running';state.startedAt=now();state.progressAt=state.startedAt;
     let lastSavedAt=-Infinity,saveInFlight=null,lastSampleAt=state.startedAt,lastSampleCount=0;
     const persistProgress=async(force=false)=>{
      if(saveInFlight){await saveInFlight;if(!force&&now()-lastSavedAt<5000)return;}
      const time=now();if(!force&&time-lastSavedAt<5000)return;
      const sampleElapsed=time-lastSampleAt,sampleCount=state.checkedCount-lastSampleCount;
      if(sampleElapsed>0&&sampleCount>0){const observed=sampleCount/sampleElapsed;state.ratePerMs=state.ratePerMs?state.ratePerMs*0.7+observed*0.3:observed;lastSampleAt=time;lastSampleCount=state.checkedCount;}
      state.elapsedMs=Math.max(0,time-state.startedAt);state.progressAt=time;job.progress={phase:'Rechecking existing Source Courses',processed:job.rows.length,total:job.rows.length};job.step2ProgressAt=time;
      job.creationSummary={eligible:job.rows.filter(row=>row.status==='eligible').length,skipped:job.rows.filter(row=>row.status==='skipped').length,invalid:job.rows.filter(row=>row.status==='invalid').length,created:0,registrationPending:0,failed:0,uncertain:0,notAttempted:0,total:job.tasks.length};
      const fields={progress:job.progress,liveSourceCourseRecheck:state,creationSummary:job.creationSummary,step2StartedAt:job.step2StartedAt,step2ProgressAt:job.step2ProgressAt,step2ElapsedMs:job.step2ElapsedMs};
      saveInFlight=Promise.resolve(saveProgress(job,fields)).then(saved=>{if(saved===false)throw Object.assign(Error('Validation worker no longer owns this job.'),{workerLease:true});lastSavedAt=now();}).catch(error=>{if(!error.persistenceFailure&&!error.workerLease)error.persistenceFailure=true;throw error;}).finally(()=>{saveInFlight=null;});
      await saveInFlight;
     };
     try{
      const sourceTypeId=typeof client.sourceCourseTypeId==='function'?await client.sourceCourseTypeId(check):null;
      await pool(candidates,8,async code=>{
       let live;
       try{
        await check();
        if(typeof client.recheckSourceCourseCode!=='function')throw Object.assign(Error('Live Source Course verification is unavailable.'),{code:'SOURCE_COURSE_RECHECK_UNAVAILABLE'});
        live=await client.recheckSourceCourseCode(code,sourceTypeId,check);
        if(!Array.isArray(live))throw Object.assign(Error('Brightspace returned an incomplete Source Course lookup.'),{code:'SOURCE_COURSE_RECHECK_INCOMPLETE'});
        const byId=new Map(live.map(record=>[positiveId(record?.Identifier),record]));byId.delete(null);live=[...byId.values()];
        for(const row of job.rows)if(row.sourceCourseCode===code&&row.status==='skipped'){
         if(live.length){row.status='skipped';row.message=`A current Source Course already uses this code (Org Unit ID${live.length===1?'':'s'}: ${live.map(record=>positiveId(record.Identifier)).join(', ')}).`;
         }else{row.status='eligible';row.message='';job.tasks.push({row:row.row,Name:row.sourceCourseName,Code:row.sourceCourseCode,TemplateId:row.templateId,TemplateCode:row.resolvedTemplateCode,result:null});}
        }
       }catch(error){if(error.code==='JOB_CANCELLED'||error.persistenceFailure||error.workerLease)throw error;for(const row of job.rows)if(row.sourceCourseCode===code&&row.status==='skipped'){row.status='invalid';row.message=error.code==='SOURCE_COURSE_TYPE_UNAVAILABLE'?'Brightspace did not expose one unambiguous Source Course type. Check Source Course type visibility and organization type permissions.':error.status===403?'Brightspace could not verify this code. Check organizational structure visibility and Source Course type permissions.':error.status===429?'Brightspace rate-limited Source Course verification. Retry validation later.':error.code==='SOURCE_COURSE_RECHECK_INCOMPLETE'?'Brightspace returned an incomplete or malformed Source Course lookup. No creation was authorized for this code.':'Live Source Course verification failed or was incomplete. No creation was authorized for this code.';}}
       finally{state.checkedCount++;job.progress={phase:'Rechecking existing Source Courses',processed:job.rows.length,total:job.rows.length};await persistProgress(false);}
      },async()=>{await check();return true;});
     }catch(error){if(error.code==='JOB_CANCELLED'||error.persistenceFailure||error.workerLease)throw error;state.status='failed';const message=error.code==='SOURCE_COURSE_TYPE_UNAVAILABLE'?'Brightspace did not expose one unambiguous Source Course type. Check Source Course type visibility and organization type permissions.':error.status===403?'Brightspace could not list or verify Source Course types and codes. Check organization type visibility and the organizations:organizationtypes:read permission.':error.status===429?'Brightspace rate-limited Source Course verification. Retry validation later.':'Live Source Course verification could not complete. No creation was authorized for this code.';for(const code of candidates)if(!job.rows.some(row=>row.sourceCourseCode===code&&row.status==='eligible'&&job.tasks.some(task=>task.Code===code))){for(const row of job.rows)if(row.sourceCourseCode===code&&row.status==='skipped'){row.status='invalid';row.message=message;}}}
     if(state.status!=='failed')state.status='complete';state.elapsedMs=Math.max(0,now()-state.startedAt);state.progressAt=now();job.progress={phase:'Rechecking existing Source Courses',processed:job.rows.length,total:job.rows.length};await persistProgress(true);
    }else state.status='complete';
   }else job.liveSourceCourseRecheck.status='disabled';
   job.tasks.sort((a,b)=>a.row-b.row);
   const rowGroups=new Map();for(const row of job.rows)if(row.templateId&&row.resolvedDepartmentIds!=null){const list=rowGroups.get(row.templateId)||[];list.push(row);rowGroups.set(row.templateId,list);}
   for(const [templateId,rows] of rowGroups){const signatures=new Set(rows.map(row=>row.resolvedDepartmentIds.split('|').filter(Boolean).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).join('|')));if(signatures.size>1){for(const row of rows){row.status='invalid';row.message='Rows for this Course Template specify conflicting Department parent sets.';}job.tasks=job.tasks.filter(task=>task.TemplateId!==templateId);}}
   const groups=new Map();for(const task of job.tasks){const group=groups.get(task.TemplateId)||[];group.push(task);groups.set(task.TemplateId,group);}
   for(const [templateId,tasks] of groups){const row=job.rows.find(candidate=>candidate.row===tasks[0].row);job.templateReconciliationPlan.push({templateId,departmentIds:row.resolvedDepartmentIds.split('|').filter(Boolean),departmentCodes:row.resolvedDepartmentCodes.split('|').filter(Boolean)});}
   job.tasks.sort((a,b)=>a.row-b.row);job.templateReconciliationPlan.sort((a,b)=>a.templateId.localeCompare(b.templateId,undefined,{numeric:true}));job.status=job.tasks.length?'ready':'completed';job.expiresAt=now()+30*60*1000;job.step2ElapsedMs+=Math.max(0,now()-started);job.step2StartedAt=null;job.step2ProgressAt=now();job.progress={phase:'validated',processed:job.rows.length,total:job.rows.length};
   if(!job.tasks.length)job.message='Validation finished with no eligible rows. Download the results report for skipped and invalid rows.';
  },
  async execute(job,save,renew,isCancelled=async()=>false){
   const start=now(),reconciliationOnly=job.operation==='templateReconciliation';job.step3ElapsedMs=Number(job.step3ElapsedMs)||0;job.step3StartedAt=start;job.step3ProgressAt=start;let stop=false;
   if(!reconciliationOnly)for(let i=0;i<job.tasks.length;i++){const task=job.tasks[i];if(task.result?.status==='created'&&task.result.registration!=='ready'){try{await renew();await this.register(task,job,save,i);}catch(error){if(error.persistenceFailure||error.workerLease)throw error;}}}
   let cursor=0,fatalError=null;const workers=reconciliationOnly?[]:Array.from({length:Math.min(8,job.tasks.length)},async()=>{while(true){const index=cursor++;if(index>=job.tasks.length)return;const task=job.tasks[index];if(task.result)continue;
    try{
     if(stop||job.cancelRequestedAt||await isCancelled(job._id,job.owner)){task.result={status:'notAttempted',message:'Not started because processing was stopped.'};job.step3ProgressAt=now();await save(job,{tasks:[index]});continue;}
     await renew();task.result={status:'uncertain',submissionIntent:true,message:'Creation outcome unconfirmed. Check Brightspace before retrying.'};job.step3ProgressAt=now();await save(job,{tasks:[index]});
     const result=await client.create(task,()=>renew());
     if(result.status!=='created'){task.result={...result,submissionIntent:result.status==='uncertain',submissionAttempted:Boolean(result.submissionAttempted)};stop ||= Boolean(result.systemic)||result.status==='uncertain';job.step3ProgressAt=now();await save(job,{tasks:[index]});continue;}
     task.result={status:'created',submissionIntent:true,submissionAttempted:true,CreatedOrgUnitId:result.orgUnitId,registration:'pending',createdAt:now(),message:'Created in Brightspace; registering in Org Library.'};job.step3ProgressAt=now();await save(job,{tasks:[index]});try{await this.register(task,job,save,index);}catch(error){if(error.persistenceFailure||error.workerLease)throw error;}
    }catch(error){fatalError ||= error;stop=true;throw error;}
   }});
   const settled=await Promise.allSettled(workers);if(fatalError)throw fatalError;const rejected=settled.find(result=>result.status==='rejected');if(rejected)throw rejected.reason;
   // Reconcile every template that could have received a POST, including uncertain outcomes after cancellation.
   await reconcile(job,save,renew,reconciliationOnly?job.templateReconciliationTemplateIds:undefined);
   const cancelled=reconciliationOnly?false:Boolean(job.cancelRequestedAt||await isCancelled(job._id,job.owner));
   if(cancelled){for(let i=0;i<job.tasks.length;i++)if(!job.tasks[i].result){job.tasks[i].result={status:'notAttempted',message:'Not started because the job was cancelled.'};await save(job,{tasks:[i]});}job.status='cancelled';job.message='Cancelled. Confirmed creations, registration, and template parenting outcomes are retained.';}
   else if(!reconciliationOnly&&job.tasks.some(task=>task.result?.registration==='pending')){job.status='queued';job.resuming=true;job.message='Confirmed Source Courses are awaiting Org Library registration. Brightspace creation requests will not be repeated.';}
   else {const errors=job.tasks.some(task=>['failed','uncertain'].includes(task.result?.status))||Object.values(job.templateReconciliation||{}).some(entry=>['Failed','Uncertain'].includes(entry.status));job.status=errors?'completedWithErrors':'completed';}
   job.step3ElapsedMs+=Math.max(0,now()-start);job.step3StartedAt=null;job.step3ProgressAt=now();
  },
  async register(task,job,save,index){try{await directoryStore.registerCreated({Identifier:task.result.CreatedOrgUnitId,Name:task.Name,Code:task.Code,createdAt:task.result.createdAt,provenance:`bulk-source-creator:${job._id}:${task.row}`});task.result.registration='ready';task.result.message='Created and registered in the Org Library.';job.step3ProgressAt=now();await save(job,{tasks:[index]});}catch(error){task.result.registration='pending';task.result.message='Created in Brightspace; Org Library registration is pending.';job.step3ProgressAt=now();await save(job,{tasks:[index]});throw Object.assign(error,{registrationFailure:true});}}
 };
}
module.exports={HEADERS,parseCreationCsv,createCreationJobs};

'use strict';
const { randomUUID } = require('node:crypto');
const {performance}=require('node:perf_hooks');
const { parseCourseCsv } = require('../dates/courseCsv');
const { validateDates } = require('../dates/activityWriters');
const {validateZone,DEFAULT_ZONE}=require('../dates/timeZone');
const {ACTIVITY_TYPES,validateActivityTypes,validateRules,resolveActivity}=require('../dates/schedulingRules');
const TYPES=['assignment','quiz','discussionTopic'];
const MAX_ACTIVITIES=250000;
const DISCOVERY_CHECKPOINT_SIZE=500;
const STEP3_CHECKPOINT_DELAY_MS=25;
const STEP2_PROGRESS_PERSIST_MS=5000;
const {pool}=require('./pool');
const {DIRTY}=require('./dateChunks');
const {createStep3Utilization,withStep3Utilization}=require('./step3Utilization');
const {createStep2Utilization,withStep2Utilization}=require('./step2Utilization');
const {createDeploymentStep3Utilization,getBuildSha}=require('../replication/step3Utilization');
const terminal = new Set(['completed','completedWithErrors','failed','interrupted','cancelled','submitted','submittedWithErrors','outcomeUnknown','reviewed','activated','activationWithErrors']);
const counts = tasks => tasks.reduce((out,t)=>{const s=t.result?.status || 'pending';out[s]=(out[s]||0)+1;return out;},{total:tasks.length});
function updateScheduleCoverage(job){
 const coverages=(job.courses||[]).map(course=>course.coverage).filter(Boolean);
 job.scheduleCoverage={discovered:coverages.reduce((n,c)=>n+(Number(c.discovered)||0),0),selected:coverages.reduce((n,c)=>n+(Number(c.selected)||0),0),matched:coverages.reduce((n,c)=>n+(Number(c.matched)||0),0),unmatched:coverages.reduce((n,c)=>n+(Number(c.unmatched)||0),0),conflicts:coverages.reduce((n,c)=>n+(Number(c.conflicts)||0),0),zeroMatchCourses:coverages.filter(c=>Number(c.matched)===0).length,rules:Object.fromEntries((job.rules||[]).map(rule=>[rule.id,coverages.reduce((n,c)=>n+(Number(c.rules?.[rule.id])||0),0)]))};
 return job.scheduleCoverage;
}
function effectiveTaskDates(job,task){
  if((job.scheduleMode||'uniform')==='uniform')return job.dates;
  try{return validateDates(task.dates);}catch{throw Object.assign(Error('Saved rule-based task dates are missing or invalid; no activity update was attempted.'),{code:'INVALID_SAVED_TASK_DATES'});}
}
const selectedTypesFor=job=>Array.isArray(job.activityTypes)&&job.activityTypes.length?job.activityTypes:TYPES;
function interruptJob(job) {
  job.status='interrupted';job.message='Processing stopped. Saved results are retained; create a fresh preview before retrying.';
  if(job.kind==='sourceDeployment'&&job.operation==='activate'){
    for(const task of job.tasks)for(const target of task.targets)if(target.activation?.status==='running')target.activation={status:'failed',writeAttempted:target.activation.writeAttempted,error:{message:'Activation interrupted. Recheck active state before retrying.'}};
    job.status='activationWithErrors';job.message='Activation interrupted; deployment results are retained. Retry activation to read current states and finish.';return job;
  }
  if(job.kind==='courseCopy'){job.message='Processing interrupted. Saved copy tokens are retained. Check submitted copies; unconfirmed submissions are never automatically repeated.';return job;}
  if(job.kind==='sourceCreation'){
    const planning=job.status==='planning';
    for(const task of job.tasks||[])if(task.result?.submissionIntent&&task.result?.status==='uncertain'){task.result={status:'uncertain',message:'Creation outcome is unconfirmed after interruption. Inspect Brightspace; the POST was not repeated.'};}
    job.status=planning?'validating':'queued';job.resuming=true;job.message=planning?'Validation will resume from the saved CSV without sending creation requests.':'Processing resumed safely. Confirmed creations may retry Org Library registration; unconfirmed POSTs will not be repeated.';return job;
  }
  for(const task of job.tasks) {
    if(task.result?.status==='running')task.result=job.kind==='dates'
      ?{status:'uncertain',verifiedDates:null,writeAttempted:true,error:{category:'UNCERTAIN_OUTCOME',message:'Processing stopped during this activity. Reconcile its current dates before any further action.'}}
      :{status:'failed',verifiedDates:null,writeAttempted:true,error:{category:'UNCERTAIN_OUTCOME',message:'Processing stopped during this activity. Read its current dates before retrying.'}};
    else if(!task.result&&job.kind!=='dates'&&!(job.kind==='sourceDeployment'&&job.cancelRequestedAt))task.result={status:'skipped',writeAttempted:false,error:{message:'Not executed before interruption.'}};
    // For Date Manager, interruption alone does not prove untouched tasks were skipped.
  }
  if(job.kind==='sourceDeployment'){job.message='Deployment processing was interrupted. Check Brightspace before any new submission; saved acceptance IDs remain available.';for(const task of job.tasks)if(task.result?.error?.category==='UNCERTAIN_OUTCOME'){task.result.status='uncertain';task.result.error.message='Deployment outcome is unknown. Check Brightspace before retrying.';}}
  job.totals=counts(job.tasks);return job;
}
function createBulkJobs({store,courses,discovery,writers,writeEnabled,deployment,courseCopy,sourceCreation,now=Date.now,buildSha=process.env.RENDER_GIT_COMMIT}) {
  let busy=false;
  const worker=randomUUID();
  const cancelledJobs=new Set(),step3CancelJobs=new Set(),deploymentCancelJobs=new Set(),activePlans=new Map();
  const unsafeWorkerJobs=new Set();
  let activeStep3Tracker=null,activeStep3Job=null,activeStep2Tracker=null,activeStep2Job=null;
  let activeDeploymentStep3Tracker=null,activeDeploymentStep3Job=null,activeDeploymentStep3StartedAt=null,activeDeploymentStep3ElapsedBaseMs=0,activeDeploymentStep3Coverage='running';
  let planningWriteQueue=Promise.resolve();
  const withPlanningWrite=operation=>{const result=planningWriteQueue.then(operation);planningWriteQueue=result.catch(()=>{});return result;};
  const countCache=new WeakMap();
  const pendingPreparationTiming=new WeakSet();
  const createCheckpointQueue=require('./checkpointQueue').createCheckpointQueue;
  const checkpoint=createCheckpointQueue(saveCheckpoint);
  const step3Checkpoint=createCheckpointQueue(saveCheckpoint,{delayMs:STEP3_CHECKPOINT_DELAY_MS});
  function save(job,dirty,queue=checkpoint) {
    job.performance ||= {};job.performance.checkpointRequests=(job.performance.checkpointRequests||0)+1;
    if(activeDeploymentStep3Job===job._id)activeDeploymentStep3Tracker?.checkpointRequested?.();
    if(job.kind==='sourceDeployment'&&['ready','failed'].includes(job.status)&&Number.isFinite(job.performance.preparationStartedAt)&&job.performance.preparationMs==null){
      job.performance.preparationFinishedAt=now();job.performance.preparationMs=Math.max(0,job.performance.preparationFinishedAt-job.performance.preparationStartedAt);
      pendingPreparationTiming.add(job);
    }
    const tracker=activeStep2Job===job._id?activeStep2Tracker:null;tracker?.checkpointWait(1);
    let result;try{
      const enqueue=()=>queue(job,dirty);
      result=activeDeploymentStep3Job===job._id&&activeDeploymentStep3Tracker?withStep3Utilization(activeDeploymentStep3Tracker,enqueue):enqueue();
    }catch(error){tracker?.checkpointWait(-1);throw error;}
    return Promise.resolve(result).then(()=>{pendingPreparationTiming.delete(job);}).finally(()=>tracker?.checkpointWait(-1));
  }
  const saveStep3=async(job,dirty)=>{
    const tracker=activeStep3Job===job._id?activeStep3Tracker:null;
    tracker?.checkpointWait(1);
    try{return await save(job,dirty,step3Checkpoint);}
    finally{tracker?.checkpointWait(-1);}
  };
  async function saveCheckpoint(job,dirty) { job.updatedAt=now();let cached=countCache.get(job);
    if(!dirty||!cached){job.totals=counts(job.tasks);cached=job.tasks.map(t=>t.result?.status||'pending');countCache.set(job,cached);}
    else for(const i of dirty.tasks||[]){const before=cached[i]||'pending',after=job.tasks[i].result?.status||'pending';if(before!==after){job.totals[before]=(job.totals[before]||0)-1;job.totals[after]=(job.totals[after]||0)+1;cached[i]=after;}}
    if(job.kind==='sourceCreation')job.creationSummary={eligible:(job.rows||[]).filter(r=>r.status==='eligible').length,skipped:(job.rows||[]).filter(r=>r.status==='skipped').length+(job.tasks||[]).filter(t=>t.result?.status==='skipped').length,invalid:(job.rows||[]).filter(r=>r.status==='invalid').length,created:(job.tasks||[]).filter(t=>t.result?.status==='created').length,registrationPending:(job.tasks||[]).filter(t=>t.result?.status==='created'&&t.result.registration!=='ready').length,failed:(job.tasks||[]).filter(t=>t.result?.status==='failed').length,uncertain:(job.tasks||[]).filter(t=>t.result?.status==='uncertain').length,notAttempted:(job.tasks||[]).filter(t=>t.result?.status==='notAttempted').length,total:(job.tasks||[]).length};
    if(job.kind==='dates'&&job.status==='planning'&&Number.isFinite(job.step2StartedAt)){
      const time=now(),previous=job.step2DurableProgress;
      job.step2ProgressAt=time;
      if(!previous||previous.phase!==job.progress?.phase||previous.processed!==job.progress?.processed)job.step2CourseProgressAt=time;
      job.step2DurableProgress=job.progress?{...job.progress}:null;
    }
    if(activeStep3Tracker&&activeStep3Job===job._id){job.performance ||= {};job.performance.dateStep3Utilization=activeStep3Tracker.snapshot();}
    if(activeStep2Tracker&&activeStep2Job===job._id){job.performance ||= {};job.performance.dateStep2Utilization=activeStep2Tracker.snapshot();}
    const deploymentTracker=activeDeploymentStep3Tracker&&activeDeploymentStep3Job===job._id?activeDeploymentStep3Tracker:null;
    if(deploymentTracker){job.performance ||= {};job.performance.deploymentStep3Utilization=deploymentTracker.snapshot(activeDeploymentStep3Coverage,activeDeploymentStep3ElapsedBaseMs+Math.max(0,performance.now()-activeDeploymentStep3StartedAt));}
    job[DIRTY]=dirty;const started=now(),monotonicStarted=performance.now();
    try {await withPlanningWrite(()=>store.save(job,worker));} catch(error) {unsafeWorkerJobs.add(job._id);error.persistenceFailure=true;throw error;} finally {delete job[DIRTY];}
    deploymentTracker?.checkpointPersisted(Math.max(0,performance.now()-monotonicStarted));
    job.performance ||= {};job.performance.checkpoints=(job.performance.checkpoints||0)+1;job.performance.checkpointMs=(job.performance.checkpointMs||0)+now()-started; }
  async function plan(job) {
    let checkedAt=-Infinity,cancelCheck;
    const segmentStartedAt=now();
    job.step2ElapsedMs=Number(job.step2ElapsedMs)||0;job.step2StartedAt=segmentStartedAt;job.step2ProgressAt=segmentStartedAt;job.step2CourseProgressAt=segmentStartedAt;
    const resolving=job.rows.some(row=>row.status==='pending');
    job.progress={phase:resolving?'Resolving courses':'Discovering activities',processed:resolving?job.rows.filter(row=>row.status!=='pending').length:job.courses.filter(course=>course.status!=='pending').length,total:resolving?job.rows.length:job.courses.length};
    job.step2SampleAt=segmentStartedAt;job.step2SampleProcessed=job.progress.processed;job.step2SamplePhase=job.progress.phase;job.step2SampleCount=0;
    let lastPersistAt=segmentStartedAt,metadataFailure=null,metadataBusy=false,lastPersistedProgress=`${job.progress.phase}:${job.progress.processed}`;
    const persistPlanningProgress=force=>{
      if(metadataBusy||(!force&&now()-lastPersistAt<STEP2_PROGRESS_PERSIST_MS))return Promise.resolve();
      metadataBusy=true;
      return withPlanningWrite(async()=>{
        const time=now(),phase=job.progress?.phase,processed=Number(job.progress?.processed)||0;
        let rate=Number(job.step2RatePerMs)||0;
        if(phase===job.step2SamplePhase&&Number.isFinite(job.step2SampleAt)&&time>job.step2SampleAt&&processed>Number(job.step2SampleProcessed||0)){
          const observed=(processed-Number(job.step2SampleProcessed||0))/(time-job.step2SampleAt);
          rate=rate>0?rate*0.7+observed*0.3:observed;
        } else if(phase!==job.step2SamplePhase)rate=0;
        const progressKey=`${phase}:${processed}`,courseProgressAt=progressKey!==lastPersistedProgress?time:job.step2CourseProgressAt;
        const sampleCount=phase===job.step2SamplePhase?(Number(job.step2SampleCount)||0)+(processed>Number(job.step2SampleProcessed||0)?1:0):0;
        const fields={progress:job.progress,step2StartedAt:job.step2StartedAt,step2ProgressAt:time,step2CourseProgressAt:courseProgressAt,step2RatePerMs:rate,step2SampleAt:time,step2SampleProcessed:processed,step2SamplePhase:phase,step2SampleCount:sampleCount};
        if(activeStep2Job===job._id&&activeStep2Tracker){fields['performance.dateStep2Utilization']=activeStep2Tracker.snapshot();job.performance ||= {};job.performance.dateStep2Utilization=fields['performance.dateStep2Utilization'];}
        if(typeof store.savePlanningProgress==='function'){
          const saved=await store.savePlanningProgress(job,worker,fields);
          if(!saved&&job.status==='planning'){unsafeWorkerJobs.add(job._id);throw Object.assign(Error('Planning worker no longer owns this job.'),{workerLease:true});}
        }
        const inMemoryFields={...fields};delete inMemoryFields['performance.dateStep2Utilization'];
        Object.assign(job,inMemoryFields);lastPersistAt=time;lastPersistedProgress=progressKey;
      }).catch(error=>{metadataFailure=error;unsafeWorkerJobs.add(job._id);if(!error.persistenceFailure&&!error.workerLease)error.persistenceFailure=true;throw error;}).finally(()=>{metadataBusy=false;});
    };
    const progressTimer=setInterval(()=>{if(!metadataBusy&&now()-lastPersistAt>=STEP2_PROGRESS_PERSIST_MS)persistPlanningProgress(false).catch(()=>{});},1000);
    progressTimer.unref?.();
    const checkCancelled=async(force=false)=>{
      if(metadataFailure)throw metadataFailure;
      if(unsafeWorkerJobs.has(job._id))throw Object.assign(Error('Planning worker persistence is unavailable.'),{persistenceFailure:true});
      if(cancelledJobs.has(job._id)){job.status='cancelled';throw Object.assign(Error('Planning cancelled'),{code:'JOB_CANCELLED'});}
      if(force||now()-checkedAt>=1000){checkedAt=now();cancelCheck=Promise.resolve().then(async()=>{
        if(await store.isCancelled?.(job._id,job.owner)){cancelledJobs.add(job._id);job.status='cancelled';throw Object.assign(Error('Planning cancelled'),{code:'JOB_CANCELLED'});}
      });}
      await cancelCheck;
    };
    try {
    const resolved=new Map(job.courses.map(c=>[c.orgUnitId,c.row])),resolutionCache=new Map();
    await checkCancelled(true);
    const codeSession=await courses.prepare?.(job.rows.filter(r=>r.status==='pending'),checkCancelled);
    await checkCancelled(true);
    const previewed=new Set(job.tasks.map(t=>`${t.orgUnitId}:${t.activity.type}:${t.activity.id}:${t.activity.parentId||''}`));
    let resolvedRows=job.rows.filter(r=>r.status!=='pending').length;
    await pool(job.rows.filter(r=>r.status==='pending'),8,async row=>{
      try {
        const course=await courses.resolve(row,{cache:resolutionCache,resolver:codeSession,check:checkCancelled});
        row.resolvedId=course.orgUnitId;
        if(resolved.has(course.orgUnitId)){row.status='duplicate';row.duplicateOf=resolved.get(course.orgUnitId);row.message='Same resolved course; processed once.';}
        else {
        resolved.set(course.orgUnitId,row.row);row.status='valid';job.courses.push({...course,row:row.row,status:'pending'});}
      } catch(e) {if(e.code==='JOB_CANCELLED')throw e;row.status='invalid';row.message=e.code==='ID_CODE_MISMATCH'?'ID and code identify different org units.':e.status ? `Course unavailable or inaccessible (HTTP ${e.status}).` : 'Course could not be resolved uniquely as an accessible Course Offering or Source Course. Check its identifier and LP API configuration.';}
      job.progress={phase:'Resolving courses',processed:++resolvedRows,total:job.rows.length};
    },async()=>{await checkCancelled();return true;});
    await checkCancelled(true);
    job.courses.sort((a,b)=>a.row-b.row);
    job.courseTotal=job.courses.length;
    await save(job);
    job.step2SampleAt=now();job.step2SampleProcessed=job.courses.filter(c=>c.status!=='pending').length;job.step2SamplePhase='Discovering activities';job.step2SampleCount=0;job.step2RatePerMs=0;
    let reserved=job.tasks.length, discovered=job.courses.filter(c=>c.status!=='pending').length;
    let discoveredActivities=job.courses.reduce((sum,course)=>sum+(Number(course.coverage?.discovered)||0),0);
    job.progress={phase:'Discovering activities',processed:discovered,total:job.courses.length,activities:discoveredActivities};
    let discoveryCheckpoint=0;
    activeStep2Tracker=createStep2Utilization({prior:job.performance?.dateStep2Utilization});activeStep2Job=job._id;
    const discoveryCourses=job.courses.filter(c=>c.status==='pending');activeStep2Tracker.setPending(discoveryCourses.length);
    await withStep2Utilization(activeStep2Tracker,()=>pool(discoveryCourses,8,async (course,index,stopped)=>{
      activeStep2Tracker.courseStarted();
      try {
      let checkpointFailure;
      const priorCourseTasks=job.tasks.filter(task=>task.orgUnitId===course.orgUnitId);
      const priorDiscovered=Number(course.coverage?.discovered)||0;
      const courseCoverage={discovered:0,selected:0,matched:priorCourseTasks.length,unmatched:0,conflicts:0,rules:Object.fromEntries((job.rules||[]).map(rule=>[rule.id,0])),conflictExamples:[]};
      for(const task of priorCourseTasks)if(task.ruleId)courseCoverage.rules[task.ruleId]=(courseCoverage.rules[task.ruleId]||0)+1;
      try {
        const found=await discovery.discover(course.orgUnitId,{includeUndated:true,includeNative:true,check:checkCancelled});
        course.counts=Object.fromEntries(TYPES.map(t=>[t,(found.activities||[]).filter(a=>a.type===t).length]));
        await checkCancelled();
        if(!found.complete)throw new Error('Incomplete discovery');
        courseCoverage.discovered=found.activities.length;
        courseCoverage.selected=found.activities.filter(a=>selectedTypesFor(job).includes(a.type)).length;
        discoveredActivities+=courseCoverage.discovered-priorDiscovered;
        course.coverage=structuredClone(courseCoverage);
        const nativeByKey=new Map((found.nativeActivities||[]).map(item=>[item.key,item.data]));
        const additional=new Set(found.activities.filter(a=>!previewed.has(`${course.orgUnitId}:${a.type}:${a.id}:${a.parentId||''}`)).map(a=>`${a.type}:${a.id}:${a.parentId||''}`)).size;
        if(reserved+additional>MAX_ACTIVITIES)throw new Error('Activity limit exceeded');
        reserved+=additional;
        for(const a of found.activities) {
          await checkCancelled();
          if(stopped())return;
          if(!TYPES.includes(a.type))throw new Error('Unsupported type');
          const taskKey=`${course.orgUnitId}:${a.type}:${a.id}:${a.parentId||''}`;
          if(previewed.has(taskKey))continue;
          const activity={type:a.type,id:a.id,parentId:a.parentId,orgUnitId:course.orgUnitId,key:a.key};
          const nativeActivity=nativeByKey.get(a.key);
          if(!nativeActivity)throw new Error('Native activity data missing from discovery');
          const resolvedActivity=job.scheduleMode==='rules'?resolveActivity(a,job.rules,selectedTypesFor(job)):selectedTypesFor(job).includes(a.type)?{status:'matched',dates:job.dates}:{status:'excluded',reason:'unselected'};
          if(resolvedActivity.status==='conflict'){courseCoverage.conflicts++;courseCoverage.conflictExamples??=[];if(courseCoverage.conflictExamples.length<5)courseCoverage.conflictExamples.push({activityId:a.id,name:String(a.name||'').slice(0,120),ruleIds:resolvedActivity.ruleIds});course.coverage=structuredClone(courseCoverage);continue;}
          if(resolvedActivity.status==='unmatched'){courseCoverage.unmatched++;course.coverage=structuredClone(courseCoverage);continue;}
          if(resolvedActivity.status==='excluded')continue;
          const taskDates=resolvedActivity.dates;
          const request={orgUnitId:course.orgUnitId,activity,dates:taskDates,dryRun:true,nativeActivity};
          const preview=await writers[a.type].updateActivityDates(request);
          job.tasks.push({orgUnitId:course.orgUnitId,activity,name:a.name,preview,...(job.scheduleMode==='rules'?{ruleId:resolvedActivity.rule.id,dates:taskDates}:{})});previewed.add(taskKey);courseCoverage.matched++;if(job.scheduleMode==='rules')courseCoverage.rules[resolvedActivity.rule.id]=(courseCoverage.rules[resolvedActivity.rule.id]||0)+1;
          course.coverage=structuredClone(courseCoverage);
          if(!['ready','unchanged'].includes(preview.status))course.previewInvalid=true;
          if(++discoveryCheckpoint%DISCOVERY_CHECKPOINT_SIZE===0)try{await save(job);}catch(error){checkpointFailure=error;throw error;}
        }
        course.coverage=courseCoverage;
        course.status=course.previewInvalid?'invalid':'valid';
      } catch(error) {if(checkpointFailure)throw checkpointFailure;if(error.code==='JOB_CANCELLED')throw error;course.status='invalid';course.message='Discovery failed, was incomplete, or exceeded the 250,000-activity limit.';}
      job.progress={phase:'Discovering activities',processed:++discovered,total:job.courses.length,activities:discoveredActivities};
      if(++discoveryCheckpoint%DISCOVERY_CHECKPOINT_SIZE===0)await save(job);
      } finally {activeStep2Tracker.courseFinished();}
    },async()=>{await checkCancelled();return true;}));
    await checkCancelled(true);
    await persistPlanningProgress(true);
    updateScheduleCoverage(job);
    job.status=job.rows.some(r=>r.status==='invalid') || job.courses.some(c=>c.status!=='valid') || !job.tasks.length || job.scheduleCoverage.conflicts>0 ? 'failed':'ready';
    job.expiresAt=now()+30*60*1000;
    if(job.scheduleCoverage.conflicts)job.message=`${job.scheduleCoverage.conflicts} activities match multiple rules. Resolve every conflict and create a new preview.`;
    else if(!job.tasks.length)job.message='No eligible activities were found.';
    } catch(error) {
      if(error.code!=='JOB_CANCELLED')throw error;
      job.status='cancelled';job.message='Planning was cancelled. Saved course and activity results are retained; no activity date updates were started.';
    } finally {
      clearInterval(progressTimer);
      await planningWriteQueue;
      updateScheduleCoverage(job);
      if(activeStep2Job===job._id){activeStep2Tracker.finish();job.performance ||= {};job.performance.dateStep2Utilization=activeStep2Tracker.snapshot();}
      if(['ready','failed','cancelled'].includes(job.status)){
        job.step2ElapsedMs=(Number(job.step2ElapsedMs)||0)+Math.max(0,now()-segmentStartedAt);job.step2StartedAt=null;
      }
    }
  }
  async function execute(job) {
    let cancellationCheckedAt=-Infinity,cancellationCheck;
    const cancellationRequested=async(force=false)=>{
      if(step3CancelJobs.has(job._id))return true;
      if(force||now()-cancellationCheckedAt>=1000){
        cancellationCheckedAt=now();
        cancellationCheck=Promise.resolve().then(()=>store.isCancelled?.(job._id,job.owner)).then(Boolean);
      }
      if(await cancellationCheck){step3CancelJobs.add(job._id);return true;}
      return false;
    };
    // All scopes are checked before the first write. Only the stored confirmed plan is executed.
    const cancelledAtStart=await cancellationRequested(true);
    if(!cancelledAtStart&&job.tasks.some(t=>!writeEnabled(t.activity.type))) {job.status='failed';job.message='Required write scope is unavailable. No updates were started.';return;}
    const step3Now=now();
    job.step3StartedAt=step3Now;
    job.step3ProgressAt=step3Now;
    job.step3ElapsedMs=Number.isFinite(job.step3ElapsedMs)?job.step3ElapsedMs:0;
    activeStep3Tracker=createStep3Utilization({prior:job.performance?.dateStep3Utilization});activeStep3Job=job._id;
    let stop=Boolean(job.systemicFailure),processed=job.tasks.filter(t=>t.result&&t.result.status!=='running'&&t.result.status!=='pending').length;
    const groups=new Map();
    job.tasks.forEach((task,taskIndex)=>{if(!groups.has(task.orgUnitId))groups.set(task.orgUnitId,[]);groups.get(task.orgUnitId).push({task,taskIndex});});
    await withStep3Utilization(activeStep3Tracker,()=>pool([...groups.values()],6,async (group,index,stopped)=>{
     for(const {task,taskIndex} of group){
      if(stopped()||unsafeWorkerJobs.has(job._id))return;
      const cancelling=await cancellationRequested();
      if(cancelling&&!['running','uncertain'].includes(task.result?.status))return;
      if(task.result?.status==='running'||(task.result?.status==='uncertain'&&task.result.error?.category==='UNCERTAIN_OUTCOME')){
        task.result={status:'uncertain',writeAttempted:true,error:{category:'UNCERTAIN_OUTCOME',stage:'interruption',message:'The activity was in flight when processing stopped. Brightspace is checked read-only; no PUT is repeated.'}};
        await saveStep3(job,{tasks:[taskIndex]});
        try {
          const dates=effectiveTaskDates(job,task);
          const reconciled=await writers[task.activity.type].updateActivityDates({orgUnitId:task.orgUnitId,activity:task.activity,dates,expectedSettingsFingerprint:task.preview?.settingsFingerprint,reconcileOnly:true,dryRun:false});
          if(['PERSISTENCE_FAILURE','WORKER_LEASE_INTERRUPTION'].includes(reconciled.error?.category))throw Object.assign(Error('Worker or persistence state could not be confirmed.'),{persistenceFailure:reconciled.error.category==='PERSISTENCE_FAILURE',workerLease:reconciled.error.category==='WORKER_LEASE_INTERRUPTION'});
          task.result=reconciled.status==='unchanged'?{...reconciled,status:task.preview?.status==='ready'?'updated':'unchanged',writeAttempted:true,error:null}:{...task.result,...(reconciled.error?{error:reconciled.error}:{})};
          if(['HTTP_API_FAILURE','API_TRANSPORT_FAILURE'].includes(reconciled.error?.category)&&(reconciled.error.httpStatus==null||[401,403,429].includes(reconciled.error.httpStatus)||reconciled.error.httpStatus>=500))stop=true;
        } catch(error) {
          if(error.code==='INVALID_SAVED_TASK_DATES'){
            task.result={status:'uncertain',writeAttempted:true,error:{category:'INVALID_SAVED_TASK_DATES',stage:'reconciliation',message:'Saved rule dates are unavailable, so the interrupted write could not be reconciled. Manual review is required; no write was repeated.'}};
            processed++;job.progress={phase:'Applying dates',processed,total:job.tasks.length};job.step3ProgressAt=now();await saveStep3(job,{tasks:[taskIndex]});continue;
          }
          const category=error?.name?.startsWith('Mongo')||error?.persistenceFailure?'PERSISTENCE_FAILURE':error?.workerLease||/lease/i.test(String(error?.message||''))?'WORKER_LEASE_INTERRUPTION':'API_TRANSPORT_FAILURE';
          if(category!=='API_TRANSPORT_FAILURE')throw error;
          task.result.error={category:'UNCERTAIN_OUTCOME',stage:'reconciliation',message:'Read-only reconciliation could not establish the result. Manual review is required; no write was repeated.'};
        }
        processed++;job.progress={phase:'Applying dates',processed,total:job.tasks.length};job.step3ProgressAt=now();job.systemicFailure=stop;await saveStep3(job,{tasks:[taskIndex]});continue;
      }
      if(cancelling)return;
      if(task.result)continue;
      if(stop) {task.result={status:'skipped',writeAttempted:false,error:{message:'Stopped after a systemic API failure.'}};processed++;job.step3ProgressAt=now();await saveStep3(job,{tasks:[taskIndex]});continue;}
      try {await store.renew(worker);} catch(error) {unsafeWorkerJobs.add(job._id);throw error;} // Lease failure stops every worker before a later write.
      if(unsafeWorkerJobs.has(job._id))return;
      let dates;
      try{dates=effectiveTaskDates(job,task);}catch(error){task.result={status:'failed',writeAttempted:false,error:{category:'INVALID_SAVED_TASK_DATES',message:'Saved rule dates are missing or invalid. No activity update was attempted.'}};processed++;job.progress={phase:'Applying dates',processed,total:job.tasks.length};job.step3ProgressAt=now();await saveStep3(job,{tasks:[taskIndex]});continue;}
      task.result={status:'running',writeAttempted:false};await saveStep3(job,{tasks:[taskIndex]});
      if(stop||stopped()||unsafeWorkerJobs.has(job._id)){task.result={status:'skipped',writeAttempted:false,error:{message:'Stopped before writing.'}};processed++;job.step3ProgressAt=now();await saveStep3(job,{tasks:[taskIndex]});continue;}
      try {
        task.result=await writers[task.activity.type].updateActivityDates({orgUnitId:task.orgUnitId,activity:task.activity,
          dates,expectedDates:task.preview.verifiedDates,beforeWrite:async()=>{if(unsafeWorkerJobs.has(job._id))throw Object.assign(Error('Worker persistence is unavailable.'),{persistenceFailure:true});await store.renew(worker);if(unsafeWorkerJobs.has(job._id))throw Object.assign(Error('Worker persistence is unavailable.'),{persistenceFailure:true});if(await cancellationRequested(true))throw Object.assign(Error('Date update cancelled before dispatch.'),{code:'JOB_CANCELLED'});},dryRun:false});
      } catch(error) {
        if(error.code==='JOB_CANCELLED'){step3CancelJobs.add(job._id);delete task.result;return;}
        const category=error?.name?.startsWith('Mongo')||error?.persistenceFailure?'PERSISTENCE_FAILURE':/lease/i.test(String(error?.message||''))?'WORKER_LEASE_INTERRUPTION':'UNCERTAIN_OUTCOME';
        if(['PERSISTENCE_FAILURE','WORKER_LEASE_INTERRUPTION'].includes(category)){unsafeWorkerJobs.add(job._id);throw error;}
        task.result={status:'uncertain',verifiedDates:null,writeAttempted:true,error:{category,stage:'execution',message:'Outcome is uncertain; inspect the activity before retrying.'}};stop=true;
      }
      if(step3CancelJobs.has(job._id)&&task.result?.writeAttempted===false&&task.result.status!=='unchanged'){delete task.result;return;}
      const error=task.result.error;
      if(['HTTP_API_FAILURE','API_FAILURE','API_TRANSPORT_FAILURE'].includes(error?.category) && (error.httpStatus==null || [401,403,429].includes(error.httpStatus) || error.httpStatus>=500))stop=true;
      if(error?.category==='UNCERTAIN_OUTCOME'&&(!task.result.verifiedDates||[401,403,429].includes(error.httpStatus)||error.httpStatus>=500))stop=true;
      if(['PERSISTENCE_FAILURE','WORKER_LEASE_INTERRUPTION'].includes(error?.category)){unsafeWorkerJobs.add(job._id);throw Object.assign(Error('Date Manager worker state could not be safely persisted.'),{persistenceFailure:error.category==='PERSISTENCE_FAILURE',workerLease:error.category==='WORKER_LEASE_INTERRUPTION'});}
      job.systemicFailure=stop;
      job.progress={phase:'Applying dates',processed:++processed,total:job.tasks.length};
      job.step3ProgressAt=now();
      await saveStep3(job,{tasks:[taskIndex]});
     }
    },async()=>!unsafeWorkerJobs.has(job._id)));
    job.progress={phase:'Applying dates',processed,total:job.tasks.length};
    const cancelled=await cancellationRequested(true);
    if(cancelled){
      for(const task of job.tasks)if(task.result?.status==='running'&&task.result.writeAttempted===false)delete task.result;
      job.status='cancelled';job.cancelledDuringStep3=true;job.message='Job cancelled. Confirmed updates are saved; activities not started remain pending.';
    } else {
    job.status=job.tasks.some(t=>['failed','skipped','uncertain','pending','running'].includes(t.result?.status))?'completedWithErrors':'completed';
    }
    job.step3ElapsedMs=(job.step3ElapsedMs||0)+Math.max(0,now()-job.step3StartedAt);
    job.step3StartedAt=null;
    activeStep3Tracker.finish();
  }
  return {
    async create({owner,createdBy,csv,dates,timeZone=DEFAULT_ZONE,kind='dates',copyMode,components,validationMode,scheduleMode='uniform',activityTypes=ACTIVITY_TYPES,rules}) {
      if(kind==='courseCopy'){const rows=courseCopy.parse(csv),job={_id:randomUUID(),owner,...(createdBy?{createdBy}:{}),kind,status:'validating',createdAt:now(),updatedAt:now(),rows,progress:{phase:'mappings',processed:rows.filter(row=>row.status!=='pending').length,total:rows.length},components:courseCopy.selection(copyMode,components),validationMode:'direct',courses:[],tasks:[],totals:{total:0}};await store.insert(job);return job;}
      if(kind==='sourceDeployment'){if(!deployment)throw Error('Deployment unavailable');const job={_id:randomUUID(),owner,...(createdBy?{createdBy}:{}),kind,status:'validating',createdAt:now(),updatedAt:now(),buildSha:getBuildSha(buildSha),rows:deployment.parse(csv),courses:[],tasks:[],totals:{total:0}};await store.insert(job);return job;}
      if(kind==='sourceCreation'){if(!sourceCreation)throw Error('Source Course Creator unavailable');const job={_id:randomUUID(),owner,...(createdBy?{createdBy}:{}),kind,status:'validating',createdAt:now(),updatedAt:now(),rows:sourceCreation.parse(csv),courses:[],tasks:[],totals:{total:0}};await store.insert(job);return job;}
      if(kind!=='dates')throw Error('Invalid job type');
      timeZone=validateZone(timeZone);
      if(!['uniform','rules'].includes(scheduleMode))throw Object.assign(Error('Select a supported scheduling mode.'),{code:'INVALID_SCHEDULING_MODE'});
      activityTypes=validateActivityTypes(activityTypes);
      if(scheduleMode==='uniform'){
        dates=validateDates(dates);
        if(Date.parse(dates.start)>=Date.parse(dates.due))throw Object.assign(new Error('Bulk dates must satisfy Start < Due <= End, including Discussion Topics.'),{code:'INVALID_DATES'});
      } else {rules=validateRules(rules);dates=null;}
      const rows=parseCourseCsv(csv);
      const job={_id:randomUUID(),owner,...(createdBy?{createdBy}:{}),kind,status:'validating',createdAt:now(),updatedAt:now(),scheduleMode,scheduleVersion:1,activityTypes,...(scheduleMode==='rules'?{rules}:{}),...(dates?{dates}:{}),timeZone,rows,courses:[],tasks:[],totals:{total:0}};
      await store.insert(job);return job;
    },
    get:(id,owner)=>store.get(id,owner),
    ...(typeof store.getStatus==='function'?{getStatus:(id,owner)=>store.getStatus(id,owner)}:{}),
    list:(owner,kind)=>store.list(owner,kind),
    requestCopyCheck:(id,owner)=>store.requestCopyCheck(id,owner),
    activate:(id,owner)=>store.activate(id,owner,now()),
    review:(id,owner)=>store.review(id,owner,now()),
    async confirm(id,owner) {return store.confirm(id,owner,now());},
    async cancel(id,owner) {
      const cancelled=await store.cancel(id,owner);
      if(cancelled){const job=activePlans.get(id);if(job){cancelledJobs.add(id);job.status='cancelled';job.message='Planning was cancelled. Saved course and activity results are retained; no activity date updates were started.';}if(activeStep3Job===id)step3CancelJobs.add(id);if(activeDeploymentStep3Job===id)deploymentCancelJobs.add(id);}
      return cancelled;
    },
    async tick() {
      if(busy)return;busy=true;
      let job,held=false,heartbeat;
      try {
        held=await store.acquire(worker);if(!held)return;
        heartbeat=setInterval(()=>store.renew(worker).catch(()=>{}),10000);heartbeat.unref?.();
        job=await store.claim(worker);if(!job)return;
        job.performance ||= {};const phase=job.status==='planning'?'preparation':job.operation==='check'?'check':'submission';
        job.performance[phase+'StartedAt']=now();
        if(job.status==='planning') {
          if(job.kind==='courseCopy'){let checkedAt=-Infinity,cancelCheck;await courseCopy.plan(job,save,()=>{if(now()-checkedAt>=500){checkedAt=now();cancelCheck=Promise.resolve().then(async()=>{if(await store.isCancelled?.(job._id,job.owner))throw Object.assign(Error('Validation cancelled'),{code:'JOB_CANCELLED'});});}return cancelCheck;});}else if(job.kind==='sourceDeployment')await deployment.plan(job,save);else if(job.kind==='sourceCreation'){let checkedAt=-Infinity;await sourceCreation.plan(job,save,async()=>{if(now()-checkedAt>=500){checkedAt=now();if(await store.isCancelled?.(job._id,job.owner))throw Object.assign(Error('Validation cancelled'),{code:'JOB_CANCELLED'});}});}else {activePlans.set(job._id,job);try{await plan(job);}finally{activePlans.delete(job._id);cancelledJobs.delete(job._id);}}
        } else {
          const involved=job.kind==='sourceDeployment'?job.tasks.flatMap(t=>[t.sourceId,...t.targets.map(r=>r.orgUnitId)]):job.courses.map(c=>c.orgUnitId);
          const blocked=false; // Deployment history and copy monitoring never reserve courses.
          if(blocked){job.status='failed';job.message='A source or target has a deployment awaiting review in Brightspace. Review that job before modifying these courses.';}
          else if(job.kind==='sourceDeployment'&&job.operation!=='activate'){
            const priorDeploymentMeasurement=job.performance?.deploymentStep3Utilization;
            activeDeploymentStep3Tracker=createDeploymentStep3Utilization({prior:priorDeploymentMeasurement});activeDeploymentStep3Job=job._id;activeDeploymentStep3StartedAt=performance.now();activeDeploymentStep3ElapsedBaseMs=Number(priorDeploymentMeasurement?.elapsedMs)||0;activeDeploymentStep3Coverage='running';
            try{await withStep3Utilization(activeDeploymentStep3Tracker,()=>deployment.execute(job,save,()=>store.renew(worker),activeDeploymentStep3Tracker,(id,owner)=>deploymentCancelJobs.has(id)||store.isCancelled?.(id,owner)));activeDeploymentStep3Coverage='complete';}
            catch(error){activeDeploymentStep3Coverage='interrupted';throw error;}
          }
          else if(job.kind==='sourceDeployment')await deployment.activate(job,save,()=>store.renew(worker));
          else if(job.kind==='courseCopy')await courseCopy.execute(job,save,()=>store.renew(worker));
          else if(job.kind==='sourceCreation')await sourceCreation.execute(job,save,()=>store.renew(worker),(id,owner)=>store.isCancelled?.(id,owner));
          else await execute(job);
        }
        const preparationSaved=job.kind==='sourceDeployment'&&phase==='preparation'&&job.performance.preparationMs!=null;
        if(!preparationSaved){job.performance[phase+'FinishedAt']=now();job.performance[phase+'Ms']=now()-job.performance[phase+'StartedAt'];await save(job);}
      } catch(error) {
        if(activeDeploymentStep3Job===job?._id)activeDeploymentStep3Coverage='interrupted';
        if(activeStep3Job===job?._id)activeStep3Tracker?.finish();
        if(error.code==='JOB_CANCELLED'){
          if(job?.kind==='dates'&&activeStep3Job===job._id){job.status='cancelled';job.cancelledDuringStep3=true;job.message='Job cancelled. Confirmed updates are saved; activities not started remain pending.';job.step3StartedAt=null;try{await save(job);}catch{/* Keep the durable cancellation request for recovery. */}}
          if(job?.kind==='sourceDeployment'){job.status='cancelled';job.deploymentStep3StartedAt=null;job.message='Cancellation completed. Saved deployment and activation outcomes are retained; unstarted replicas were not attempted. Accepted Brightspace copies may continue asynchronously.';try{await save(job);}catch{/* Keep the durable cancellation request for recovery. */}}
          return;
        }
        if(job&&pendingPreparationTiming.has(job)){delete job.performance.preparationFinishedAt;delete job.performance.preparationMs;pendingPreparationTiming.delete(job);}
        require('./diagnostics').logFailure('job_worker_failed',error,{kind:job?.kind,jobId:job?._id});
        if(job) {const preserveDateCheckpoint=job.kind==='dates'&&job.storageVersion===2&&(['MongoNetworkError','MongoServerSelectionError','MongoBulkWriteError','MongoTopologyClosedError'].includes(error?.name)||error?.persistenceFailure||/lease lost/i.test(String(error?.message||'')));
          if(job.kind==='dates'&&job.storageVersion===2){job.status=job.status==='planning'?'validating':'queued';job.resuming=true;job.message='Processing paused. Saved activity outcomes are retained; in-flight activities require read-only reconciliation.';}else interruptJob(job);
          if(!preserveDateCheckpoint)try {await save(job);} catch { /* Durable running state is recovered after the lease expires. */ }}
      } finally {clearInterval(heartbeat);if(job){unsafeWorkerJobs.delete(job._id);step3CancelJobs.delete(job._id);deploymentCancelJobs.delete(job._id);if(activeStep3Job===job._id){activeStep3Tracker=null;activeStep3Job=null;}if(activeStep2Job===job._id){activeStep2Tracker=null;activeStep2Job=null;}if(activeDeploymentStep3Job===job._id){activeDeploymentStep3Tracker=null;activeDeploymentStep3Job=null;activeDeploymentStep3StartedAt=null;activeDeploymentStep3ElapsedBaseMs=0;activeDeploymentStep3Coverage='running';}}if(held)await store.release(worker).catch(()=>{});busy=false;}
    }
  };
}
module.exports={createBulkJobs,counts,terminal,MAX_ACTIVITIES,interruptJob};

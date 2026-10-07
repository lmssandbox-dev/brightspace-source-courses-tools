'use strict';
const { randomUUID } = require('node:crypto');
const { parseCourseCsv } = require('../dates/courseCsv');
const { validateDates } = require('../dates/activityWriters');
const {validateZone,DEFAULT_ZONE}=require('../dates/timeZone');
const TYPES=['assignment','quiz','discussionTopic'];
const MAX_ACTIVITIES=250000;
const CHECKPOINT_SIZE=50;
const {pool}=require('./pool');
const {DIRTY}=require('./dateChunks');
const terminal = new Set(['completed','completedWithErrors','failed','interrupted','cancelled','submitted','submittedWithErrors','outcomeUnknown','reviewed','activated','activationWithErrors']);
const counts = tasks => tasks.reduce((out,t)=>{const s=t.result?.status || 'pending';out[s]=(out[s]||0)+1;return out;},{total:tasks.length});
function interruptJob(job) {
  job.status='interrupted';job.message='Processing stopped. Saved results are retained; create a fresh preview before retrying.';
  if(job.kind==='sourceDeployment'&&job.operation==='activate'){
    for(const task of job.tasks)for(const target of task.targets)if(target.activation?.status==='running')target.activation={status:'failed',writeAttempted:target.activation.writeAttempted,error:{message:'Activation interrupted. Recheck active state before retrying.'}};
    job.status='activationWithErrors';job.message='Activation interrupted; deployment results are retained. Retry activation to read current states and finish.';return job;
  }
  if(job.kind==='courseCopy'){job.message='Processing interrupted. Saved copy tokens are retained. Check submitted copies; unconfirmed submissions are never automatically repeated.';return job;}
  for(const task of job.tasks) {
    if(task.result?.status==='running')task.result={status:'failed',verifiedDates:null,writeAttempted:true,error:{category:'UNCERTAIN_OUTCOME',message:'Processing stopped during this activity. Read its current dates before retrying.'}};
    else if(!task.result)task.result={status:'skipped',writeAttempted:false,error:{message:'Not executed before interruption.'}};
  }
  if(job.kind==='sourceDeployment'){job.message='Deployment processing was interrupted. Check Brightspace before any new submission; saved acceptance IDs remain available.';for(const task of job.tasks)if(task.result?.error?.category==='UNCERTAIN_OUTCOME'){task.result.status='uncertain';task.result.error.message='Deployment outcome is unknown. Check Brightspace before retrying.';}}
  job.totals=counts(job.tasks);return job;
}
function createBulkJobs({store,courses,discovery,writers,writeEnabled,deployment,courseCopy,now=Date.now}) {
  let busy=false;
  const worker=randomUUID();
  const cancelledJobs=new Set(),activePlans=new Map();
  const countCache=new WeakMap();
  const checkpoint=require('./checkpointQueue').createCheckpointQueue(saveCheckpoint);
  function save(job,dirty) {
    job.performance ||= {};job.performance.checkpointRequests=(job.performance.checkpointRequests||0)+1;
    return checkpoint(job,dirty);
  }
  async function saveCheckpoint(job,dirty) { job.updatedAt=now();let cached=countCache.get(job);
    if(!dirty||!cached){job.totals=counts(job.tasks);cached=job.tasks.map(t=>t.result?.status||'pending');countCache.set(job,cached);}
    else for(const i of dirty.tasks||[]){const before=cached[i]||'pending',after=job.tasks[i].result?.status||'pending';if(before!==after){job.totals[before]=(job.totals[before]||0)-1;job.totals[after]=(job.totals[after]||0)+1;cached[i]=after;}}
    job[DIRTY]=dirty;const started=now();
    try {await store.save(job,worker);} finally {delete job[DIRTY];}
    job.performance ||= {};job.performance.checkpoints=(job.performance.checkpoints||0)+1;job.performance.checkpointMs=(job.performance.checkpointMs||0)+now()-started; }
  async function plan(job) {
    let checkedAt=-Infinity,cancelCheck;
    const checkCancelled=async(force=false)=>{
      if(cancelledJobs.has(job._id)){job.status='cancelled';throw Object.assign(Error('Planning cancelled'),{code:'JOB_CANCELLED'});}
      if(force||now()-checkedAt>=100){checkedAt=now();cancelCheck=Promise.resolve().then(async()=>{
        if(await store.isCancelled?.(job._id,job.owner)){cancelledJobs.add(job._id);job.status='cancelled';throw Object.assign(Error('Planning cancelled'),{code:'JOB_CANCELLED'});}
      });}
      await cancelCheck;
    };
    try {
    const resolved=new Map(job.courses.map(c=>[c.orgUnitId,c.row])),resolutionCache=new Map();
    await checkCancelled(true);
    const codeSession=await courses.prepare?.(job.rows.filter(r=>r.status==='pending'),checkCancelled);
    await checkCancelled(true);
    let checkpoint=0;
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
      checkpoint++;
    },async()=>{await checkCancelled();return true;});
    await checkCancelled(true);
    job.courses.sort((a,b)=>a.row-b.row);
    await save(job);
    let reserved=job.tasks.length, discovered=job.courses.filter(c=>c.status!=='pending').length;
    await pool(job.courses.filter(c=>c.status==='pending'),4,async (course,index,stopped)=>{
      let checkpointFailure;
      try {
        const found=await discovery.discover(course.orgUnitId,{includeUndated:true,includeNative:true});
        course.counts=Object.fromEntries(TYPES.map(t=>[t,(found.activities||[]).filter(a=>a.type===t).length]));
        await checkCancelled();
        if(!found.complete)throw new Error('Incomplete discovery');
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
          const request={orgUnitId:course.orgUnitId,activity,dates:job.dates,dryRun:true,nativeActivity};
          const preview=await writers[a.type].updateActivityDates(request);
          job.tasks.push({orgUnitId:course.orgUnitId,activity,name:a.name,preview});previewed.add(taskKey);
          if(!['ready','unchanged'].includes(preview.status))course.previewInvalid=true;
          if(++checkpoint%CHECKPOINT_SIZE===0)try{await save(job);}catch(error){checkpointFailure=error;throw error;}
        }
        course.status=course.previewInvalid?'invalid':'valid';
      } catch(error) {if(checkpointFailure)throw checkpointFailure;if(error.code==='JOB_CANCELLED')throw error;course.status='invalid';course.message='Discovery failed, was incomplete, or exceeded the 250,000-activity limit.';}
      job.progress={phase:'Discovering activities',processed:++discovered,total:job.courses.length,activities:job.tasks.length};
      if(++checkpoint%CHECKPOINT_SIZE===0)await save(job);
    },async()=>{await checkCancelled();return true;});
    await checkCancelled(true);
    job.status=job.rows.some(r=>r.status==='invalid') || job.courses.some(c=>c.status!=='valid') || !job.tasks.length ? 'failed':'ready';
    job.expiresAt=now()+30*60*1000;
    if(!job.tasks.length)job.message='No eligible activities were found.';
    } catch(error) {
      if(error.code!=='JOB_CANCELLED')throw error;
      job.status='cancelled';job.message='Planning was cancelled. Saved course and activity results are retained; no activity date updates were started.';
    }
  }
  async function execute(job) {
    // All scopes are checked before the first write. Only the stored confirmed plan is executed.
    if(job.tasks.some(t=>!writeEnabled(t.activity.type))) {job.status='failed';job.message='Required write scope is unavailable. No updates were started.';return;}
    let stop=Boolean(job.systemicFailure),processed=job.tasks.filter(t=>t.result&&t.result.status!=='running').length;
    const groups=new Map();
    job.tasks.forEach((task,taskIndex)=>{if(!groups.has(task.orgUnitId))groups.set(task.orgUnitId,[]);groups.get(task.orgUnitId).push({task,taskIndex});});
    await pool([...groups.values()],4,async (group,index,stopped)=>{
     for(const {task,taskIndex} of group){
      if(stopped())return;
      if(task.result?.status==='running'){task.result={status:'failed',writeAttempted:true,error:{category:'UNCERTAIN_OUTCOME',message:'Interrupted during this activity. Inspect its dates before retrying; this write was not repeated.'}};processed++;await save(job,{tasks:[taskIndex]});continue;}
      if(task.result)continue;
      if(stop) {task.result={status:'skipped',writeAttempted:false,error:{message:'Stopped after a systemic API failure.'}};processed++;continue;}
      await store.renew(worker); // Storage/lease failure stops scheduling before any further write.
      task.result={status:'running',writeAttempted:false};await save(job,{tasks:[taskIndex]});
      if(stop||stopped()){task.result={status:'skipped',writeAttempted:false,error:{message:'Stopped before writing.'}};processed++;await save(job,{tasks:[taskIndex]});continue;}
      try {
        task.result=await writers[task.activity.type].updateActivityDates({orgUnitId:task.orgUnitId,activity:task.activity,
          dates:job.dates,expectedDates:task.preview.verifiedDates,beforeWrite:()=>store.renew(worker),dryRun:false});
      } catch {task.result={status:'failed',verifiedDates:null,writeAttempted:true,error:{category:'UNEXPECTED_FAILURE',message:'Outcome is uncertain; inspect the activity before retrying.'}};stop=true;}
      const error=task.result.error;
      if(error?.category==='API_FAILURE' && (error.httpStatus==null || [401,403,429].includes(error.httpStatus) || error.httpStatus>=500))stop=true;
      job.systemicFailure=stop;
      job.progress={phase:'Applying dates',processed:++processed,total:job.tasks.length};
      await save(job,{tasks:[taskIndex]});
     }
    });
    job.progress={phase:'Applying dates',processed,total:job.tasks.length};
    job.status=job.tasks.some(t=>['failed','skipped'].includes(t.result?.status))?'completedWithErrors':'completed';
  }
  return {
    async create({owner,csv,dates,timeZone=DEFAULT_ZONE,kind='dates',copyMode,components,validationMode}) {
      if(kind==='courseCopy'){const job={_id:randomUUID(),owner,kind,status:'validating',createdAt:now(),updatedAt:now(),rows:courseCopy.parse(csv),components:courseCopy.selection(copyMode,components),validationMode:'direct',courses:[],tasks:[],totals:{total:0}};await store.insert(job);return job;}
      if(kind==='sourceDeployment'){if(!deployment)throw Error('Deployment unavailable');const job={_id:randomUUID(),owner,kind,status:'validating',createdAt:now(),updatedAt:now(),rows:deployment.parse(csv),courses:[],tasks:[],totals:{total:0}};await store.insert(job);return job;}
      if(kind!=='dates')throw Error('Invalid job type');
      timeZone=validateZone(timeZone);
      dates=validateDates(dates);
      if(Date.parse(dates.start)>=Date.parse(dates.due))throw Object.assign(new Error('Bulk dates must satisfy Start < Due <= End, including Discussion Topics.'),{code:'INVALID_DATES'});
      const rows=parseCourseCsv(csv);
      const job={_id:randomUUID(),owner,kind,status:'validating',createdAt:now(),updatedAt:now(),dates,timeZone,rows,courses:[],tasks:[],totals:{total:0}};
      await store.insert(job);return job;
    },
    get:(id,owner)=>store.get(id,owner), list:(owner,kind)=>store.list(owner,kind),
    requestCopyCheck:(id,owner)=>store.requestCopyCheck(id,owner),
    activate:(id,owner)=>store.activate(id,owner,now()),
    review:(id,owner)=>store.review(id,owner,now()),
    async confirm(id,owner) {return store.confirm(id,owner,now());},
    async cancel(id,owner) {
      const cancelled=await store.cancel(id,owner);
      if(cancelled){const job=activePlans.get(id);if(job){cancelledJobs.add(id);job.status='cancelled';job.message='Planning was cancelled. Saved course and activity results are retained; no activity date updates were started.';}}
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
          if(job.kind==='courseCopy'){let checkedAt=-Infinity,cancelCheck;await courseCopy.plan(job,save,()=>{if(now()-checkedAt>=500){checkedAt=now();cancelCheck=Promise.resolve().then(async()=>{if(await store.isCancelled?.(job._id,job.owner))throw Object.assign(Error('Validation cancelled'),{code:'JOB_CANCELLED'});});}return cancelCheck;});}else if(job.kind==='sourceDeployment')await deployment.plan(job,save);else {activePlans.set(job._id,job);try{await plan(job);}finally{activePlans.delete(job._id);cancelledJobs.delete(job._id);}}
        } else {
          const involved=job.kind==='sourceDeployment'?job.tasks.flatMap(t=>[t.sourceId,...t.targets.map(r=>r.orgUnitId)]):job.courses.map(c=>c.orgUnitId);
          const blocked=false; // Deployment history and copy monitoring never reserve courses.
          if(blocked){job.status='failed';job.message='A source or target has a deployment awaiting review in Brightspace. Review that job before modifying these courses.';}
          else if(job.kind==='sourceDeployment')await deployment[job.operation==='activate'?'activate':'execute'](job,save,()=>store.renew(worker));
          else if(job.kind==='courseCopy')await courseCopy.execute(job,save,()=>store.renew(worker));
          else await execute(job);
        }
        job.performance[phase+'FinishedAt']=now();job.performance[phase+'Ms']=now()-job.performance[phase+'StartedAt'];
        await save(job);
      } catch(error) {
        if(error.code==='JOB_CANCELLED')return;
        require('./diagnostics').logFailure('job_worker_failed',error,{kind:job?.kind,jobId:job?._id});
        if(job) {if(job.kind==='dates'&&job.storageVersion===2){job.status=job.status==='planning'?'validating':'queued';job.resuming=true;job.message='Processing paused; saved progress will resume. In-flight writes will be flagged for review.';}else interruptJob(job);
          try {await save(job);} catch { /* Durable running state is recovered after the lease expires. */ }}
      } finally {clearInterval(heartbeat);if(held)await store.release(worker).catch(()=>{});busy=false;}
    }
  };
}
module.exports={createBulkJobs,counts,terminal,MAX_ACTIVITIES,interruptJob};

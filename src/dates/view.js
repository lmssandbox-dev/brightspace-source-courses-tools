'use strict';
const {escape,steps,upload,notice}=require('../ui/page');
const {DEFAULT_ZONE,ZONES}=require('./timeZone');
const date=(value,timeZone=DEFAULT_ZONE)=>value?new Intl.DateTimeFormat('pt-BR',{timeZone,dateStyle:'short',timeStyle:'medium'}).format(new Date(value)):'No date';
const duration=milliseconds=>{const seconds=Math.max(0,Math.floor(milliseconds/1000)),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60),remainder=seconds%60;return hours?`${hours}h ${minutes}m ${remainder}s`:minutes?`${minutes}m ${remainder}s`:`${remainder}s`;};
const timing=(job,time,totals)=>{
 const elapsedMs=(Number(job.step3ElapsedMs)||0)+(job.status==='running'&&Number.isFinite(job.step3StartedAt)?Math.max(0,time-job.step3StartedAt):0);
 const completed= Math.max(0,(totals.total||0)-(totals.pending||0)-(totals.running||0));
 const throughput=elapsedMs>0?completed*60000/elapsedMs:0;
 const terminal=['completed','completedWithErrors'].includes(job.status)||Boolean(job.cancelledDuringStep3&&job.status==='cancelled');
 const stalled=job.status==='running'&&Number.isFinite(job.step3StartedAt)&&Number.isFinite(job.step3ProgressAt)&&time-job.step3ProgressAt>=180000;
 let estimate='Calculating ETA…';
 if(job.cancelRequestedAt||job.cancelledDuringStep3)estimate='';
 else if(stalled||job.status==='interrupted')estimate='Progress paused — ETA unavailable';
 else if(!terminal&&job.status==='running'&&completed>=20&&elapsedMs>=15000){const remaining=Math.max(0,(totals.total||0)-completed);estimate=`ETA: ${duration(throughput?remaining/throughput*60000:0)}`;}
 return {elapsed:duration(elapsedMs),throughput:throughput.toFixed(1),estimate,terminal,showThroughput:elapsedMs>0};
};
const planningTiming=(job,time)=>{
 const elapsedMs=Math.max(0,Number(job.step2ElapsedMs)||0)+(Number.isFinite(job.step2StartedAt)?Math.max(0,time-job.step2StartedAt):0);
 const progress=job.progress||{},processed=Math.max(0,Number(progress.processed)||0),total=Math.max(0,Number(progress.total)||0);
 const complete=['ready','failed','cancelled'].includes(job.status);
 const stalled=['planning','validating'].includes(job.status)&&Number.isFinite(job.step2CourseProgressAt)&&time-job.step2CourseProgressAt>=180000;
 let estimate='Calculating ETA…';
 if(stalled||job.status==='interrupted')estimate='Progress paused — ETA unavailable';
 else if(complete)estimate='';
 else if(['planning','validating'].includes(job.status)&&progress.phase==='Discovering activities'&&Number(job.step2SampleCount)>=3&&Number(job.step2RatePerMs)>0&&total>processed){
  const remaining=(total-processed)/job.step2RatePerMs;
  if(Number.isFinite(remaining)&&remaining>=0)estimate=`ETA: ${duration(remaining)}`;
 }
 return {elapsed:duration(elapsedMs),estimate,phase:progress.phase||'Resolving courses',processed,total,complete};
};
const percent=(processed,total)=>total?Math.min(100,Math.floor(processed*100/total)):0;
function phaseProgress(label,processed,total,state,detail){
 const value=percent(processed,total),stateLabel=state==='complete'?'Completed':state==='active'?'In progress':state==='paused'?'Interrupted':state==='stopped'?'Stopped':'Waiting';
 return `<div class="date-phase ${state}"><div class="date-phase-heading"><h3>${escape(label)}</h3><span class="date-phase-state">${stateLabel}</span></div><p class="date-phase-count"><strong>${processed}</strong> / ${total} <span>${escape(detail)}</span></p><progress max="100" value="${value}" aria-label="${escape(label)} ${value}%"></progress></div>`;
}
function reviewProgress(job,clock){
 const discovery=clock.phase==='Discovering activities',terminal=['ready','failed','cancelled'].includes(job.status);
 const resolutionDone=discovery||(!discovery&&terminal&&clock.processed>=clock.total);
 const discoveryDone=job.status==='ready'||(discovery&&clock.processed>=clock.total&&terminal);
 const resolutionTotal=discovery?Number(job.courseTotal)||clock.total:clock.total;
 const resolutionCount=discovery?resolutionTotal:clock.processed;
 const resolutionState=resolutionDone?'complete':job.status==='interrupted'?'paused':terminal?'stopped':'active';
 const discoveryState=discoveryDone?'complete':discovery?(job.status==='interrupted'?'paused':terminal?'stopped':'active'):'pending';
 const discoveryTotal=discovery?clock.total:Number(job.courseTotal)||0;
 const discoveryCount=discovery?clock.processed:0;
 const discovered=Number.isFinite(Number(job.progress?.activities))?Number(job.progress.activities):null;
 const elapsed=clock.complete?`Final elapsed: ${clock.elapsed}`:`Elapsed: ${clock.elapsed}`;
 const timing=clock.complete?`<p class="date-progress-timing">${elapsed}</p>`:`<p class="date-progress-timing"><span>Elapsed: ${clock.elapsed}</span>${discovery?` · <span>${clock.estimate}</span>`:` · <span>Calculating ETA…</span>`}</p>`;
 return `<section class="panel date-progress" role="status"><h2>Review progress</h2><div class="date-phases">${phaseProgress('Resolving source courses',resolutionCount,resolutionTotal,resolutionState,'courses resolved')}${phaseProgress('Discovering activities',discoveryCount,discoveryTotal,discoveryState,'courses scanned')}${discovery&&discovered!==null?`<p class="date-activities-discovered"><strong>${discovered}</strong> activities discovered so far</p>`:''}</div>${timing}</section>`;
}
function createDateView({writeEnabled}){return {
 form(res,{controls,button}){const values=res.locals?.dateForm||{};return `<section id="date-management">${steps(['Upload Source Courses','Review Updates','Apply and Update'])}<form method="post" action="/bulk/preview" id="bulk-input">${controls(res,'preview')}<div class="form-grid"><div class="panel">${upload('bulk','OrgUnitId,OrgUnitCode','Provide a source course ID, code, or matching ID/code pair per row. Duplicate source courses are processed once.')}</div><aside class="panel guidance"><span class="eyebrow">Before you begin</span><h3>Bulk Activity Dates Manager</h3><ul class="explanation"><li><strong>Course Mapping</strong><p>Use IDs, codes, or both. If both are supplied, they must match.</p></li><li><strong>What will change</strong><p>The same dates apply to assignments, quizzes, and discussion topics in every listed course.</p></li><li><strong>Review first</strong><p>Review the changes before applying. Fix any course or identifier errors to continue.</p></li></ul></aside></div><div class="panel date-schedule"><span class="eyebrow">Schedule</span><h3>Choose the new dates</h3><div class="date-schedule-fields"><label class="field">Time zone<select name="timeZone" required style="display:block;width:100%;margin-top:7px">${ZONES.map(zone=>`<option value="${escape(zone)}" ${zone===(values.timeZone||DEFAULT_ZONE)?'selected':''}>${escape(zone===DEFAULT_ZONE?'Brasília — America/Sao_Paulo':zone.replaceAll('_',' '))}</option>`).join('')}</select></label>${['start','due','end'].map(k=>`<label class="field">${k[0].toUpperCase()+k.slice(1)} date and time<input type="datetime-local" name="${k}" step="1" value="${escape(values[k]||'')}" required></label>`).join('')}</div><p class="muted">Start must be before Due. End must be on or after Due.</p></div><div class="action-bar date-upload-actions"><button class="primary">2. Review Updates</button></div></form></section>`;},
 render(res,job,{button,now,page=1}){
 const total=job.totals?.total??job.tasks?.length??0;
 const totals=job.totals||job.tasks?.reduce((out,t)=>{const status=t.result?.status||'pending';out[status]=(out[status]||0)+1;return out;},{total})||{total};
 const count=status=>totals[status]||0;
 const unresolved=count('uncertain'),pending=count('pending')+count('running');
 const clock=timing(job,now(),totals);
 const planClock=planningTiming(job,now());
 const completedCount=count('updated')+count('unchanged')+count('failed')+count('skipped');
 const percent=total?Math.min(100,Math.floor(completedCount*100/total)):0;
 const review=job.status==='ready';
 const success=job.status==='completed'&&total>0&&count('updated')+count('unchanged')===total;
 const checking=['validating','planning'].includes(job.status);
 const updating=['queued','running'].includes(job.status);
 const updated=count('updated');
 const unchanged=count('unchanged');
 const timeZone=job.timeZone||DEFAULT_ZONE;
 const active=['validating','planning','queued','running'].includes(job.status),permitted=job.tasks?job.tasks.every(t=>writeEnabled(t.activity.type)):false;
 const stage=['validating','planning'].includes(job.status)?0:job.status==='ready'?1:2;
 const issues=count('failed')+count('skipped')+unresolved+(job.rows||[]).filter(r=>r.status==='invalid').length+(job.courses||[]).filter(c=>c.status==='invalid').length;
 const outcomes={
 cancelled:job.cancelledDuringStep3?['Job Cancelled — Partial Updates Saved',`${updated} updated, ${unchanged} unchanged, ${count('failed')} failed, ${unresolved} uncertain, ${count('skipped')} skipped, and ${count('pending')} not attempted. Already-applied changes remain in Brightspace.`]:['Job Cancelled','This job was cancelled during planning. No activity date updates were started.'],
 failed:['Needs Attention','The job could not complete. Download the CSV report to review the issues before starting a new job.'],
 completedWithErrors:['Completed with Issues',`${updated} activities were updated and ${unchanged} already had the requested dates. Some activities could not be updated. Download the CSV report for details.`],
 interrupted:['Processing Interrupted','Processing stopped before completion. Some dates may have changed. Review the CSV report before starting another job.'],
 completed:['Needs Attention','The saved results do not confirm that all activities have the requested dates. Download the CSV report for details.']
 };
 const outcome=!success&&outcomes[job.status];
 const detail=job.message||(job.rows||[]).find(r=>r.status==='invalid'&&r.message)?.message||(job.courses||[]).find(c=>c.status==='invalid'&&c.message)?.message||(job.tasks||[]).find(t=>t.result?.error?.message)?.result.error.message;
 const outcomeBox=outcome?`<section class="confirmation ${job.status==='cancelled'?'neutral-confirmation':'warning-confirmation'}" role="status"><h2>${escape(outcome[0])}</h2><p>${escape(outcome[1])}</p>${detail?`<p>${escape(detail)}</p>`:''}</section>`:'';
 const showReview=checking||(['ready','failed','cancelled','interrupted'].includes(job.status)&&Number.isFinite(job.step2ElapsedMs));
 const showApply=updating||['completed','completedWithErrors','interrupted'].includes(job.status)||(job.status==='cancelled'&&job.cancelledDuringStep3);
 const applyState=job.cancelRequestedAt&&job.status==='running'?'Stopping updates…':job.status==='queued'?'Queued':job.status==='running'?'Running':job.status==='completedWithErrors'?'Completed with Issues':job.status==='completed'?'Completed':job.cancelledDuringStep3?'Job Cancelled — Partial Updates Saved':'Interrupted';
 const applyNote=job.cancelRequestedAt&&job.status==='running'?'In-progress operations are finishing. Saved results will be retained.':job.status==='queued'?'Waiting to start. No ETA is available.':job.status==='interrupted'?'Progress paused — ETA unavailable':'';
 const approximate=clock.estimate.startsWith('ETA: ')?clock.estimate.slice(5):clock.estimate;
 const datesPanel=`<section class="panel"><h2>${success?'Updated Dates':'Requested Dates'} <small>${escape(timeZone)}</small></h2><div class="date-summary">${['start','due','end'].map(k=>`<div><span>${k[0].toUpperCase()+k.slice(1)}</span><strong>${escape(date(job.dates[k],timeZone))}</strong></div>`).join('')}</div></section>`;
 const applyPanel=showApply?`<section class="panel date-progress apply-progress" role="status"><h2>Date Update Progress</h2><p><strong>Current state:</strong> ${applyState}</p>${applyNote?`<p class="muted">${applyNote}</p>`:''}<div class="apply-progress-main"><strong class="apply-percent">${percent}%</strong><div><p class="apply-processed"><strong>${completedCount}</strong> / ${total} <span>activities processed</span></p><progress max="100" value="${percent}" aria-label="Progress ${percent}%"></progress></div></div><div class="apply-counters"><div><strong>${updated}</strong><span>Updated</span></div><div><strong>${unchanged}</strong><span>Unchanged</span></div><div><strong>${count('failed')}</strong><span>Failed</span></div><div><strong>${pending}</strong><span>Pending</span></div><div><strong>${unresolved}</strong><span>Uncertain</span></div><div><strong>${count('skipped')}</strong><span>Skipped</span></div></div>${job.status==='queued'?'':`<div class="apply-timing"><span>${clock.terminal?`Final elapsed: ${clock.elapsed}`:`Elapsed: ${clock.elapsed}`}</span>${clock.showThroughput?`<span>Throughput: ${clock.throughput} activities/min</span>`:''}${clock.terminal||job.cancelRequestedAt?'':`<span>${job.status==='interrupted'||clock.estimate.startsWith('Progress paused')?clock.estimate:`Approximate remaining time: ${approximate}`}</span>`}</div>`}</section>`:'';
 return `<div data-date-job hidden></div>${steps(['Upload Source Courses','Review Updates','Apply and Update'],stage)}<div class="metrics"><div><strong>${job.courseTotal??job.courses?.length??'—'}</strong><span>Courses</span></div><div><strong>${total}</strong><span>Activities</span></div><div><strong>${issues}</strong><span>Need attention</span></div></div>${datesPanel}${showReview?reviewProgress(job,planClock):''}${applyPanel}${outcomeBox}${success?`<section class="confirmation success-confirmation" role="status"><h2>✓ Activity Dates Updated</h2><p>${updated?`Updated dates for <strong>${updated} ${updated===1?'activity':'activities'}</strong>. `:''}${unchanged?`<strong>${unchanged} ${unchanged===1?'activity already had':'activities already had'}</strong> the requested dates. `:''}All <strong>${total} ${total===1?'activity':'activities'}</strong> across <strong>${job.courseTotal??job.courses?.length??'—'} source courses</strong> now have the requested dates, updated in Brightspace.</p></section>`:''}
 ${job.status==='ready'&&job.expiresAt>now()&&permitted?`<section class="confirmation"><h2>Ready to apply</h2><p>This will update all <strong>${job.tasks.length} ${job.tasks.length===1?'activity':'activities'}</strong> in <strong>${job.courses.length} source ${job.courses.length===1?'course':'courses'}</strong>. Confirm the requested dates above before continuing.</p><div class="confirmation-actions">${button(res,'apply',job._id,'3. Apply & Update')}</div></section>`:''}
 ${job.status==='ready'&&!permitted?notice('Apply is unavailable. Configure the required write scopes for every activity type in this plan.','warning'):''}${job.status==='ready'&&job.expiresAt<=now()?notice('This preview expired. Select Bulk Activity Dates Manager in the sidebar and create a new preview.','warning'):''}
 ${active?`<div class="processing" role="status"><d2l-loading-spinner size="24"></d2l-loading-spinner><div><strong>${updating?'Updating your Source Courses':'Checking your Source Courses'}</strong><p>Results refresh every 10 seconds. You can close this page and return through Job history.</p></div></div>`:''}
 <div class="toolbar">${button(res,'status',job._id,'Refresh status',`id="job-refresh" data-page="${page}"`)}${button(res,'report',job._id,'Download CSV report')}${['validating','planning','ready','queued'].includes(job.status)||(job.status==='running'&&!job.cancelRequestedAt)?button(res,'cancel',job._id,'Cancel this job',job.status==='running'?`onsubmit="return confirm('${escape('Already-applied updates will not be reversed. New activity updates will stop. Operations already in progress may finish. A partial CSV report will remain available.')}')"`:''):''}</div>
 ${active?'<script>setTimeout(()=>document.getElementById("job-refresh").requestSubmit(),10000);</script>':''}`;
 }
};}
module.exports={createDateView};

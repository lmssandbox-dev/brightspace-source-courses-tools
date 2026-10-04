'use strict';
const { createHash,createHmac,timingSafeEqual }=require('node:crypto');
const { deploymentGuard }=require('./deploymentGuard');
const {DEFAULT_ZONE,validateZone,localDateToUtc}=require('../dates/timeZone');
const {createDateView}=require('../dates/view');
const {badge,table}=require('../ui/page');
const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=v=>v?new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'medium'}).format(new Date(v)):'—';
function createBulkDates({jobs,deploymentId,secret,writeEnabled,now=Date.now,view,kind='dates'}) {
  const presentation=view||createDateView({writeEnabled});
  if(!secret)throw new Error('Bulk forms require the configured application key.');
  const prefix=kind==='sourceDeployment'?'/deploy':'/bulk';
  const guard=deploymentGuard(deploymentId);
  const owner=res=>createHash('sha256').update(JSON.stringify([res.locals.token.iss,res.locals.token.deploymentId,res.locals.token.user])).digest('hex');
  const session=res=>createHash('sha256').update(String(res.locals.ltik)).digest('hex');
  const signature=value=>createHmac('sha256',secret).update(value).digest('hex');
  function token(res,action,id='') {const data=Buffer.from(JSON.stringify({kind,action,id,session:session(res),expires:now()+30*60*1000})).toString('base64url');return `${data}.${signature(data)}`;}
  function valid(res,value,action,id='') {
    try {const [data,sig]=String(value).split('.');const expected=signature(data);if(sig.length!==expected.length||!timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return false;
      const t=JSON.parse(Buffer.from(data,'base64url'));return t.kind===kind&&t.session===session(res)&&t.action===action&&t.id===id&&t.expires>now();}catch{return false;}
  }
  const hidden=(k,v)=>`<input type="hidden" name="${k}" value="${escape(v)}">`;
  function controls(res,action,id='') {return hidden('ltik',res.locals.ltik)+hidden('ticket',token(res,action,id))+hidden('jobId',id);}
  function button(res,action,id,label,extra='') {return `<form method="post" action="${prefix}/${action}" ${extra}>${controls(res,action,id)}${hidden('page',Number(extra.match(/data-page="(\d+)"/)?.[1]||1))}<button class="${['apply','activate'].includes(action)?'primary':'secondary'}">${escape(label)}</button></form>`;}
  function form(res){return presentation.form(res,{controls,button});}
  function render(res,job,page=1){return presentation.render(res,job,{controls,button,now,page});}
  function authorize(req,res,action) {
    res.set('Cache-Control','no-store');res.set('Referrer-Policy','no-referrer');
    if(!guard(res.locals.token,req,res))return false;
    if(!res.locals.ltik || typeof res.locals.token?.user!=='string' || !res.locals.token.user){res.status(403).send('A validated LTI user session is required.');return false;}
    if(!valid(res,req.body?.ticket,action,action==='preview'||action==='history'?'':req.body?.jobId)){res.status(403).send('Form expired or invalid. Relaunch through Brightspace.');return false;}
    return true;
  }
  const handlers={form,historyButton:res=>button(res,'history','',kind==='dates'?'View Date Jobs':'View Deployment Jobs')};
  for(const action of ['preview','apply','status','cancel','history','report','review','activate'])handlers[action]=async(req,res)=>{
    if(!authorize(req,res,action))return;
    try {
      if(action==='history'){const list=await jobs.list(owner(res),kind);return res.send(`<div class="section-heading"><div><span class="eyebrow">Job history</span><h1>${kind==='dates'?'Activity Dates Update Jobs':'Deployment Jobs'}</h1><p>Your latest 100 saved jobs. Open one to review results or continue.</p></div></div><section class="panel">${table(['Created · Brasília','Status','Job',''],list.map(j=>[escape(new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'}).format(new Date(j.createdAt||now()))),badge(j.status)+(kind==='sourceDeployment'?`<small>${j.copyMonitorCheckedAt?'Copy logs checked '+escape(new Date(j.copyMonitorCheckedAt).toISOString()):'Copy completion unconfirmed'}</small>`:''),escape(j._id),button(res,'status',j._id,'View job')]),'No jobs yet. Start a workflow from Workspace.')}</section>`);}
      if(action==='preview'){
        let dates,timeZone;
        res.locals.dateForm=req.body;
        try {if(kind==='dates'){timeZone=validateZone(req.body.timeZone??DEFAULT_ZONE);dates=Object.fromEntries(['start','due','end'].map(k=>[k,localDateToUtc(req.body[k],timeZone)]));}}
        catch(e){return res.status(400).send(`<p role="alert">${escape(e.code==='INVALID_DATE'?e.message:'Enter valid dates and a time zone.')}</p>${form(res)}`);}
        let job;
        try {job=await jobs.create({owner:owner(res),csv:req.body.csv,dates,timeZone,kind});}
        catch(e){return res.status(400).send(`<p>${escape(['INVALID_CSV','INVALID_DATES','INVALID_DATE'].includes(e.code)?e.message:'Could not create preview. Check database availability.')}</p>${form(res)}`);}
        return res.send(render(res,job));
      }
      const job=await jobs.get(req.body.jobId,owner(res));if(!job||(job.kind||'dates')!==kind)return res.status(404).send('Job not found.');
      if(action==='apply') {
        if(kind==='sourceDeployment'&&req.body.confirmReset!=='yes')return res.status(400).send('Confirm the reset of the listed replicas before deployment.');
        if(!(view?view.canApply():job.tasks.every(t=>writeEnabled(t.activity.type))))return res.status(403).send('A required write scope is unavailable.');
        if(!await jobs.confirm(job._id,owner(res)))return res.status(409).send('Job expired, was already confirmed, or is not ready.');
      }
      if(action==='activate'){
        if(kind!=='sourceDeployment')return res.status(400).send('Reactivation is available only for deployment jobs.');
        if(!view.canApply())return res.status(403).send('Required scopes are unavailable.');
        if(!await jobs.activate(job._id,owner(res)))return res.status(409).send('Activation is already queued or this job is not eligible.');
      }
      if(action==='review'){if(kind!=='sourceDeployment'||req.body.confirmReviewed!=='yes')return res.status(400).send('Confirm review in Brightspace.');if(!await jobs.review(job._id,owner(res)))return res.status(409).send('Job cannot be reviewed in its current state.');}
      if(action==='cancel'&&!await jobs.cancel(job._id,owner(res)))return res.status(409).send('Job is already processing or finished.');
      if(action==='report') {res.set('Content-Type','text/csv; charset=utf-8');res.set('Content-Disposition','attachment; filename="bulk-job-results.csv"');return res.send(view?view.report(job):report(job));}
      return res.send(render(res,await jobs.get(job._id,owner(res)),Number(req.body.page)||1));
    } catch {return res.status(503).send('Job storage is unavailable. Refresh or relaunch to check the saved status before retrying.');}
  };
  return handlers;
}
function report(job) {
  const rows=[['Record','CSV row','Course ID','Course code','Activity type','Activity ID','Name','Status','Requested Start UTC','Requested Due UTC','Requested End UTC','Current Start UTC','Current Due UTC','Current End UTC','Message','Selected time zone']];
  for(const r of job.rows)rows.push(['CSV',r.row,r.resolvedId||r.orgUnitId,r.orgUnitCode,'','','',r.status,'','','','','','',r.message,job.timeZone||DEFAULT_ZONE]);
  const coursesById=new Map(job.courses.map(c=>[c.orgUnitId,c]));
  for(const t of job.tasks){const r=t.result||t.preview,c=coursesById.get(t.orgUnitId);rows.push(['Activity',c?.row,t.orgUnitId,c?.code,t.activity.type,t.activity.id,t.name,r.status,job.dates.start,job.dates.due,job.dates.end,r.verifiedDates?.start,r.verifiedDates?.due,r.verifiedDates?.end,r.error?.message,job.timeZone||DEFAULT_ZONE]);}
  // Quote all cells and neutralize spreadsheet formula injection in native names/codes.
  return '\uFEFF'+rows.map(row=>row.map(v=>{let s=String(v??'');if(/^[\s]*[=+\-@]/.test(s)||/^[\t\r\n]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}).join(',')).join('\r\n');
}
module.exports={createBulkDates,report};

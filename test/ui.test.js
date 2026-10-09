'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {installUi}=require('../src/ui/install');
const {page,workspace}=require('../src/ui/page');
const {createDeploymentView}=require('../src/replication/view');
const {createDateView}=require('../src/dates/view');
const helpers={controls:()=>'<input type="hidden" name="ticket" value="signed">',button:(r,a,id,label,extra='')=>`<form action="/${a}" ${extra}><button>${label}</button></form>`,now:()=>100};
test('UI middleware serves only public bundle paths and leaves CSV/JSON payloads intact',()=>{
 let middleware;const assets=[],whitelist=[];
 installUi({whitelist:x=>whitelist.push(x.route),app:{get:(route,handler)=>assets.push(route),use:f=>middleware=f}});
 assert.deepEqual(assets,['/assets/app.js','/assets/app.css']);assert.deepEqual(whitelist,assets);
 for(const [type,body] of [['text/csv; charset=utf-8','a,b\r\n1,2'],['application/json','{"ok":true}']]){
  let sent;const res={locals:{},getHeader:()=>type,set:()=>{},send:value=>{sent=value;}};
  middleware({path:'/bulk/report'},res,()=>{});res.send(body);assert.equal(sent,body);
 }
 let sent;const res={locals:{ltik:'"/><script>bad()</script>'},getHeader:()=>'',set:()=>{},send:value=>{sent=value;}};
 middleware({path:'/bulk/preview'},res,()=>{});res.send('<h1>Preview</h1>');assert.match(sent,/<!doctype html>/);assert.match(sent,/\/assets\/app.js/);assert.doesNotMatch(sent,/<script>bad/);assert.match(sent,/&lt;script&gt;/);
});
test('workspace renders the selected sidebar panel and omits development tools',()=>{
 const html=workspace({dates:'Dates',replication:'Replication',history:'History',tools:'Diagnostics',selected:'replication'});
 assert.match(html,/data-section="replication" aria-current="page"/);assert.match(html,/id="pane-dates" hidden/);assert.match(html,/id="pane-replication"  aria-label="Bulk Source Courses Deployer"/);assert.doesNotMatch(html,/Development tools|d2l-tabs/);
 assert.match(page('content'),/Brightspace Source Courses Tools/);assert.doesNotMatch(page('content'),/<footer>/);
 assert.doesNotMatch(page('content',{ltik:'secret'}),/href="[^\"]*secret/);
});
test('submitted replication exposes monitoring and reactivation without claiming completion',()=>{
 const job={_id:'j',status:'submitted',rows:[],tasks:[{sourceId:'10',sourceName:'<script>bad</script>',targets:[{orgUnitId:'20',name:'Replica',isActive:true,deactivation:{status:'updated'}}],result:{status:'submitted',deploymentId:'123'}}]};
 const html=createDeploymentView({enabled:()=>true}).render({},job,helpers);
 assert.match(html,/Copies in Process/);assert.match(html,/Retry reactivation/);assert.match(html,/Unconfirmed copies/);assert.doesNotMatch(html,/setTimeout|<d2l-loading-spinner|<script>bad/);assert.doesNotMatch(html,/Sources and replicas|CSV validation|Job details and deployment IDs|My deployment jobs/);
});
test('date review retains course-level blocking errors and does not offer Apply on failure',()=>{
 const job={_id:'j',status:'failed',dates:{},rows:[],courses:[{orgUnitId:'20',name:'Course',status:'invalid',message:'Discovery incomplete'}],tasks:[]};
 const html=createDateView({writeEnabled:()=>true}).render({},job,helpers);
 assert.match(html,/Discovery incomplete/);assert.match(html,/Needs Attention/);assert.doesNotMatch(html,/Course validation/);assert.doesNotMatch(html,/action="\/apply"/);
});

// ltijs registers its launch route during setup, before later app middleware.
test('page shell wraps an LTI launch registered after serverAddon',()=>{
 const {installPageShell}=require('../src/ui/install');
 const stack=[];
 installPageShell({use:fn=>stack.push(fn)});
 stack.push((req,res)=>res.send(workspace({dates:'Date form',replication:'Deploy form',history:'History'})));
 let output;const headers={};
 const res={locals:{ltik:'session'},getHeader:key=>headers[key],set:(key,value)=>headers[key]=value,send:body=>{output=body;}};
 stack[0]({path:'/'},res,()=>stack[1]({path:'/'},res));
 assert.match(output,/<!doctype html>/);assert.match(output,/href="\/assets\/app.css"/);assert.match(output,/src="\/assets\/app.js"/);assert.match(output,/Brightspace Source Courses Tools/);
 assert.equal((output.match(/<!doctype html>/g)||[]).length,1);
});
test('entry point installs page shell in serverAddon before launch routes',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const source=fs.readFileSync(path.join(__dirname,'../index.js'),'utf8');
 assert.match(source,/serverAddon: app => \{[\s\S]*?installBulkStatusDiagnostics\(app\);\s*installDateUploadLimit\(app\);\s*installPageShell\(app\);/);
 assert.match(source,/installUi\(lti,\{shell:false\}\)/);
});

test('review and results retain sidebar POST navigation without exposing session in URLs',()=>{
 const html=page('<h1>Review your date updates</h1>',{ltik:'session-secret',section:'dates'});
 assert.equal((html.match(/data-sidebar-native/g)||[]).length,4);
 for(const section of ['copy','dates','replication','history'])assert.ok(html.includes(`name="section" value="${section}"`));
 assert.match(html,/data-sidebar-native aria-current="page"/);
 assert.doesNotMatch(html,/href="[^"]*session-secret/);
 const home=page(workspace({dates:'Dates',replication:'Deploy',history:'History'}),{ltik:'session-secret'});
 assert.equal((home.match(/class="sidebar-layout"/g)||[]).length,1);
});

test('successful date jobs show confirmation instead of review details; partial failures do not claim success',()=>{
 const job={_id:'j',status:'completed',dates:{},rows:[],courses:[{orgUnitId:'1'}],tasks:[{activity:{type:'quiz',id:'1'},result:{status:'updated'}},{activity:{type:'quiz',id:'2'},result:{status:'unchanged'}}]};
 const view=createDateView({writeEnabled:()=>true});
 const html=view.render({},job,helpers);
 assert.match(html,/Activity Dates Updated/);assert.match(html,/activity already had/);assert.match(html,/Updated Dates/);
 assert.doesNotMatch(html,/Review your date updates|CSV validation|Course validation|Job details|My recent jobs|Page 1 of/);
 job.status='completedWithErrors';job.tasks[0].result={status:'failed',error:{message:'Verification failed'}};
 const failed=view.render({},job,helpers);assert.doesNotMatch(failed,/success-confirmation/);assert.match(failed,/Verification failed/);
});

test('date progress uses persisted totals, separates uncertain work, and does not read task chunks',()=>{
 const job={_id:'j',status:'running',dates:{},courseTotal:8,totals:{total:10,updated:5,unchanged:1,failed:1,skipped:1,uncertain:1,pending:1},progress:{phase:'Applying dates',processed:9,total:10}};
 const html=createDateView({writeEnabled:()=>true}).render({},job,helpers);
 assert.match(html,/Apply progress/);assert.match(html,/80%/);assert.match(html,/<strong>5<\/strong><span>Updated<\/span>/);assert.match(html,/<strong>1<\/strong><span>Uncertain<\/span>/);assert.match(html,/<strong>1<\/strong><span>Pending<\/span>/);assert.match(html,/Running/);assert.match(html,/Approximate remaining time:/);assert.doesNotMatch(html,/>100%<|success-confirmation/);
 job.status='completedWithErrors';const terminal=page(createDateView({writeEnabled:()=>true}).render({},job,helpers),{ltik:'session'});assert.match(terminal,/Completed with Issues/);assert.doesNotMatch(terminal,/Activity Dates Updated|success-confirmation/);
});

test('Date Manager ETA waits for enough durable progress and refreshes from current persisted metadata',()=>{
 const view=createDateView({writeEnabled:()=>true});let time=16000;
 const job={_id:'j',status:'running',dates:{},courseTotal:1,totals:{total:30,updated:20,pending:10},step3StartedAt:1000,step3ElapsedMs:0,step3ProgressAt:15000};
 let html=view.render({},job,{...helpers,now:()=>time});
 assert.match(html,/Elapsed: 15s/);assert.match(html,/Throughput: 80\.0 activities\/min/);assert.match(html,/Approximate remaining time: 7s/);
 time=26000;html=view.render({},job,{...helpers,now:()=>time});
 assert.match(html,/Elapsed: 25s/);assert.match(html,/Throughput: 48\.0 activities\/min/);assert.match(html,/Approximate remaining time: 12s/);
 job.totals.updated=19;job.totals.pending=11;html=view.render({},job,{...helpers,now:()=>time});assert.match(html,/Calculating ETA…/);assert.doesNotMatch(html,/ETA: \d/);
 job.totals.updated=20;job.totals.pending=10;job.step3StartedAt=11000;job.step3ElapsedMs=5000;time=26000;html=view.render({},job,{...helpers,now:()=>time});
 assert.match(html,/Elapsed: 20s/);assert.match(html,/Approximate remaining time: 10s/);
});

test('stalled, interrupted, resumed, and completed date jobs show safe timing states',()=>{
 const view=createDateView({writeEnabled:()=>true}),time=500000;
 const job={_id:'j',status:'running',dates:{},totals:{total:40,updated:25,pending:15},step3StartedAt:100000,step3ElapsedMs:30000,step3ProgressAt:319999};
 let html=view.render({},job,{...helpers,now:()=>time});assert.match(html,/Progress paused — ETA unavailable/);assert.match(html,/Elapsed: 7m 10s/);
 job.status='interrupted';job.step3StartedAt=null;job.step3ElapsedMs=40000;html=view.render({},job,{...helpers,now:()=>time});assert.match(html,/Elapsed: 40s/);assert.match(html,/Progress paused — ETA unavailable/);
 job.status='running';job.resuming=true;job.step3StartedAt=null;job.step3ProgressAt=100000;html=view.render({},job,{...helpers,now:()=>time});assert.match(html,/Approximate remaining time: 24s/);assert.doesNotMatch(html,/Progress paused/);
 job.status='running';job.resuming=true;job.step3ElapsedMs=40000;job.step3StartedAt=time;job.step3ProgressAt=time;html=view.render({},job,{...helpers,now:()=>time+20000});
 assert.match(html,/Elapsed: 1m 0s/);assert.match(html,/Approximate remaining time: 36s/);assert.doesNotMatch(html,/6m/);
 job.status='completed';job.step3StartedAt=null;job.step3ElapsedMs=60000;html=view.render({},job,{...helpers,now:()=>time+40000});
 assert.match(html,/Final elapsed: 1m 0s/);assert.match(html,/Throughput: 25\.0 activities\/min/);assert.doesNotMatch(html,/ETA|Calculating/);
});

test('Step 2 shows one adaptive planning ETA and final elapsed time',()=>{
 const view=createDateView({writeEnabled:()=>true});let time=60000;
 const job={_id:'plan',status:'planning',dates:{},totals:{total:0},progress:{phase:'Resolving courses',processed:12,total:30},step2StartedAt:10000,step2ElapsedMs:5000,step2ProgressAt:55000,step2CourseProgressAt:55000};
 let html=view.render({},job,{...helpers,now:()=>time});
 assert.match(html,/Review progress/);assert.match(html,/Resolving source courses/);assert.match(html,/<strong>12<\/strong> \/ 30/);assert.match(html,/Elapsed: 55s/);assert.match(html,/Calculating ETA…/);assert.match(html,/Waiting/);assert.doesNotMatch(html,/ETA: \d/);
 job.progress={phase:'Discovering activities',processed:12,total:30};job.step2ProgressAt=55000;job.step2SampleCount=3;job.step2RatePerMs=0.001;
 html=view.render({},job,{...helpers,now:()=>time});assert.match(html,/Discovering activities/);assert.match(html,/ETA: 18s/);
 job.step2CourseProgressAt=0;time=200000;html=view.render({},job,{...helpers,now:()=>time});assert.match(html,/Progress paused — ETA unavailable/);
 job.status='ready';job.step2StartedAt=null;job.step2ElapsedMs=55000;html=view.render({},job,{...helpers,now:()=>time});assert.match(html,/Final elapsed: 55s/);assert.doesNotMatch(html,/ETA: \d|Calculating ETA/);
});

test('Step 2 separates phases, uses activity metadata, and places Requested Dates before progress',()=>{
 const view=createDateView({writeEnabled:()=>true}),time=80000;
 const job={_id:'plan',status:'planning',dates:{start:'2026-01-01T00:00:00Z',due:'2026-01-02T00:00:00Z',end:'2026-01-03T00:00:00Z'},courseTotal:8,totals:{total:0},progress:{phase:'Discovering activities',processed:3,total:8,activities:42},step2StartedAt:20000,step2ElapsedMs:10000,step2SampleCount:3,step2RatePerMs:0.001};
 const html=view.render({},job,{...helpers,now:()=>time});
 assert.match(html,/Resolving source courses[\s\S]*?Completed[\s\S]*?<strong>8<\/strong> \/ 8/);assert.match(html,/Discovering activities[\s\S]*?In progress[\s\S]*?<strong>3<\/strong> \/ 8/);assert.match(html,/42<\/strong> activities discovered so far/);assert.match(html,/ETA: 5s/);
 assert.ok(html.indexOf('Requested Dates')<html.indexOf('Review progress'));
 job.status='ready';job.step2StartedAt=null;job.step2ElapsedMs=60000;job.progress={phase:'Discovering activities',processed:8,total:8,activities:42};
 const completed=view.render({},job,{...helpers,now:()=>time});assert.match(completed,/Resolving source courses[\s\S]*?Completed[\s\S]*?Discovering activities[\s\S]*?Completed/);assert.equal((completed.match(/Final elapsed: 1m 0s/g)||[]).length,1);assert.doesNotMatch(completed,/remaining time|Calculating ETA|ETA: \d/);
});

test('Step 3 state-specific progress retains counters and Requested Dates placement',()=>{
 const view=createDateView({writeEnabled:()=>true}),base={_id:'apply',dates:{},courseTotal:1,totals:{total:25,updated:20,unchanged:1,failed:1,skipped:1,uncertain:1,pending:1},step3StartedAt:1000,step3ElapsedMs:0,step3ProgressAt:10000};
 let html=view.render({}, {...base,status:'running'}, {...helpers,now:()=>16000});
 assert.ok(html.indexOf('Requested Dates')<html.indexOf('Apply progress'));assert.match(html,/92%/);assert.match(html,/<strong>23<\/strong> \/ 25/);assert.match(html,/Throughput: 96\.0 activities\/min/);assert.match(html,/Approximate remaining time:/);for(const label of ['Updated','Unchanged','Failed','Pending','Uncertain','Skipped'])assert.match(html,new RegExp(`<span>${label}<\\/span>`));
 html=view.render({}, {...base,status:'queued'},helpers);assert.match(html,/Waiting to start\. No ETA is available\./);assert.doesNotMatch(html,/Approximate remaining time|Calculating ETA/);
 html=view.render({}, {...base,status:'interrupted',step3StartedAt:null,step3ElapsedMs:12000},helpers);assert.match(html,/Progress paused — ETA unavailable/);assert.doesNotMatch(html,/Approximate remaining time:/);
 html=view.render({}, {...base,status:'completed',step3StartedAt:null,step3ElapsedMs:12000},helpers);assert.match(html,/Final elapsed: 12s/);assert.doesNotMatch(html,/Approximate remaining time|ETA: \d/);
});

test('Step 3 cancellation shows drain progress and a saved partial-result summary without ETA',()=>{
 const view=createDateView({writeEnabled:()=>true}),base={_id:'cancel',dates:{},courseTotal:1,totals:{total:10,updated:3,unchanged:1,failed:1,uncertain:1,skipped:1,pending:3},step3StartedAt:1000,step3ElapsedMs:0,step3ProgressAt:10000};
 const stopping=view.render({}, {...base,status:'running',cancelRequestedAt:12000},{...helpers,now:()=>15000});
 assert.match(stopping,/Stopping updates…/);assert.match(stopping,/In-progress operations are finishing/);assert.match(stopping,/<strong>6<\/strong> \/ 10/);assert.doesNotMatch(stopping,/Approximate remaining time:|Cancel this job/);
 const cancelled=view.render({}, {...base,status:'cancelled',cancelRequestedAt:12000,cancelledDuringStep3:true,step3StartedAt:null,step3ElapsedMs:14000},{...helpers,now:()=>15000});
 assert.match(cancelled,/Job Cancelled — Partial Updates Saved/);assert.match(cancelled,/3 updated, 1 unchanged, 1 failed, 1 uncertain, 1 skipped, and 3 not attempted/);assert.match(cancelled,/Already-applied changes remain in Brightspace/);assert.match(cancelled,/Pending/);assert.doesNotMatch(cancelled,/Approximate remaining time:|Calculating ETA/);
 const confirmable=view.render({}, {...base,status:'running'},{...helpers,now:()=>15000});assert.match(confirmable,/onsubmit="return confirm\(/);assert.match(confirmable,/A partial CSV report will remain available/);
});

test('CSV checking screens stay compact while retaining refresh, report and cancellation',()=>{
 for(const status of ['validating','planning']){
 const job={_id:'j',status,dates:{},rows:[],courses:[],tasks:[]};
 const body=createDateView({writeEnabled:()=>true}).render({},job,helpers);
 const html=page(body,{ltik:'session'});
 assert.match(html,/Checking your Source Courses/);assert.match(html,/Refresh status/);assert.match(html,/Download CSV report/);assert.match(html,/setTimeout/);
 assert.match(html,/Cancel this job/);
 assert.doesNotMatch(html,/Review your date updates|My recent jobs|CSV validation|Course validation|Job details|Page 1 of|>Workspace<|Checking courses/);
 }
});

test('queued and running date screens omit details and retain automatic refresh',()=>{
 for(const status of ['queued','running']){
 const body=createDateView({writeEnabled:()=>true}).render({}, {_id:'j',status,dates:{},rows:[],courses:[],tasks:[],progress:{phase:'Discovering activities',processed:1,total:1}},helpers);
 const html=page(body,{ltik:'session'});
 assert.match(html,/Updating your Source Courses/);assert.match(html,/Refresh status/);assert.match(html,/Download CSV report/);assert.match(html,/setTimeout/);
 assert.doesNotMatch(html,/Review your date updates|Discovering activities|My recent jobs|CSV validation|Course validation|Job details|Page 1 of|>Workspace</);
 if(status==='queued')assert.match(html,/Cancel this job/);
 }
});

 test('all date job outcomes share a compact layout with truthful status and report access',()=>{
 for(const status of ['cancelled','failed','interrupted','completedWithErrors','completed','ready','validating','planning','queued','running']){
 const job={_id:'j',status,dates:{},rows:[],courses:[],tasks:[],expiresAt:Date.now()+60000,message:'Example <issue>'};
 const html=page(createDateView({writeEnabled:()=>true}).render({},job,helpers),{ltik:'session'});
 assert.match(html,/Download CSV report/);
 assert.doesNotMatch(html,/Review your date updates|CSV validation|Course validation|Job details|My recent jobs|Page 1 of|>Workspace</);
 if(['cancelled','failed','interrupted','completedWithErrors','completed'].includes(status)){
 assert.match(html,/&lt;issue&gt;/);assert.doesNotMatch(html,/success-confirmation|action="\/apply"/);
 }
 }
 });

test('deployment resolution requires explicit review and is unavailable while processing',()=>{
 const view=createDeploymentView({enabled:()=>true});
 for(const status of ['failed','submittedWithErrors','interrupted','submitted','outcomeUnknown','activationWithErrors','running','queued','activated','reviewed']){
 const html=view.render({}, {_id:'j',status,rows:[],tasks:[]},helpers);
 assert.doesNotMatch(html,/confirmReviewed|Mark reviewed and release courses/);
 }
});
test('on-demand copy checks expose progress and snapshot timestamps without old schedule',()=>{
 const job={_id:'j',status:'activated',copyCheck:{status:'running',runId:'new',processed:10,total:5000},rows:[{sourceId:'1',targetId:'2'}],tasks:[{sourceId:'1',targets:[{orgUnitId:'2'}],result:{status:'submitted'}}],copyMonitor:{'2':{runId:'old',status:'Copy logs available',checkedAt:1000,details:'Previous log'}}};
 const view=createDeploymentView({enabled:()=>true});const html=view.render({},job,helpers),csv=view.report(job);
 assert.match(html,/10 of 5000 replicas checked/);assert.doesNotMatch(html,/<dialog|Copy Results|Deployment Results|Copy monitoring/);assert.match(html,/Checking copy results in Brightspace/);assert.match(html,/Checking for updates\. Dashboard totals will refresh automatically\./);assert.match(html,/id="deploy-refresh" hidden/);assert.doesNotMatch(html,/View copy-check progress|Refresh submission status|Courses Copied and Reactivated/);assert.doesNotMatch(html,/24 hours|window ended/);
 assert.match(csv,/Pending current check/);assert.match(csv,/1970-01-01T00:00:01.000Z/);assert.match(csv,/Previous log/);
});

test('large deployment pages stay compact and keep details in reports',()=>{
 const view=createDeploymentView({enabled:()=>true});
 const tasks=[{sourceId:'1',targets:Array.from({length:5000},(_,i)=>({orgUnitId:String(i+10),name:'Replica '+i,activation:{status:'updated'}})),result:{status:'submitted'}}];
 for(const status of ['planning','ready','running','activated','failed','cancelled']){
 const html=view.render({}, {_id:'j',status,expiresAt:Date.now()+100000,rows:[],tasks},helpers);
 assert.ok(html.length<12000);
 assert.doesNotMatch(html,/<table|Sources and replicas|CSV validation|Job details and deployment IDs|My deployment jobs|section-heading/);
 assert.match(html,/Deploy &amp; Check Copy/);
 }
});

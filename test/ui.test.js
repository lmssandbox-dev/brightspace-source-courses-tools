'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {installUi}=require('../src/ui/install');
const {page,workspace}=require('../src/ui/page');
const {createDeploymentView}=require('../src/replication/view');
const {createDateView}=require('../src/dates/view');
const helpers={controls:()=>'<input type="hidden" name="ticket" value="signed">',button:(r,a,id,label)=>`<form action="/${a}"><button>${label}</button></form>`,now:()=>100};
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
 assert.match(html,/Copy in Process/);assert.match(html,/Retry reactivation/);assert.match(html,/Unconfirmed copies/);assert.doesNotMatch(html,/setTimeout|<d2l-loading-spinner|<script>bad/);assert.doesNotMatch(html,/Sources and replicas|CSV validation|Job details and deployment IDs|My deployment jobs/);
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
 assert.match(source,/serverAddon: app => \{\s*installDateUploadLimit\(app\);\s*installPageShell\(app\);/);
 assert.match(source,/installUi\(lti,\{shell:false\}\)/);
});

test('review and results retain sidebar POST navigation without exposing session in URLs',()=>{
 const html=page('<h1>Review your date updates</h1>',{ltik:'session-secret',section:'dates'});
 assert.equal((html.match(/data-sidebar-native/g)||[]).length,3);
 for(const section of ['dates','replication','history'])assert.ok(html.includes(`name="section" value="${section}"`));
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

test('CSV checking screens stay compact while retaining refresh, report and cancellation',()=>{
 for(const status of ['validating','planning']){
 const job={_id:'j',status,dates:{},rows:[],courses:[],tasks:[]};
 const body=createDateView({writeEnabled:()=>true}).render({},job,helpers);
 const html=page(body,{ltik:'session'});
 assert.match(html,/Checking your Source Courses/);assert.match(html,/Refresh status/);assert.match(html,/Download CSV report/);assert.match(html,/setTimeout/);
 if(status==='validating')assert.match(html,/Cancel this job/);
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
 assert.match(html,/10 of 5000 replicas checked/);assert.doesNotMatch(html,/<dialog|Copy Results|Deployment Results|Copy monitoring/);assert.match(html,/Checking copy results in Brightspace/);assert.match(html,/Last saved results/);assert.match(html,/id="deploy-refresh" hidden/);assert.doesNotMatch(html,/View copy-check progress|Refresh submission status|Courses Copied and Reactivated/);assert.doesNotMatch(html,/24 hours|window ended/);
 assert.match(csv,/Pending current check/);assert.match(csv,/1970-01-01T00:00:01.000Z/);assert.match(csv,/Previous log/);
});

test('large deployment pages stay compact and keep details in reports',()=>{
 const view=createDeploymentView({enabled:()=>true});
 const tasks=[{sourceId:'1',targets:Array.from({length:5000},(_,i)=>({orgUnitId:String(i+10),name:'Replica '+i,activation:{status:'updated'}})),result:{status:'submitted'}}];
 for(const status of ['planning','ready','running','activated','failed','cancelled']){
 const html=view.render({}, {_id:'j',status,expiresAt:Date.now()+100000,rows:[],tasks},helpers);
 assert.ok(html.length<12000);
 assert.doesNotMatch(html,/<table|Sources and replicas|CSV validation|Job details and deployment IDs|My deployment jobs|section-heading/);
 assert.match(html,/Deploy &amp; Check Copies/);
 }
});

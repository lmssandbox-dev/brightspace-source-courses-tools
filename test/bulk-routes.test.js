'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createBulkDates,report}=require('../src/shared/routes');
function response(session='s',user='u',deploymentId='d') {return {locals:{ltik:session,token:{user,deploymentId,iss:'https://tenant.example'}},headers:{},code:200,set(k,v){this.headers[k]=v;return this;},status(c){this.code=c;return this;},send(v){this.body=v;return this;}};}
function ticket(html,action){const form=html.match(new RegExp(`<form[^>]*action="/bulk/${action}"[^>]*>([\\s\\S]*?)</form>`));return form?.[1].match(/name="ticket" value="([^"]+)"/)[1];}
function setup(){let time=1000;const calls=[];const job={_id:'j',status:'ready',expiresAt:9999999,dates:{start:'2027-01-01T00:00:00Z',due:'2027-01-02T00:00:00Z',end:'2027-01-03T00:00:00Z'},rows:[],courses:[],tasks:[{activity:{type:'quiz',id:'1'},orgUnitId:'1',name:'<script>alert(1)</script>',preview:{status:'ready',verifiedDates:{start:null,due:null,end:null}}}]};
let savedOwner;
const jobs={create:async r=>{calls.push(r);savedOwner=r.owner;return job;},get:async(id,owner)=>id==='j'&&owner===savedOwner?job:null,list:async()=>[],confirm:async(id,owner)=>{calls.push({id,owner});if(job.status!=='ready')return false;job.status='queued';return true;},cancel:async()=>true};
const routes=createBulkDates({jobs,deploymentId:'d',secret:'secret',writeEnabled:()=>true,now:()=>time});
return {routes,calls,job,advance:()=>{time+=1800001;}};}
async function preview(s){const res=response();await s.routes.preview({body:{ticket:ticket(s.routes.form(res),'preview'),csv:'OrgUnitId,OrgUnitCode\n1,',start:'2027-01-01T09:00',due:'2027-01-02T09:00',end:'2027-01-03T09:00'}},res);return res;}
test('bulk preview creates a plan; apply uses saved ID only and cannot repeat',async()=>{
 const s=setup(),p=await preview(s);assert.equal(s.calls.length,1);assert.match(p.body,/3\. Apply &amp; Update/);assert.doesNotMatch(p.body,/Review your date updates/);assert.doesNotMatch(p.body,/<script>alert/);assert.doesNotMatch(p.body,/CSV validation|Course validation|Job details|My recent jobs|Page 1 of/);
 const body={ticket:ticket(p.body,'apply'),jobId:'j',dates:'forged',csv:'forged'},r=response();await s.routes.apply({body},r);assert.equal(s.calls[1].id,'j');assert.equal(s.calls[1].dates,undefined);
 const repeat=response();await s.routes.apply({body},repeat);assert.equal(repeat.code,409);
});
test('bulk routes reject forged, wrong-session, wrong-owner, expired and wrong-deployment access',async()=>{
 const s=setup(),p=await preview(s),nonce=ticket(p.body,'apply');
 for(const [res,t] of [[response(),'forged'],[response('other'),nonce],[response('s','u','wrong'),nonce]]){await s.routes.apply({body:{ticket:t,jobId:'j'}},res);assert.equal(res.code,403);}
 const other=response('other','other');const otherForm=s.routes.form(other);await s.routes.preview({body:{ticket:ticket(otherForm,'preview'),csv:'x',start:'bad'}},other);assert.equal(other.code,400);
 s.advance();const expired=response();await s.routes.apply({body:{ticket:nonce,jobId:'j'}},expired);assert.equal(expired.code,403);assert.equal(s.calls.length,1);
});
test('report escapes CSV and neutralizes spreadsheet formulas',()=>{
 const csv=report({dates:{},rows:[{row:2,orgUnitCode:'=HYPERLINK("bad")',status:'invalid'}],courses:[],tasks:[{activity:{type:'quiz',id:'1'},name:'@formula',preview:{status:'failed'}}]});
 assert.match(csv,/'=HYPERLINK\(""bad""\)/);assert.match(csv,/'@formula/);
});

test('deployment form requires reset confirmation and rejects cross-workflow tickets',async()=>{
 const {createDeploymentView}=require('../src/replication/view');
 const job={_id:'deploy-job',kind:'sourceDeployment',status:'ready',expiresAt:9999999,rows:[],tasks:[{sourceId:'10',sourceName:'Source',targets:[{orgUnitId:'20',name:'Replica'}],preview:{status:'ready'}}]};
 let confirms=0;
 const jobs={create:async()=>job,get:async()=>job,confirm:async()=>{confirms++;return true;}};
 const routes=createBulkDates({jobs,deploymentId:'d',secret:'secret',kind:'sourceDeployment',view:createDeploymentView({enabled:()=>true}),now:()=>1000});
 const res=response(),form=routes.form(res);
 const pick=(html,action)=>html.match(new RegExp(`<form[^>]*action="/deploy/${action}"[^>]*>([\\s\\S]*?)</form>`))?.[1].match(/name="ticket" value="([^"]+)"/)[1];
 await routes.preview({body:{ticket:pick(form,'preview'),csv:'SourceOrgUnitId,SourceOrgUnitCode,ReplicaOrgUnitId,ReplicaOrgUnitCode\n10,,20,'}},res);
 assert.match(res.body,/reset all 1 replicas/);assert.match(res.body,/copying may still be queued or running/);
 const body={jobId:'deploy-job',ticket:pick(res.body,'apply')};const noConfirm=response();await routes.apply({body},noConfirm);assert.equal(noConfirm.code,400);assert.equal(confirms,0);
 await routes.apply({body:{...body,confirmReset:'yes'}},response());assert.equal(confirms,1);
 const dates=setup();const wrong=response();await dates.routes.preview({body:{ticket:pick(form,'preview')}},wrong);assert.equal(wrong.code,403);
});

test('reactivation retry requires a signed session and queues only once',async()=>{
 const {createDeploymentView}=require('../src/replication/view');
 const job={_id:'j',kind:'sourceDeployment',status:'submitted',rows:[],tasks:[{sourceId:'10',targets:[{orgUnitId:'20',deactivation:{status:'updated'}}],result:{status:'submitted',deploymentId:'123'}}]};
 let activations=0;const jobs={create:async()=>job,get:async()=>job,activate:async()=>{if(job.status!=='submitted')return false;activations++;job.status='queued';job.operation='activate';return true;}};
 const routes=createBulkDates({jobs,deploymentId:'d',secret:'secret',kind:'sourceDeployment',view:createDeploymentView({enabled:()=>true})});
 const pick=(html,action)=>html.match(new RegExp(`<form[^>]*action="/deploy/${action}"[^>]*>([\\s\\S]*?)</form>`))?.[1].match(/name="ticket" value="([^"]+)"/)[1];
 const res=response();await routes.preview({body:{ticket:pick(routes.form(res),'preview'),csv:'x'}},res);
 const body={jobId:'j',ticket:pick(res.body,'activate')};assert.ok(body.ticket);
 const wrong=response('other');await routes.activate({body:{...body,confirmCompleted:'yes'}},wrong);assert.equal(wrong.code,403);
 const yes=response();await routes.activate({body:{...body,confirmCompleted:'yes'}},yes);assert.equal(activations,1);assert.doesNotMatch(yes.body,/action="\/deploy\/cancel"/);
 const repeat=response();await routes.activate({body:{...body,confirmCompleted:'yes'}},repeat);assert.equal(repeat.code,409);
});

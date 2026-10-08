'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createHash,createHmac}=require('node:crypto');
const {installBulkStatusDiagnostics,markBulkStatusHandler,recordBulkStatusPhase,setBulkStatusSize}=require('../src/shared/bulkStatusDiagnostics');
const {createBulkDates}=require('../src/shared/routes');

test('status diagnostics bracket pre-LTI middleware through response completion without request data',()=>{
 let middleware,logs=[];
 const app={use:fn=>{middleware=fn;}};
 const originalLog=console.log;
 console.log=value=>logs.push(JSON.parse(value));
 try {
  installBulkStatusDiagnostics(app);
  const req={method:'POST',path:'/bulk/status',body:{jobId:'private-job',ticket:'private-ticket'}};
  const res=new EventEmitter();Object.assign(res,{statusCode:200,writableFinished:false});
  let passed=false;middleware(req,res,()=>{passed=true;});assert.equal(passed,true);
  markBulkStatusHandler(req);
  let started=process.hrtime.bigint();recordBulkStatusPhase(req,'authorization',started);
  started=process.hrtime.bigint();recordBulkStatusPhase(req,'get_status',started);
  setBulkStatusSize(req,{courseTotal:5000,totals:{total:20000}});
  started=process.hrtime.bigint();recordBulkStatusPhase(req,'render',started);
  res.writableFinished=true;res.emit('finish');
 } finally {console.log=originalLog;}
 assert.deepEqual(logs.map(log=>log.phase),['request_start','handler_entry','authorization_complete','get_status_complete','render_complete','request_complete']);
 assert.equal(logs[0].size,'unknown');assert.equal(logs.at(-1).size,'large');
 assert.ok(logs.at(-1).middleware_ms>=0);assert.ok(logs.at(-1).authorization_ms>=0);assert.ok(logs.at(-1).get_status_ms>=0);assert.ok(logs.at(-1).render_ms>=0);assert.ok(logs.at(-1).total_ms>=0);
 const serialized=JSON.stringify(logs);assert.doesNotMatch(serialized,/private-job|private-ticket/);assert.ok(logs.every(log=>log.trace===logs[0].trace));
});

test('status diagnostics ignore other routes and non-POST requests',()=>{
 let middleware;const app={use:fn=>{middleware=fn;}};installBulkStatusDiagnostics(app);
 let nextCalls=0;
 for(const req of [{method:'GET',path:'/bulk/status'},{method:'POST',path:'/bulk/history'}])middleware(req,{},()=>nextCalls++);
 assert.equal(nextCalls,2);
});

test('unfinished status responses emit an error marker with the last phase',()=>{
 let middleware,errors=[];const app={use:fn=>{middleware=fn;}};const originalError=console.error,originalLog=console.log;
 console.log=()=>{};
 console.error=value=>errors.push(JSON.parse(value));
 try {
  installBulkStatusDiagnostics(app);const res=new EventEmitter();res.writableFinished=false;
  middleware({method:'POST',path:'/bulk/status'},res,()=>{});res.emit('close');
 } finally {console.error=originalError;console.log=originalLog;}
 assert.equal(errors.length,1);assert.equal(errors[0].event,'bulk_status_timing');assert.equal(errors[0].phase,'response_closed');assert.equal(errors[0].stage,'before_lti');assert.ok(errors[0].total_ms>=0);
});

test('completed status route emits correlated authorization, metadata, render, and completion timings',async()=>{
 const secret='private-secret',now=1000,job={_id:'private-job',kind:'dates',status:'completed',courseTotal:5000,totals:{total:20000,updated:20000},dates:{start:'2027-01-01T00:00:00Z',due:'2027-01-02T00:00:00Z',end:'2027-01-03T00:00:00Z'}};
 const routes=createBulkDates({jobs:{getStatus:async()=>job,get:async()=>{throw Error('full job read is not expected');}},deploymentId:'d',secret,writeEnabled:()=>true,now:()=>now});
 const data=Buffer.from(JSON.stringify({kind:'dates',action:'status',id:job._id,session:createHash('sha256').update('private-session').digest('hex'),expires:now+1800000})).toString('base64url');
 const token=`${data}.${createHmac('sha256',secret).update(data).digest('hex')}`;
 let middleware,logs=[];const app={use:fn=>{middleware=fn;}};installBulkStatusDiagnostics(app);
 const originalLog=console.log;console.log=value=>logs.push(JSON.parse(value));
 try {
  const req={method:'POST',path:'/bulk/status',body:{jobId:job._id,ticket:token}};
  const res=new EventEmitter();Object.assign(res,{locals:{ltik:'private-session',token:{iss:'https://tenant.example',deploymentId:'d',user:'private-user'}},statusCode:200,writableFinished:false,set(){return this;},status(code){this.statusCode=code;return this;},send(body){this.body=body;return this;}});
  let pending;middleware(req,res,()=>{pending=routes.status(req,res);});await pending;res.writableFinished=true;res.emit('finish');
  assert.equal(res.statusCode,200);assert.match(res.body,/20000/);
 } finally {console.log=originalLog;}
 assert.deepEqual(logs.map(log=>log.phase),['request_start','handler_entry','authorization_start','authorization_complete','get_status_start','get_status_complete','render_start','render_complete','request_complete']);
 assert.equal(logs.find(log=>log.phase==='get_status_complete').size,'large');
 const serialized=JSON.stringify(logs);assert.doesNotMatch(serialized,/private-secret|private-session|private-user|private-job|ticket|activity/);
});

test('status storage errors log a safe phase without identifiers or error messages',async()=>{
 const secret='private-secret',now=1000;
 const routes=createBulkDates({jobs:{getStatus:async()=>{throw Error('private database detail');}},deploymentId:'d',secret,writeEnabled:()=>true,now:()=>now});
 const data=Buffer.from(JSON.stringify({kind:'dates',action:'status',id:'private-job',session:createHash('sha256').update('private-session').digest('hex'),expires:now+1800000})).toString('base64url');
 const token=`${data}.${createHmac('sha256',secret).update(data).digest('hex')}`;
 let middleware,logs=[];const app={use:fn=>{middleware=fn;}};installBulkStatusDiagnostics(app);
 const originalLog=console.log,originalError=console.error;console.log=value=>logs.push(JSON.parse(value));console.error=value=>logs.push(JSON.parse(value));
 try {
  const req={method:'POST',path:'/bulk/status',body:{jobId:'private-job',ticket:token}};
  const res=new EventEmitter();Object.assign(res,{locals:{ltik:'private-session',token:{iss:'https://tenant.example',deploymentId:'d',user:'private-user'}},statusCode:200,writableFinished:false,set(){return this;},status(code){this.statusCode=code;return this;},send(body){this.body=body;this.writableFinished=true;this.emit('finish');return this;}});
  let pending;middleware(req,res,()=>{pending=routes.status(req,res);});await pending;
  assert.equal(res.statusCode,503);
 } finally {console.log=originalLog;console.error=originalError;}
 const failure=logs.find(log=>log.event==='bulk_status_timing'&&log.phase==='request_error');
 assert.equal(failure.stage,'getStatus');assert.equal(failure.error,'Error');
 assert.doesNotMatch(JSON.stringify(logs),/private-secret|private-session|private-user|private-job|private database detail/);
});

'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {step2,step3,check:copyProgressCheck}=require('../src/copy/progress');
const {createCopyView}=require('../src/copy/view');

test('Step 2 shows mappings percentage and waits for measured ETA samples',()=>{
 const job={status:'planning',progress:{phase:'mappings',processed:50,total:100},copyStep2StartedAt:1000,copyStep2ProgressAt:11000,copyStep2SampleCount:2,copyStep2RatePerMs:.005};
 let view=step2(job,11000);assert.equal(view.percent,50);assert.equal(view.processed,50);assert.equal(view.estimate,'Calculating ETA…');
 job.copyStep2SampleCount=3;view=step2(job,17000);assert.match(view.estimate,/^ETA: /);assert.ok(!/NaN|Infinity/.test(view.estimate));
});

test('Step 2 completion and interruption show final or paused timing without an ETA',()=>{
 const job={status:'ready',progress:{phase:'mappings',processed:100,total:100},copyStep2ElapsedMs:42000};
 let view=step2(job,50000);assert.equal(view.percent,100);assert.equal(view.complete,true);assert.equal(view.estimate,'');assert.equal(view.elapsed,'42s');
 job.status='interrupted';job.copyStep2StartedAt=1000;job.copyStep2ProgressAt=21000;job.copyStep2ElapsedMs=5000;
 view=step2(job,90000);assert.equal(view.estimate,'Progress paused — ETA unavailable');assert.equal(view.elapsed,'25s');
});

test('Step 2 panel renders the validation percentage and row result counters',()=>{
 const job={_id:'v',status:'validating',progress:{phase:'mappings',processed:2,total:4},rows:[{status:'valid'},{status:'invalid'},{status:'duplicate'},{status:'pending'}],tasks:[],components:null};
 const html=createCopyView().render({},job,{controls:()=>'',button:()=>'',now:()=>1000});
 assert.match(html,/Mapping Validation Progress/);assert.match(html,/>50%<\/strong>/);assert.match(html,/1<\/strong><span>Valid<\/span>/);assert.match(html,/1<\/strong><span>Invalid<\/span>/);assert.match(html,/1<\/strong><span>Duplicates<\/span>/);assert.match(html,/1<\/strong><span>Pending<\/span>/);assert.match(html,/This page refreshes automatically/);assert.doesNotMatch(html,/<div class="processing"/);
});

test('Step 3 counts accepted PENDING and PROCESSING tokens as processed submissions',()=>{
 const job={status:'running',tasks:[{result:{status:'PENDING',jobToken:'a'}},{result:{status:'PROCESSING',jobToken:'b'}},{result:{status:'failed'}},{result:{status:'uncertain'}},{result:{status:'notAttempted'}}],copyStep3StartedAt:1000,copyStep3ProgressAt:20000};
 const view=step3(job,22000);assert.equal(view.processed,4);assert.equal(view.total,5);assert.equal(view.percent,80);assert.equal(view.submitted,2);assert.equal(view.failed,1);assert.equal(view.uncertain,1);assert.equal(view.notAttempted,1);assert.equal(view.throughput,'11.4');
});

test('Step 3 keeps a durable pre-POST intent out of processed submissions until response or interruption',()=>{
 const intent={status:'uncertain',submissionIntent:true,message:'Submission outcome unconfirmed. Inspect Brightspace before creating another copy.'};
 const job={status:'running',tasks:[{result:intent},{result:{status:'PENDING',jobToken:'accepted'}}]};
 let view=step3(job,1000);assert.equal(view.processed,1);assert.equal(view.inFlight,1);assert.equal(view.uncertain,0);
 job.status='interrupted';view=step3(job,90000);assert.equal(view.processed,2);assert.equal(view.inFlight,0);assert.equal(view.uncertain,1);assert.equal(view.estimate,'Progress paused — ETA unavailable');
});

test('Step 3 ETA uses submission throughput, completes without ETA, and excludes paused downtime',()=>{
 const tasks=Array.from({length:100},(_,i)=>({result:i<25?{status:'PENDING',jobToken:`t${i}`}:{status:'pending'}}));
 const job={status:'running',tasks,copyStep3StartedAt:1000,copyStep3ElapsedMs:15000,copyStep3ProgressAt:16000};
 const view=step3(job,16000);assert.match(view.estimate,/^ETA: /);assert.equal(view.processed,25);assert.ok(!/NaN|Infinity/.test(view.estimate));
 job.status='interrupted';job.copyStep3StartedAt=null;job.copyStep3ElapsedMs=30000;
 const paused=step3(job,3600000);assert.equal(paused.estimate,'Progress paused — ETA unavailable');assert.equal(paused.elapsed,'30s');
 job.status='copiesInProcess';const finished=step3(job,3600000);assert.equal(finished.estimate,'');assert.equal(finished.terminal,true);
});

test('Step 2 and Step 3 timing remain independent and status copy never claims submission means completion',()=>{
 const job={_id:'j',kind:'courseCopy',status:'running',confirmedAt:100,tasks:[{originId:'1',destinationId:'2',result:{status:'PENDING',jobToken:'tok'}}],rows:[],components:null,copyStep2ElapsedMs:90000,copyStep3StartedAt:100000,copyStep3ElapsedMs:5000};
 assert.equal(step2({...job,progress:{phase:'mappings',processed:2,total:2}},110000).elapsed,'1m 30s');
 assert.equal(step3(job,110000).elapsed,'15s');
 const html=createCopyView().render({},job,{controls:()=>'',button:()=>'',now:()=>110000});
 assert.match(html,/Course Copy Progress/);assert.match(html,/Submitted copies may still be processing in Brightspace/);assert.match(html,/Estimated submission time remaining/);assert.doesNotMatch(html,/All 1 destinations were copied successfully/);
 assert.ok(html.indexOf('deployment-metrics')<html.indexOf('Components to Copy'));assert.ok(html.indexOf('Components to Copy')<html.indexOf('Course Copy Progress'));assert.match(html,/copy-submission-progress/);
});

test('copy check ETA uses checked tokens and its own active elapsed time',()=>{
 const job={status:'running',operation:'check',tasks:[],copyCheckProgress:{processed:20,total:40,completed:8,stillProcessing:10,needsReview:2},copyCheckStartedAt:1000,copyCheckProgressAt:16000};
 let view=copyProgressCheck(job,16000);assert.equal(view.percent,50);assert.equal(view.completed,8);assert.equal(view.stillProcessing,10);assert.equal(view.needsReview,2);assert.equal(view.notChecked,20);assert.equal(view.elapsed,'15s');assert.match(view.estimate,/^ETA: /);assert.equal(view.throughput,'80.0');
 job.status='copiesInProcess';view=copyProgressCheck(job,90000);assert.equal(view.estimate,'');assert.equal(view.terminal,true);
 job.status='interrupted';job.copyCheckStartedAt=null;job.copyCheckElapsedMs=12000;view=copyProgressCheck(job,90000);assert.equal(view.estimate,'Progress paused — ETA unavailable');assert.equal(view.elapsed,'12s');
});

test('manual check page keeps Course Copy Progress and renders a separate check panel below components',()=>{
 const job={_id:'check',kind:'courseCopy',status:'running',operation:'check',confirmedAt:1,components:['Content'],rows:[],tasks:[{originId:'1',destinationId:'2',result:{status:'PROCESSING',jobToken:'t'}}],copyStep3ElapsedMs:20000,copyStep3ProgressAt:20000,copyCheckProgress:{processed:3,total:5,completed:1,stillProcessing:2,needsReview:0},copyCheckStartedAt:25000,copyCheckProgressAt:30000};
 const html=createCopyView().render({},job,{controls:()=>'',button:()=>'',now:()=>31000});
 assert.match(html,/Course Copy Progress/);assert.match(html,/Copy Check Progress/);assert.match(html,/copy results checked/);assert.match(html,/Estimated copy check time remaining/);assert.ok(html.indexOf('Components to Copy')<html.indexOf('Course Copy Progress'));assert.ok(html.indexOf('Course Copy Progress')<html.indexOf('Copy Check Progress'));
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createStep2Utilization,withStep2Utilization}=require('../src/shared/step2Utilization');
const {createStep3Utilization,withStep3Utilization}=require('../src/shared/step3Utilization');
const {createRateLimitedHttp}=require('../src/shared/rateLimit');
const {buildReport,findJob}=require('../scripts/date-step2-utilization-report');

test('Step 2 attribution is isolated from Step 3 and excludes non-discovery API calls',async()=>{
 let time=0;const request=createRateLimitedHttp({baseUrl:'https://tenant.example',monotonicNow:()=>time,gate:{reserve:async()=>({token:'permit',localReservationQueueMs:2,mongoReservationMs:3}),complete:async()=>{}},http:async()=>{time+=5;return {status:200,headers:{}};}});
 const step2=createStep2Utilization({monotonicNow:()=>time});
 await withStep2Utilization(step2,()=>request({method:'GET',url:'https://tenant.example/d2l/api/le/1.0/123/quizzes/'}));const two=step2.finish(),step3=createStep3Utilization({monotonicNow:()=>time});
 await withStepStep3(step3,()=>request({method:'GET',url:'https://tenant.example/d2l/api/le/1.0/123/quizzes/4'}));
 const three=step3.finish();assert.equal(two.httpMs.reduce((a,b)=>a+b,0),5);assert.equal(two.permitMs.reduce((a,b)=>a+b,0),5);assert.equal(two.mongoReservationMs,3);assert.equal(three.httpMs.reduce((a,b)=>a+b,0),5);assert.equal(two.httpMs[1],5);assert.equal(three.httpMs[1],5);
});
function withStepStep3(tracker,fn){return withStep3Utilization(tracker,fn);}

test('Step 2 concurrency and elapsed distributions account for overlapping requests and workers',()=>{
 let time=0;const tracker=createStep2Utilization({monotonicNow:()=>time});tracker.setPending(2);tracker.courseStarted();tracker.changeHttp(1);time=10;tracker.courseStarted();tracker.changeHttp(1);time=20;tracker.changeHttp(-1);tracker.courseFinished();time=30;tracker.changeHttp(-1);tracker.courseFinished();const saved=tracker.finish();
 assert.equal(saved.coveredMs,30);assert.deepEqual(saved.httpMs,[0,20,10,0,0,0,0,0,0]);assert.deepEqual(saved.workerMs,[0,20,10,0,0,0,0,0,0]);assert.equal(saved.pendingNoHttpMs,0);assert.equal(saved.discoveryDurationMs,30);
});

test('checkpoint wait union is counted once and pending work without HTTP is visible',()=>{
 let time=0;const tracker=createStep2Utilization({monotonicNow:()=>time});tracker.setPending(1);tracker.courseStarted();tracker.checkpointWait(1);time=10;tracker.checkpointWait(1);time=20;tracker.checkpointWait(-1);time=30;tracker.checkpointWait(-1);time=35;const saved=tracker.finish();assert.equal(saved.checkpointWaitMs,30);assert.equal(saved.pendingNoHttpMs,35);
});

test('overlapping gate waits expose wall-clock pacing separately from summed waits',()=>{
 let time=0;const tracker=createStep2Utilization({monotonicNow:()=>time});tracker.changeWait('pacingBudget',1);time=10;tracker.changeWait('mixed',1);time=20;tracker.changeWait('pacingBudget',-1);time=30;tracker.changeWait('mixed',-1);const saved=tracker.finish();assert.equal(saved.gateWaitUnionMs,30);assert.equal(saved.pacingWaitUnionMs,30);assert.equal(saved.permitContentionUnionMs,20);
});

test('discovery measurements exclude resolution and recovery downtime',()=>{
 let time=0;const first=createStep2Utilization({monotonicNow:()=>time});time=25;const saved=first.snapshot();time=500;const resumed=createStep2Utilization({monotonicNow:()=>time,prior:saved});time=540;const result=resumed.finish();assert.equal(result.discoveryDurationMs,65);assert.equal(result.coveredMs,65);assert.equal(result.httpMs[0],65);
 const report=buildReport({_id:'resumed',status:'ready',resuming:true,performance:{dateStep2Utilization:result}});assert.equal(report.complete,false);assert.equal(report.recovered,true);assert.equal(report.discoveryDurationMs,65);
});

test('report labels missing coverage and finds metadata only',async()=>{
 assert.equal(buildReport({_id:'old',status:'ready'}).available,false);
 const report=buildReport({_id:'partial',status:'running',performance:{dateStep2Utilization:{version:1,coveredMs:50,discoveryDurationMs:100,httpMs:[10,40,0,0,0,0,0,0,0],permitMs:[50,0,0,0,0,0,0,0,0],workerMs:[0,50,0,0,0,0,0,0,0]}}});assert.equal(report.complete,false);assert.equal(report.coverageMs,50);assert.equal(report.http.average,.8);
 let call;const collection={findOne:async(...args)=>{call=args;return {_id:'j'};}};await findJob(collection,'tenant');assert.deepEqual(call[0],{namespace:'tenant',kind:'dates','performance.dateStep2Utilization.version':1});assert.deepEqual(call[1].projection,{_id:1,kind:1,status:1,totals:1,performance:1,resuming:1});
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createStep3Utilization,withStep3Utilization}=require('../src/shared/step3Utilization');
const {createRateLimitedHttp}=require('../src/shared/rateLimit');
const {buildReport,findJob}=require('../scripts/date-step3-utilization-report');

test('concurrency time is accumulated by event changes without overlap double-counting',()=>{
 let time=0;const tracker=createStep3Utilization({monotonicNow:()=>time});
 tracker.changeHttp(1);time=10;tracker.snapshot();tracker.changePermit(1);time=15;tracker.changeHttp(1);time=20;tracker.changeHttp(-1);time=30;tracker.changePermit(-1);tracker.changeHttp(-1);time=35;
 const saved=tracker.finish();assert.equal(saved.coveredMs,35);assert.deepEqual(saved.httpMs,[5,25,5,0,0]);assert.deepEqual(saved.permitMs,[15,20,0,0,0]);
});

test('overlapping checkpoint waits count their wall-clock union once',()=>{
 let time=0;const tracker=createStep3Utilization({monotonicNow:()=>time});tracker.checkpointWait(1);time=10;tracker.checkpointWait(1);time=20;tracker.checkpointWait(-1);time=30;tracker.checkpointWait(-1);
 assert.equal(tracker.snapshot().checkpointWaitMs,30);
});

test('transport separates HTTP execution from permit occupancy and cleans up after exceptions',async()=>{
 let time=0,completions=0,active=false;
 const request=createRateLimitedHttp({baseUrl:'https://tenant.example',monotonicNow:()=>time,gate:{reserve:async()=>({token:'permit'}),complete:async()=>{completions++;time+=3;}},http:async()=>{active=true;time+=7;active=false;throw Error('request failed');}});
 const tracker=createStep3Utilization({monotonicNow:()=>time});
 await assert.rejects(()=>withStep3Utilization(tracker,()=>request({method:'GET',url:'https://tenant.example/d2l/api/le/1.0/123/quizzes/4'})),/request failed/);
 const saved=tracker.finish();assert.equal(completions,1);assert.equal(active,false);assert.equal(saved.httpMs[1],7);assert.equal(saved.permitMs[1],10);assert.equal(saved.httpMs[0],3);assert.equal(saved.permitMs[0],0);
});

test('elevated, unrelated-context, and unattributed requests are excluded',async()=>{
 let time=0;const request=createRateLimitedHttp({baseUrl:'https://tenant.example',monotonicNow:()=>time,gate:{reserve:async()=>({token:'permit'}),complete:async()=>{}},http:async config=>{time+=5;return {status:200,headers:{}};}});
 const tracker=createStep3Utilization({monotonicNow:()=>time});
 await withStep3Utilization(tracker,async()=>{await request({method:'GET',url:'https://tenant.example/d2l/api/le/1.0/123/quizzes/4'});await request({method:'GET',url:'https://tenant.example/d2l/api/lp/1.0/orgstructure/?exactOrgUnitCode=X'});});
 await request({method:'GET',url:'https://tenant.example/d2l/api/le/1.0/123/quizzes/5'});
 const saved=tracker.finish();assert.equal(saved.httpMs.reduce((a,b)=>a+b,0),15);assert.equal(saved.httpMs[1],5);assert.equal(saved.permitMs[1],5);assert.equal(saved.httpMs[0],10);
});

test('report calculations distinguish unavailable and interrupted measurements',()=>{
 assert.equal(buildReport({_id:'old',status:'completed'}).available,false);
 const report=buildReport({_id:'partial',status:'queued',step3ElapsedMs:100,totals:{total:8},performance:{dateStep3Utilization:{version:1,coveredMs:50,httpMs:[0,50,0,0,0],permitMs:[20,30,0,0,0]}}});
 assert.equal(report.complete,false);assert.equal(report.activityCount,8);assert.equal(report.http.rows[1].percent,100);assert.equal(report.http.average,1);
 const complete=buildReport({_id:'done',status:'completed',step3ElapsedMs:100,performance:{dateStep3Utilization:{version:1,coveredMs:100,httpMs:[50,50,0,0,0],permitMs:[100,0,0,0,0]}}});assert.equal(complete.complete,true);
});

test('report lookup reads only compact job metadata',async()=>{
 let call;const collection={findOne:async(...args)=>{call=args;return {_id:'j'};}};
 const result=await findJob(collection,'namespace');assert.equal(result._id,'j');assert.deepEqual(call[0],{namespace:'namespace',kind:'dates','performance.dateStep3Utilization.version':1});
 assert.deepEqual(call[1].projection,{_id:1,kind:1,status:1,totals:1,step3ElapsedMs:1,performance:1});assert.deepEqual(call[1].sort,{createdAt:-1});
 await findJob(collection,'namespace','chosen');assert.equal(call[0]._id,'chosen');
});

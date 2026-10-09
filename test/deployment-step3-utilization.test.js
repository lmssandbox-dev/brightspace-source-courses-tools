'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createCheckpointQueue}=require('../src/shared/checkpointQueue');
const {createConcurrentHttp}=require('../src/shared/concurrentGate');
const {createDeploymentStep3Utilization,getBuildSha}=require('../src/replication/step3Utilization');
const {withStep3Utilization}=require('../src/shared/step3Utilization');
const {formatDeploymentStep3Report}=require('../src/replication/step3UtilizationReport');

test('deployment utilization time-weights HTTP and source-group concurrency',()=>{
 let time=0;const tracker=createDeploymentStep3Utilization({monotonicNow:()=>time});
 time=10;tracker.changeHttp(1);tracker.changeSourceGroupWorkers(1);
 time=20;tracker.changeHttp(1);tracker.changeSourceGroupWorkers(1);
 time=30;tracker.changeHttp(-1);tracker.changeSourceGroupWorkers(-1);
 time=40;tracker.changeHttp(-1);tracker.changeSourceGroupWorkers(-1);
 const result=tracker.finish('complete',40);
 assert.deepEqual(result.httpMs.slice(0,3),[10,20,10]);
 assert.deepEqual(result.sourceGroupWorkerMs.slice(0,3),[10,20,10]);
 assert.equal(result.coveredMs,40);
 assert.equal(result.coverage,'complete');
});

test('checkpoint queue records coalesced batch sizes and overlapping wait coverage',async()=>{
 let physical=0;const tracker=createDeploymentStep3Utilization();
 const checkpoint=createCheckpointQueue(async()=>{physical++;await new Promise(resolve=>setTimeout(resolve,15));},{delayMs:5});
 const job={};
 await withStep3Utilization(tracker,()=>Promise.all([checkpoint(job,{}),checkpoint(job,{}),checkpoint(job,{}),checkpoint(job,{})]));
 const result=tracker.snapshot('running',1);
 assert.equal(physical,1);
 assert.equal(result.physicalCheckpoints,1);
 assert.equal(result.checkpointBatchSizes['4'],1);
 assert.ok(result.checkpointQueueWaitMs>0);
 assert.ok(result.checkpointQueueWaitUnionMs>0);
 assert.ok(result.checkpointQueueWaitUnionMs<=result.checkpointQueueWaitMs);
 assert.ok(result.checkpointCallerWaitMs>result.checkpointCallerWaitUnionMs);
 assert.ok(result.checkpointCallerWaitUnionMs>0);
 assert.ok(result.checkpointPreFlushWaitMs>result.checkpointPreFlushWaitUnionMs);
 assert.ok(result.checkpointPostFlushWaitMs>result.checkpointPostFlushWaitUnionMs);
 assert.ok(result.checkpointCallerWaitMs>=result.checkpointPreFlushWaitMs);
 assert.ok(result.checkpointCallerWaitMs>=result.checkpointPostFlushWaitMs);
 assert.ok(Math.abs(result.checkpointCallerWaitMs-result.checkpointPreFlushWaitMs-result.checkpointPostFlushWaitMs)<10);
});

test('rejected checkpoints include caller wait through rejection',async()=>{
 const tracker=createDeploymentStep3Utilization(),checkpoint=createCheckpointQueue(async()=>{await new Promise(resolve=>setTimeout(resolve,10));throw Error('save failed');},{delayMs:0}),job={};
 const results=await withStep3Utilization(tracker,()=>Promise.allSettled([checkpoint(job,{}),checkpoint(job,{})]));
 assert.ok(results.every(result=>result.status==='rejected'));
 const measurement=tracker.snapshot('interrupted',10);
 assert.ok(measurement.checkpointCallerWaitMs>0);
 assert.ok(measurement.checkpointPreFlushWaitMs>0);
 assert.ok(measurement.checkpointPostFlushWaitMs>0);
 assert.equal(measurement.coverage,'interrupted');
});

test('operation timings include awaited work and interrupted coverage is explicit',async()=>{
 let time=0;const tracker=createDeploymentStep3Utilization({monotonicNow:()=>time});
 await tracker.operation('deactivation',async()=>{time+=12;});
 const interrupted=tracker.finish('interrupted',12);
 assert.deepEqual(interrupted.operations.deactivation,{calls:1,elapsedMs:12});
 assert.equal(interrupted.coverage,'interrupted');
});

test('shared transport attributes deployment gate timings to Step 3',async()=>{
 const tracker=createDeploymentStep3Utilization();
 const gate={reserve:async()=>({token:'permit',localReservationQueueMs:3,mongoReservationMs:5}),complete:async()=>{}};
 const request=createConcurrentHttp({baseUrl:'https://tenant.example',gate,http:async()=>({status:200,data:{}}),seconds:()=>0});
 await withStep3Utilization(tracker,()=>request({method:'GET',url:'https://tenant.example/d2l/api/lp/1.53/courses/20'}));
 const result=tracker.snapshot('complete',1);
 assert.equal(result.gateWaitMs.localReservationQueueMs,3);assert.equal(result.gateWaitMs.mongoReservationMs,5);
});

test('report supports historical jobs and unverified build SHA as unknown',()=>{
 assert.match(formatDeploymentStep3Report({_id:'old-job'}),/Build SHA: unknown/);
 assert.match(formatDeploymentStep3Report({_id:'old-job'}),/measurements: unknown/);
 assert.match(formatDeploymentStep3Report({_id:'partial',performance:{deploymentStep3Utilization:{version:1,coverage:'running'}}}),/Coverage: incomplete/);
 assert.match(formatDeploymentStep3Report({_id:'partial',performance:{deploymentStep3Utilization:{version:1,coverage:'running'}}}),/Caller wait .* unknown summed across requests; unknown union wall time/);
 assert.equal(getBuildSha('not-a-commit'),'unknown');
 assert.equal(getBuildSha('0123456789abcdef0123456789abcdef01234567'),'0123456789abcdef0123456789abcdef01234567');
});

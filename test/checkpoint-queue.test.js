'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createCheckpointQueue}=require('../src/shared/checkpointQueue');
const turn=()=>new Promise(r=>setTimeout(r,5));
test('four concurrent intents share one save and cannot submit before it finishes',async()=>{
 let release,saves=0,submitted=0;const job={kind:'courseCopy'};
 const queue=createCheckpointQueue(async(_job,dirty)=>{saves++;assert.deepEqual(dirty,{tasks:[0,1,2,3]});await new Promise(r=>{release=r;});},{delayMs:0});
 const work=Array.from({length:4},(_,i)=>queue(job,{tasks:[i]}).then(()=>{submitted++;}));
 await turn();assert.equal(saves,1);assert.equal(submitted,0);release();await Promise.all(work);assert.equal(submitted,4);
});
test('writes arriving during persistence wait for a later batch; final full save supersedes patches',async()=>{
 let release;const calls=[],job={};const queue=createCheckpointQueue(async(_j,dirty)=>{calls.push(dirty);if(calls.length===1)await new Promise(r=>{release=r;});},{delayMs:0});
 const a=queue(job,{tasks:[0]});await turn();let finished=false;const b=queue(job,{tasks:[1]}).then(()=>{finished=true;}),c=queue(job);
 assert.equal(finished,false);release();await Promise.all([a,b,c]);assert.equal(calls.length,2);assert.equal(calls[1],undefined);
});
test('failed persistence rejects active and queued waiters and prevents later writes',async()=>{
 let fail,calls=0;const job={};const queue=createCheckpointQueue(async()=>{calls++;await new Promise((_r,reject)=>{fail=reject;});},{delayMs:0});
 const a=queue(job,{tasks:[0]});const caughtA=assert.rejects(a,/database/);await turn();const b=queue(job,{tasks:[1]}),caughtB=assert.rejects(b,/database/);
 fail(Error('database'));await Promise.all([caughtA,caughtB]);await assert.rejects(queue(job,{tasks:[2]}),/database/);assert.equal(calls,1);
});
test('separate workflow queues keep independent 10 ms and 25 ms collection windows',async()=>{
 const original=global.setTimeout,delays=[];global.setTimeout=(callback,delay,...args)=>{delays.push(delay);return original(callback,0,...args);};
 try{
  const fast=createCheckpointQueue(async()=>{},{delayMs:10}),step3=createCheckpointQueue(async()=>{},{delayMs:25});
  await Promise.all([fast({}),step3({})]);assert.deepEqual(delays,[10,25]);
 }finally{global.setTimeout=original;}
});

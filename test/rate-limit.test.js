'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createRateLimitedHttp}=require('../src/shared/rateLimit');
function setup(http){let time=0,next=0;const samples=[],waits=[];return {samples,waits,request:createRateLimitedHttp({http,baseUrl:'https://tenant.example',now:()=>time,delay:async ms=>{waits.push(ms);time+=ms;},gate:{acquire:async()=>Math.max(0,next-time),release:async(n,s)=>{next=n;samples.push(s);}}})};}
const config={method:'POST',url:'https://tenant.example/d2l/api/lp/1.53/sourceCourses/123/deploy'};
test('actual costs are recorded and expensive calls are paced',async()=>{const s=setup(async()=>({status:200,headers:{'x-request-cost':'100','x-rate-limit-remaining':'40000'}}));await s.request(config);await s.request(config);assert.equal(s.waits[0],200);assert.equal(s.samples[0].cost,100);assert.match(s.samples[0].route,/sourceCourses\/:id\/deploy/);});
test('429 waits for reset then retries, low credits pause all following requests',async()=>{let calls=0;const s=setup(async()=>{if(++calls===1)throw {response:{status:429,headers:{'retry-after':'75'}}};return {status:200,headers:{'x-rate-limit-remaining':'100','x-rate-limit-reset':'60'}};});await s.request(config);assert.ok(s.waits.reduce((a,b)=>a+b,0)>=76000);await s.request(config);assert.ok(s.waits.reduce((a,b)=>a+b,0)>=137000);});
test('ambiguous POST failures are never replayed and missing costs are unknown',async()=>{let calls=0;const s=setup(async()=>{calls++;throw Error('timeout');});await assert.rejects(s.request(config));assert.equal(calls,1);assert.equal(s.samples[0].cost,null);});
test('50,000 updates and 5,000 submissions are serialized and bounded with no burst',async()=>{let active=0,max=0;const s=setup(async()=>{max=Math.max(max,++active);await Promise.resolve();active--;return {status:200,headers:{'x-request-cost':'10'}};});await Promise.all(Array.from({length:55000},()=>s.request(config)));assert.equal(max,1);assert.equal(s.samples.length,55000);assert.equal(s.waits.reduce((a,b)=>a+b,0),54999*20);});

test('missing cost headers retain conservative pacing',async()=>{const s=setup(async()=>({status:200,headers:{}}));await s.request(config);await s.request(config);assert.equal(s.waits[0],250);});
test('remaining budget slows calls before the reserve is reached',async()=>{const s=setup(async()=>({status:200,headers:{'x-request-cost':'10','x-rate-limit-remaining':'11000','x-rate-limit-reset':'60'}}));await s.request(config);await s.request(config);assert.equal(s.waits[0],600);});
test('network time counts toward spacing instead of adding unnecessary delay',async()=>{
 let now=0,next=0;const waits=[];
 const request=createRateLimitedHttp({baseUrl:'https://tenant.example',now:()=>now,delay:async ms=>{waits.push(ms);now+=ms;},gate:{acquire:async()=>Math.max(0,next-now),release:async n=>{next=n;}},http:async()=>{now+=100;return {status:200,headers:{'x-request-cost':'10'}};}});
 await request(config);await request(config);assert.deepEqual(waits,[]);
});

test('copy status cost metrics aggregate tokens without persisting token identifiers',async()=>{
 const s=setup(async()=>({status:200,headers:{'x-request-cost':'10'}}));await s.request({method:'GET',url:'https://tenant.example/d2l/api/le/1.99/import/123/copy/private-token'});assert.equal(s.samples[0].route,'GET /d2l/api/le/1.99/import/:id/copy/:token');
});

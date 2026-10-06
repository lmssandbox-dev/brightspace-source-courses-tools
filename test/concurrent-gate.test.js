'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {createConcurrentGate}=require('../src/shared/concurrentGate');
const {createRateLimitedHttp}=require('../src/shared/rateLimit');
const hash=s=>createHash('sha256').update(s).digest('hex');
// Small expression model for the operators used by the atomic Mongo reservation.
// This exercises the actual generated filter/pipeline, not a replacement gate algorithm.
function mongoModel(){
 let doc;const get=(o,path)=>path.split('.').reduce((v,k)=>v?.[k],o);
 const put=(o,path,value)=>{const keys=path.split('.'),last=keys.pop();for(const key of keys)o=o[key]||=( {} );o[last]=value;};
 function evalExpr(v,vars={}){
  if(typeof v==='string'&&v.startsWith('$$'))return get(vars,v.slice(2));
  if(typeof v==='string'&&v.startsWith('$'))return get(doc,v.slice(1));
  if(Array.isArray(v))return v.map(x=>evalExpr(x,vars));
  if(!v||typeof v!=='object')return v;
  const [op,arg]=Object.entries(v)[0];
  if(op==='$filter')return evalExpr(arg.input,vars).filter(item=>evalExpr(arg.cond,{...vars,[arg.as]:item}));
  const a=evalExpr(arg,vars);
  switch(op){
   case '$ifNull':return a[0]??a[1];case '$max':return Math.max(...a);case '$add':return a.reduce((x,y)=>x+y,0);case '$multiply':return a.reduce((x,y)=>x*y,1);
   case '$cond':return a[0]?a[1]:a[2];case '$lte':return a[0]<=a[1];case '$lt':return a[0]<a[1];case '$gt':return a[0]>a[1];case '$and':return a.every(Boolean);case '$size':return a.length;case '$concatArrays':return a.flat();
   default:return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,evalExpr(x,vars)]));
  }
 }
 const collection={
  async updateOne(filter,update){
   if(!doc&&update.$setOnInsert)doc={_id:filter._id,...structuredClone(update.$setOnInsert)};
   if(!doc||filter['permits.token']&&!doc.permits.some(p=>p.token===filter['permits.token']))return {matchedCount:0};
   for(const [k,v] of Object.entries(update.$set||{}))put(doc,k,v);
   for(const [k,v] of Object.entries(update.$inc||{}))put(doc,k,(get(doc,k)||0)+v);
   for(const [k,v] of Object.entries(update.$max||{}))put(doc,k,Math.max(get(doc,k)??-Infinity,v));
   for(const [k,v] of Object.entries(update.$min||{}))put(doc,k,Math.min(get(doc,k)??Infinity,v));
   if(update.$pull)doc.permits=doc.permits.filter(p=>p.token!==update.$pull.permits.token);
   return {matchedCount:1};
  },
  async findOneAndUpdate(filter,pipeline){
   if(!doc||doc.nextAt>filter.nextAt.$lte||!evalExpr(filter.$expr))return {value:null};
   Object.assign(doc,evalExpr(pipeline[0].$set));return {value:structuredClone(doc)};
  },async findOne(){return structuredClone(doc);}
 };
 return {client:{connect:async()=>{},db:()=>({collection:()=>collection}),close:async()=>{}},get doc(){return doc;}};
}
const route='POST /d2l/api/lp/1.63/sourceCourses/:id/deploy';
const sample={route,status:200,cost:10,remaining:49000,latencyMs:100,gateWaitMs:20,resetMs:60000};
test('atomic reservations share four permits across gate instances and release records timing',async()=>{
 let now=0;const m=mongoModel(),create=()=>createConcurrentGate({uri:'mongodb://unused/app',key:'k',now:()=>now,mongoClient:m.client});const a=create(),b=create(),permits=[];
 for(let i=0;i<4;i++){const permit=await (i%2?a:b).reserve(route);assert.ok(permit.token);permits.push(permit);now+=250;}
 assert.ok((await b.reserve(route)).wait>0);await a.complete(permits[0],sample);assert.ok((await b.reserve(route)).token);
 const metrics=m.doc.costs[hash(route)];assert.equal(metrics.requests,1);assert.equal(metrics.timedRequests,1);assert.equal(metrics.totalLatencyMs,100);assert.equal(metrics.totalGateWaitMs,20);
 now=50000;assert.ok((await a.reserve(route)).token);await assert.rejects(()=>a.complete(permits[1],sample),/permit lost/);
});
test('reserved credit budget blocks starts until its window resets',async()=>{
 let now=0;const m=mongoModel(),gate=createConcurrentGate({key:'k',now:()=>now,mongoClient:m.client});const initial=await gate.reserve(route);await gate.complete(initial,sample);
 m.doc.budgetUsed=29990;m.doc.nextAt=0;
 const last=await gate.reserve(route);assert.ok(last.token);assert.equal(m.doc.budgetUsed,30000);await gate.complete(last,sample);now=20;
 assert.ok((await gate.reserve(route)).wait);now=60000;assert.ok((await gate.reserve(route)).token);assert.equal(m.doc.budgetUsed,10);
});
test('429 pause is durable and cannot be shortened by an older successful response',async()=>{
 let now=0;const m=mongoModel(),gate=createConcurrentGate({key:'k',now:()=>now,mongoClient:m.client});const a=await gate.reserve(route);now=250;const b=await gate.reserve(route);
 await gate.complete(a,{...sample,status:429,pauseMs:75000});await gate.complete(b,sample);now=75000;assert.ok((await gate.reserve(route)).wait);now=76250;assert.ok((await gate.reserve(route)).token);
});
test('missing headers use conservative reservation without falsifying measured maximum cost',async()=>{
 let now=0;const m=mongoModel(),gate=createConcurrentGate({key:'k',now:()=>now,mongoClient:m.client});let p=await gate.reserve(route);assert.equal(p.reservedCost,125);await gate.complete(p,sample);now=250;p=await gate.reserve(route);assert.equal(p.reservedCost,10);await gate.complete(p,{...sample,cost:null});now=500;p=await gate.reserve(route);assert.equal(p.reservedCost,125);assert.equal(m.doc.costs[hash(route)].maxCost,10);
});
test('a newly observed cost above the local budget fails closed rather than waiting forever',async()=>{
 let now=0;const m=mongoModel(),gate=createConcurrentGate({key:'k',now:()=>now,mongoClient:m.client});const p=await gate.reserve(route);await gate.complete(p,{...sample,cost:40000});now=100000;await assert.rejects(()=>gate.reserve(route),/exceeds/);
});
const config={method:'POST',url:'https://tenant.example/d2l/api/le/1.99/import/123/copy/'};
test('production transport allows four overlapping requests and drains 5,000 submissions',async()=>{
 let active=0,max=0,count=0;const samples=[];
 const request=createRateLimitedHttp({baseUrl:'https://tenant.example',gate:{reserve:async()=>({token:'t',reservedCost:10}),complete:async(_p,s)=>samples.push(s)},http:async()=>{max=Math.max(max,++active);await new Promise(r=>setImmediate(r));active--;count++;return {status:202,headers:{'x-request-cost':'10'}};}});
 await Promise.all(Array.from({length:5000},()=>request(config)));assert.equal(max,4);assert.equal(active,0);assert.equal(count,5000);assert.equal(samples.length,5000);
});
test('production transport never repeats ambiguous writes and poisons scheduling on lost persistence',async()=>{
 for(const fail of ['timeout','reserve','complete']){
  let calls=0;const request=createRateLimitedHttp({baseUrl:'https://tenant.example',gate:{reserve:async()=>{if(fail==='reserve')throw Error('db');return {token:'t',reservedCost:10};},complete:async()=>{if(fail==='complete')throw Error('db');}},http:async()=>{calls++;if(fail==='timeout')throw Error('timeout');return {status:202,headers:{}};}});
  await assert.rejects(()=>request(config));assert.equal(calls,fail==='reserve'?0:1);
  if(fail!=='timeout'){await assert.rejects(()=>request(config));assert.equal(calls,fail==='reserve'?0:1);}
 }
});
test('production transport respects global reset waits before retrying an explicit 429',async()=>{
 let now=0,pauseUntil=0,calls=0;const samples=[];
 const request=createRateLimitedHttp({baseUrl:'https://tenant.example',now:()=>now,delay:async ms=>{now+=ms;},gate:{reserve:async()=>now<pauseUntil?{wait:pauseUntil-now}:{token:'t',reservedCost:10},complete:async(_p,s)=>{samples.push(s);if(s.pauseMs)pauseUntil=now+s.pauseMs+1000;}},http:async()=>{if(++calls===1)throw {response:{status:429,headers:{'retry-after':'75'}}};assert.ok(now>=76000);return {status:202,headers:{'x-request-cost':'10'}};}});
 await request(config);assert.equal(calls,2);assert.equal(samples[0].pauseMs,75000);
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {createConcurrentGate}=require('../src/shared/concurrentGate');
const {createRateLimitedHttp}=require('../src/shared/rateLimit');
const {buildRows,durationSummary}=require('../scripts/api-cost-report');
const hash=s=>createHash('sha256').update(s).digest('hex');
// Small expression model for the operators used by the atomic Mongo reservation.
// This exercises the actual generated filter/pipeline, not a replacement gate algorithm.
function mongoModel(onDbCall=()=>{}){
 const calls={initialize:0,reserve:0,read:0,complete:0};let doc;const get=(o,path)=>path.split('.').reduce((v,k)=>v?.[k],o);
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
   case '$eq':return a[0]===a[1];case '$cond':return a[0]?a[1]:a[2];case '$lte':return a[0]<=a[1];case '$lt':return a[0]<a[1];case '$gt':return a[0]>a[1];case '$and':return a.every(Boolean);case '$size':return a.length;case '$concatArrays':return a.flat();
   default:return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,evalExpr(x,vars)]));
  }
 }
 const collection={
  async updateOne(filter,update){
   const kind=update.$setOnInsert?'initialize':'complete';calls[kind]++;await onDbCall(kind);
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
   calls.reserve++;await onDbCall('reserve');
   if(!doc||doc.nextAt>filter.nextAt.$lte||!evalExpr(filter.$expr))return {value:null};
   Object.assign(doc,evalExpr(pipeline[0].$set));return {value:structuredClone(doc)};
 },async findOne(){calls.read++;await onDbCall('read');return structuredClone(doc);}
 };
 return {calls,client:{connect:async()=>{},db:()=>({collection:()=>collection}),close:async()=>{}},get doc(){return doc;}};
}
const route='POST /d2l/api/lp/1.63/sourceCourses/:id/deploy';
const sample={route,status:200,cost:10,remaining:49000,latencyMs:100,gateWaitMs:20,resetMs:60000};
test('atomic reservations share four permits across gate instances and release records timing',async()=>{
 let now=0;const m=mongoModel(),create=()=>createConcurrentGate({uri:'mongodb://unused/app',key:'k',now:()=>now,mongoClient:m.client});const a=create(),b=create(),permits=[];
 for(let i=0;i<4;i++){const permit=await (i%2?a:b).reserve(route);assert.ok(permit.token);permits.push(permit);now+=250;}
 assert.ok((await b.reserve(route)).wait>0);await a.complete(permits[0],sample);now+=250;assert.ok((await b.reserve(route)).token);
 const metrics=m.doc.costs[hash(route)];assert.equal(metrics.requests,1);assert.equal(metrics.timedRequests,1);assert.equal(metrics.totalLatencyMs,100);assert.equal(metrics.totalGateWaitMs,20);
 now=50000;assert.ok((await a.reserve(route)).token);await assert.rejects(()=>a.complete(permits[1],sample),/permit lost/);
});
test('local reservation slots transfer to waiters without leaking capacity',async()=>{
 let active=0,peak=0;const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const m=mongoModel(async kind=>{if(kind!=='reserve')return;active++;peak=Math.max(peak,active);await pause(5);active--;});
 const gate=createConcurrentGate({key:'bounded-local-reservations',now:()=>Date.now(),mongoClient:m.client});
 await Promise.all(Array.from({length:8},()=>gate.reserve(route)));
 assert.equal(peak,2);
 const result=await Promise.race([gate.reserve(route),pause(50).then(()=>null)]);
 assert.ok(result,'a new reservation must not wait on a leaked local slot');
});
test('concurrent reservations from multiple gate instances retain global and ordinary ceilings',async()=>{
 let clock=100000;const m=mongoModel(),a=createConcurrentGate({key:'concurrent-shared',now:()=>clock+=300,mongoClient:m.client}),b=createConcurrentGate({key:'concurrent-shared',now:()=>clock+=300,mongoClient:m.client});
 const work=Array.from({length:12},(_,i)=>(i%2?a:b).reserve(i<6?route:'GET lookup',{dateDiscovery:i>=6}));
 const results=await Promise.all(work),granted=results.filter(result=>result.token).length;
 assert.ok(granted<=8);assert.ok(m.doc.permits.length<=8);
 assert.ok(m.doc.budgetUsed<=30000);
 assert.ok(m.doc.permits.filter(permit=>!permit.dateDiscovery&&!permit.copy&&!permit.resolution).length<=4);
});
test('gate timing separates reservation, denied-read, deliberate waits, and buffered completion persistence',async()=>{
 let mono=0,now=0;
 const m=mongoModel(kind=>{mono+=({initialize:2,reserve:4,read:3,complete:5}[kind]||0);});
 const gate=createConcurrentGate({key:'timings',now:()=>now,monotonicNow:()=>mono,mongoClient:m.client});
 const first=await gate.reserve(route);assert.equal(first.mongoReservationMs,4);assert.equal(first.deniedReservationReadMs,0);
 await gate.complete(first,{...sample,gateTimings:{localReservationQueue:2,mongoReservation:4,deniedReservationRead:0,permitContentionWait:0,pacingBudgetWait:0,mixedWait:0}});
 let metrics=m.doc.costs[hash(route)];assert.equal(metrics.localReservationQueueTotalMs,2);assert.equal(metrics.mongoReservationTotalMs,4);assert.equal(metrics.completionPersistenceSamples,undefined);
 now=250;const second=await gate.reserve(route);assert.equal(second.mongoReservationMs,4);
 await gate.complete(second,{...sample,gateTimings:{localReservationQueue:1,mongoReservation:4,deniedReservationRead:0,permitContentionWait:0,pacingBudgetWait:0,mixedWait:0}});
 metrics=m.doc.costs[hash(route)];assert.equal(metrics.completionPersistenceSamples,1);assert.equal(metrics.completionPersistenceTotalMs,5);
 const pacing=await gate.reserve(route);assert.equal(pacing.waitReason,'pacingBudget');
});
test('denied atomic reservations separately measure their follow-up read and permit wait',async()=>{
 let mono=0,now=0;const m=mongoModel(kind=>{mono+=({reserve:4,read:3}[kind]||0);});
 const gate=createConcurrentGate({key:'denied-timing',now:()=>now,monotonicNow:()=>mono,mongoClient:m.client});
 for(let i=0;i<4;i++){assert.ok((await gate.reserve(route)).token);now+=250;}
 const denied=await gate.reserve(route);assert.equal(denied.mongoReservationMs,4);assert.equal(denied.deniedReservationReadMs,3);assert.equal(denied.waitReason,'permitContention');
});
test('reserved credit budget blocks starts until its window resets',async()=>{
 let now=0;const m=mongoModel(),gate=createConcurrentGate({key:'k',now:()=>now,mongoClient:m.client});const initial=await gate.reserve(route);await gate.complete(initial,sample);
 m.doc.budgetUsed=29990;now=250;
 const last=await gate.reserve(route);assert.ok(last.token);assert.equal(m.doc.budgetUsed,30000);await gate.complete(last,sample);now=270;
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
test('production transport allows eight overlapping requests and drains 5,000 submissions',async()=>{
 let active=0,max=0,count=0;const samples=[];
 const request=createRateLimitedHttp({baseUrl:'https://tenant.example',gate:{reserve:async()=>({token:'t',reservedCost:10}),complete:async(_p,s)=>samples.push(s)},http:async()=>{max=Math.max(max,++active);await new Promise(r=>setImmediate(r));active--;count++;return {status:202,headers:{'x-request-cost':'10'}};}});
 await Promise.all(Array.from({length:5000},()=>request(config)));assert.equal(max,8);assert.equal(active,0);assert.equal(count,5000);assert.equal(samples.length,5000);
});
test('production transport never repeats ambiguous writes and poisons scheduling on lost persistence',async()=>{
 for(const fail of ['timeout','reserve','complete']){
  let calls=0;const request=createRateLimitedHttp({baseUrl:'https://tenant.example',gate:{reserve:async()=>{if(fail==='reserve')throw Error('db');return {token:'t',reservedCost:10};},complete:async()=>{if(fail==='complete')throw Error('db');}},http:async()=>{calls++;if(fail==='timeout')throw Error('timeout');return {status:202,headers:{}};}});
  await assert.rejects(()=>request(config));assert.equal(calls,fail==='reserve'?0:1);
  if(fail!=='timeout'){await assert.rejects(()=>request(config));assert.equal(calls,fail==='reserve'?0:1);}
 }
});
test('transport aggregates gate timing categories without counting one wait twice',async()=>{
 let mono=0;const samples=[];let reservations=0;
 const request=createRateLimitedHttp({baseUrl:'https://tenant.example',monotonicNow:()=>mono,delay:async ms=>{mono+=ms;},gate:{reserve:async()=>++reservations===1
  ?{wait:10,waitReason:'permitContention',localReservationQueueMs:2,mongoReservationMs:4,deniedReservationReadMs:3}
  :{token:'t',reservedCost:10,localReservationQueueMs:1,mongoReservationMs:5,deniedReservationReadMs:0},complete:async(_permit,sample)=>samples.push(sample)},http:async()=>({status:200,headers:{'x-request-cost':'10'}})});
 await request(config);assert.deepEqual(samples[0].gateTimings,{localReservationQueue:3,mongoReservation:9,deniedReservationRead:3,permitContentionWait:10,pacingBudgetWait:0,mixedWait:0});
});
test('API cost report preserves unknown historical timing fields',()=>{
 assert.equal(durationSummary({},'newTotalMs','newSamples'),'unknown');
 const [row]=buildRows({old:{route:'GET /d2l/api/le/:id/quizzes/',requests:1,lastSeenAt:0}});
 assert.equal(row.localReservationQueue,'unknown');assert.equal(row.completionPersistence,'unknown');
 const [measured]=buildRows({new:{route:'GET /d2l/api/le/:id/quizzes/',lastSeenAt:0,localReservationQueueTotalMs:15,localReservationQueueSamples:3}});
 assert.equal(measured.localReservationQueue,'n=3 total=15ms avg=5ms');
});
test('production transport respects global reset waits before retrying an explicit 429',async()=>{
 let now=0,pauseUntil=0,calls=0;const samples=[];
 const request=createRateLimitedHttp({baseUrl:'https://tenant.example',now:()=>now,delay:async ms=>{now+=ms;},gate:{reserve:async()=>now<pauseUntil?{wait:pauseUntil-now}:{token:'t',reservedCost:10},complete:async(_p,s)=>{samples.push(s);if(s.pauseMs)pauseUntil=now+s.pauseMs+1000;}},http:async()=>{if(++calls===1)throw {response:{status:429,headers:{'retry-after':'75'}}};assert.ok(now>=76000);return {status:202,headers:{'x-request-cost':'10'}};}});
 await request(config);assert.equal(calls,2);assert.equal(samples[0].pauseMs,75000);
});

test('gate initializes once and cached cooldown waits do not query MongoDB',async()=>{
 let now=0;const m=mongoModel(),gate=createConcurrentGate({key:'k',now:()=>now,mongoClient:m.client});
 const p=await gate.reserve(route);await gate.complete(p,{...sample,status:429,pauseMs:75000});const before={...m.calls};
 for(let i=0;i<100;i++){const wait=await gate.reserve(route);assert.equal(wait.wait,76000);}
 assert.deepEqual(m.calls,before);now=76000;const next=await gate.reserve(route);assert.ok(next.token);assert.equal(m.calls.initialize,1);
});
test('budget waits account for the next request cost, even below the full credit ceiling',async()=>{
 let now=0;const m=mongoModel(),gate=createConcurrentGate({key:'k',now:()=>now,mongoClient:m.client});const p=await gate.reserve(route);await gate.complete(p,{...sample,cost:100});m.doc.budgetUsed=29950;now=250;
 assert.equal((await gate.reserve(route)).wait,59750);const reads=m.calls.read;now=1000;assert.equal((await gate.reserve(route)).wait,59000);assert.equal(m.calls.read,reads);
});

test('resolution permits share an eight-request ceiling and ordinary requests retain four across instances',async()=>{
 let now=0;const m=mongoModel(),make=()=>createConcurrentGate({uri:'mongodb://unused/app',key:'mixed',now:()=>now,mongoClient:m.client}),a=make(),b=make();
 for(let i=0;i<4;i++){assert.ok((await a.reserve(route)).token);now+=250;}
 assert.ok((await b.reserve(route)).wait);now+=1000;
 for(let i=0;i<4;i++){assert.ok((await b.reserve('GET /d2l/api/lp/1.63/orgstructure/',{resolution:true})).token);now+=250;}
 assert.equal(m.doc.permits.length,8);assert.ok((await a.reserve('GET lookup',{resolution:true})).wait);
 now+=50000;
 for(let i=0;i<8;i++){assert.ok((await a.reserve('GET lookup',{resolution:true})).token);now+=250;}
 assert.ok((await b.reserve('GET lookup',{resolution:true})).wait);assert.ok((await b.reserve(route)).wait);
});

test('Date Manager discovery permits share the global eight-request ceiling without raising ordinary traffic',async()=>{
 let now=0;const m=mongoModel(),gate=createConcurrentGate({key:'date-discovery',now:()=>now,mongoClient:m.client});
 for(let i=0;i<4;i++){assert.ok((await gate.reserve(route)).token);now+=250;}
 assert.ok((await gate.reserve(route)).wait);
 for(let i=0;i<4;i++){
  assert.ok((await gate.reserve('GET /d2l/api/le/1.99/9524/quizzes/',{dateDiscovery:true})).token);now+=250;
 }
 assert.equal(m.doc.permits.length,8);
 assert.ok((await gate.reserve('GET /d2l/api/le/1.99/9524/discussions/forums/32/topics/',{dateDiscovery:true})).wait);
 assert.ok((await gate.reserve(route)).wait);
 now+=50000;
 for(let i=0;i<8;i++){
  assert.ok((await gate.reserve('GET /d2l/api/le/1.99/9524/dropbox/folders/',{dateDiscovery:true})).token);now+=250;
 }
 assert.equal(m.doc.permits.length,8);
 assert.ok((await gate.reserve('GET /d2l/api/le/1.99/9524/quizzes/',{dateDiscovery:true})).wait);
});

test('Date Manager discovery routes alone use the elevated transport class',async()=>{
 const classes=[];const request=createRateLimitedHttp({baseUrl:'https://tenant.example',gate:{reserve:async(_route,options)=>{classes.push(options.dateDiscovery);return {token:'t'};},complete:async()=>{}},http:async()=>({status:200,headers:{}})});
 for(const path of ['dropbox/folders/','quizzes/','discussions/forums/','discussions/forums/32/topics/'])
  await request({method:'GET',url:`https://tenant.example/d2l/api/le/1.99/9524/${path}`});
 for(const [method,path] of [['GET','quizzes/11'],['GET','discussions/forums/32/topics/41'],['GET','discussions/forums/32'],['PUT','quizzes/'],['GET','quizzes/?unrelated=true']])
  await request({method,url:`https://tenant.example/d2l/api/le/1.99/9524/${path}`});
 assert.deepEqual(classes,[true,true,true,true,false,false,false,false,true]);
});

test('Date Manager discovery transport reaches eight reads while ordinary traffic stays at four',async()=>{
 let active=0,ordinary=0,discovery=0,peak=0,ordinaryPeak=0,discoveryPeak=0;const releases=[];
 const discoveryPattern=/\/(?:dropbox\/folders|quizzes|discussions\/forums(?:\/\d+\/topics)?)\/$/;
 const request=createRateLimitedHttp({baseUrl:'https://tenant.example',gate:{reserve:async()=>({token:'t'}),complete:async()=>{}},http:async config=>{
  const isDiscovery=discoveryPattern.test(new URL(config.url).pathname);active++;peak=Math.max(peak,active);
  if(isDiscovery){discovery++;discoveryPeak=Math.max(discoveryPeak,discovery);}else{ordinary++;ordinaryPeak=Math.max(ordinaryPeak,ordinary);}
  await new Promise(resolve=>releases.push(resolve));active--;if(isDiscovery)discovery--;else ordinary--;
  return {status:200,headers:{}};
 }});
 const paths=['dropbox/folders/','quizzes/','discussions/forums/','discussions/forums/32/topics/'];
 const work=Array.from({length:8},(_,i)=>request({method:'GET',url:`https://tenant.example/d2l/api/le/1.99/9524/${paths[i%paths.length]}`}));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(active,8);assert.equal(discovery,8);
 while(releases.length){releases.splice(0).forEach(resolve=>resolve());await new Promise(resolve=>setImmediate(resolve));}
 await Promise.all(work);
 const ordinaryWork=Array.from({length:8},()=>request({method:'GET',url:'https://tenant.example/d2l/api/le/1.99/9524/quizzes/11'}));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(ordinary,4);
 while(releases.length){releases.splice(0).forEach(resolve=>resolve());await new Promise(resolve=>setImmediate(resolve));}
 await Promise.all(ordinaryWork);assert.equal(peak,8);assert.equal(discoveryPeak,8);assert.equal(ordinaryPeak,4);
});

test('transport permits eight exact-code reads but only four other calls with a shared total of eight',async()=>{
 let active=0,ordinary=0,peak=0,ordinaryPeak=0;const releases=[],classes=[];
 const request=createRateLimitedHttp({baseUrl:'https://tenant.example',gate:{reserve:async(_route,options)=>{classes.push(options.resolution);return {token:'t'};},complete:async()=>{}},http:async config=>{
  const lookup=new URL(config.url).searchParams.has('exactOrgUnitCode');active++;if(!lookup)ordinary++;peak=Math.max(peak,active);ordinaryPeak=Math.max(ordinaryPeak,ordinary);
  await new Promise(resolve=>releases.push(resolve));active--;if(!lookup)ordinary--;return {status:200,headers:{'x-request-cost':'10'}};
 }});
 const work=Array.from({length:12},(_,i)=>request({method:'GET',url:i<6?'https://tenant.example/d2l/api/le/1.99/1/quizzes/1':'https://tenant.example/d2l/api/lp/1.63/orgstructure/?exactOrgUnitCode=C'+i}));
 await new Promise(r=>setImmediate(r));assert.equal(active,8);assert.equal(ordinary,4);
 while(releases.length){releases.splice(0).forEach(r=>r());await new Promise(r=>setImmediate(r));}await Promise.all(work);assert.equal(peak,8);assert.equal(ordinaryPeak,4);assert.equal(classes.filter(Boolean).length,6);
});

test('copy and resolution permits share eight total with four ordinary permits across instances',async()=>{
 let now=0;const m=mongoModel(),make=()=>createConcurrentGate({key:'mixed-copy',now:()=>now,mongoClient:m.client}),a=make(),b=make();
 for(let i=0;i<4;i++){assert.ok((await a.reserve(route)).token);now+=250;}
 for(let i=0;i<4;i++){assert.ok((await b.reserve('copy',{copy:true})).token);now+=250;}
 assert.ok((await a.reserve('lookup',{resolution:true})).wait);
 assert.ok((await b.reserve('copy',{copy:true})).wait);
 now+=50000;
 for(let i=0;i<8;i++){assert.ok((await (i%2?a:b).reserve('copy',{copy:true})).token);now+=250;}
 assert.equal(m.doc.permits.length,8);assert.ok((await a.reserve(route)).wait);
});
test('copy permit classification excludes unsupported import methods',async()=>{
 const classes=[];const request=createRateLimitedHttp({baseUrl:'https://tenant.example',gate:{reserve:async(_r,o)=>{classes.push(o.copy);return {token:'t'};},complete:async()=>{}},http:async()=>({status:200,headers:{}})});
 for(const [method,path] of [['POST','import/123/copy/'],['GET','import/123/copy/token'],['GET','import/123/copy/'],['PUT','import/123/copy/token'],['POST','import/123/copy/token'],['GET','ccb/logs']])
 await request({method,url:'https://tenant.example/d2l/api/le/1.99/'+path});
 assert.deepEqual(classes,[true,true,false,false,false,true]);
});

test('deployment routes overlap eight requests while date activity calls retain four',async()=>{
 for(const [method,path,expected] of [['POST','lp/1.63/sourceCourses/1/deploy',8],['PUT','lp/1.63/courses/2',8],['GET','lp/1.63/courses/2',8],['GET','lp/1.63/orgstructure/1',8],['GET','lp/1.63/sourceCourses/1/reofferedCourses',8],['GET','le/1.99/ccb/logs',8],['PUT','le/1.99/2/quizzes/3',4]]){
  let active=0,peak=0;
  const request=createRateLimitedHttp({baseUrl:'https://tenant.example',gate:{reserve:async()=>({token:'t'}),complete:async()=>{}},http:async()=>{peak=Math.max(peak,++active);await new Promise(r=>setImmediate(r));active--;return {status:200,headers:{}};}});
  await Promise.all(Array.from({length:20},()=>request({method,url:'https://tenant.example/d2l/api/'+path})));assert.equal(peak,expected,path);assert.equal(active,0);
 }
});

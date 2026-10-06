'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createSyncControls}=require('../src/resolution/routes');
const {page}=require('../src/ui/page');
const {translate}=require('../src/ui/i18n');
function response(user='user',deploymentId='deployment',ltik='session'){
 return {locals:{token:{user,deploymentId},ltik},headers:{},set(k,v){this.headers[k]=v;return this;},status(n){this.code=n;return this;},json(body){this.body=body;return this;}};
}
test('header sync is session/deployment-bound and refuses missing, tampered and expired tickets',async()=>{
 let time=1800000000000,requests=0;
 const controls=createSyncControls({secret:'test-only',deploymentId:'deployment',now:()=>time,store:{requestSync:async()=>{requests++;return 'queued';}},sync:{tick:async()=>{}}});
 const ticket=controls.ticket(response());
 for(const [value,res] of [['',response()],[ticket+'x',response()],[ticket,response('other')],[ticket,response('user','other')],[ticket,response('user','deployment','other-session')]]){
  await controls.request({body:{ticket:value}},res);assert.equal(res.code,403);
 }
 time+=7200001;const expired=response();await controls.request({body:{ticket}},expired);assert.equal(expired.code,403);assert.equal(requests,0);
 assert.equal(controls.ticket(response('user','other')),'');
});
test('sync returns immediately after durable queueing rather than waiting for import',async()=>{
 let started=0;const controls=createSyncControls({secret:'test',deploymentId:'deployment',now:()=>1800000000000,store:{requestSync:async()=> 'queued'},sync:{tick:()=>{started++;return new Promise(()=>{});}}});
 const res=response();await controls.request({body:{ticket:controls.ticket(res)}},res);assert.equal(res.code,202);assert.equal(res.body.state,'queued');assert.equal(started,1);assert.equal(res.headers['Cache-Control'],'no-store');
});
test('existing run and cooldown do not start another sync',async()=>{
 for(const state of ['running','cooldown']){
  const controls=createSyncControls({secret:'test',deploymentId:'deployment',now:()=>1800000000000,store:{requestSync:async()=>state},sync:{tick:()=>assert.fail('duplicate sync')}});
  const res=response();await controls.request({body:{ticket:controls.ticket(res)}},res);assert.equal(res.code,state==='cooldown'?429:202);assert.equal(res.body.state,state);
 }
});
test('header renders icon-only accessible sync control before language only with a ticket',()=>{
 assert.ok(!page('hello').includes('data-org-sync'));
 const html=page('hello',{ltik:'session',syncTicket:'signed'});
 const button=html.match(/<button[^>]*data-org-sync[\s\S]*?<\/button>/)[0];
 assert.match(button,/title="Sync org units"/);assert.match(button,/aria-label="Sync org units"/);assert.match(button,/<svg/);assert.ok(!button.replace(/<[^>]*>/g,'').trim());
 assert.ok(html.indexOf('data-org-sync')<html.indexOf('data-language-selector'));
 for(const language of ['es-419','pt-BR'])assert.notEqual(translate('Sync org units',language),'Sync org units');
});
test('manual request is atomic and throttled with no change to a running lease',async()=>{
 const {createResolutionStore}=require('../src/resolution/store');const calls=[];
 const collection={createIndex:async()=>{},updateOne:async(f,u)=>{calls.push({f,u});return {matchedCount:1};}};
 const store=createResolutionStore({uri:'mongodb://localhost/app',namespace:'tenant',now:()=>100000,mongoClient:{connect:async()=>{},db:()=>({collection:()=>collection})}});
 assert.equal(await store.requestSync(),'queued');const request=calls.at(-1);
 assert.equal(request.f.leaseUntil.$lte,100000);assert.equal(request.f.$or[0].manualRequestedAt.$lte,40000);assert.equal(request.u.$set.manualRequested,true);assert.equal(request.u.$set.nextRunAt,0);
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createCopyMonitor}=require('../src/replication/monitor');
function setup(response,{error,version='1.91',next=null}={}){
 const job={_id:'j',tasks:[{sourceId:'9532',submittedAt:1000,targets:[{orgUnitId:'8062'}],result:{status:'submitted'}}]};
 let saved,url;
 const store={claimCopyMonitor:async()=>job,nextCopySubmission:async()=>next,saveCopyMonitor:async(j,updates,cursor)=>{saved={updates,cursor};}};
 const monitor=createCopyMonitor({store,leRoot:`https://tenant.example/d2l/api/le/${version}`,now:()=>5000,api:{read:async value=>{url=new URL(value);if(error)throw error;return response;}}});
 return {job,monitor,get saved(){return saved;},get url(){return url;}};
}
test('copy monitor filters by source, replica and submission window without claiming text logs prove completion',async()=>{
 const s=setup({Objects:[{CopyCourseJobId:88,Message:'Copy completed'}],Next:null},{next:4000});await s.monitor.tick();
 assert.equal(s.url.searchParams.get('sourceOrgUnitId'),'9532');assert.equal(s.url.searchParams.get('destinationOrgUnitId'),'8062');assert.equal(s.url.searchParams.get('endDate'),new Date(4000).toISOString());
 assert.equal(s.saved.updates['8062'].status,'Copy logs available — completion unconfirmed');assert.match(s.saved.updates['8062'].details,/88.*Copy completed/);
});
test('ambiguous logs and pagination never mark a deployment successful',async()=>{
 for(const response of [{Objects:[{CopyCourseJobId:1,Message:'Done'},{CopyCourseJobId:2,Message:'Done'}]},{Objects:[],Next:'bookmark'}]){
 const s=setup(response);await s.monitor.tick();assert.equal(s.saved.updates['8062'].status,'Unable to match copy logs');
 }
});
test('missing logs, permission failure and old API versions remain explicitly unconfirmed',async()=>{
 for(const [options,label] of [[{error:{status:404}},'Awaiting copy logs'],[{error:{status:403}},'Monitoring unavailable'],[{version:'1.90'},'Monitoring unavailable']]){
 const s=setup(null,options);await s.monitor.tick();assert.equal(s.saved.updates['8062'].status,label);
 }
 const s=setup({Objects:[],Next:null},{version:'1.100'});await s.monitor.tick();assert.ok(s.url);
});
test('monitor polling is bounded and sanitizes log messages',async()=>{
 const s=setup({Objects:[{CopyCourseJobId:1,Message:'Bearer private-token user@example.com'}],Next:null});
 s.job.tasks[0].targets=Array.from({length:25},(_,i)=>({orgUnitId:String(i+1)}));await s.monitor.tick();
 assert.equal(Object.keys(s.saved.updates).length,10);assert.equal(s.saved.cursor,10);
 assert.doesNotMatch(JSON.stringify(s.saved),/private-token|user@example.com/);
});

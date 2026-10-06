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

test('tenant full-copy success requires matching source and destination and an unambiguous job',async()=>{
 for(const [message,expected] of [
 ['Todos os dados copiados com êxito do orgUnitId: 9532 para o orgUnitId: 8062','Copied successfully'],
 ['Todos os dados copiados com êxito do orgUnitId: 9532 para o orgUnitId: 8063','Copy logs available — completion unconfirmed'],
 ['Configurações de curso copiadas com sucesso','Copy logs available — completion unconfirmed']]){
 const s=setup({Objects:[{CopyCourseJobId:662,Message:message}]});await s.monitor.tick();assert.equal(s.saved.updates['8062'].status,expected);
 }
 const s=setup({Objects:[{CopyCourseJobId:662,Message:'Todos os dados copiados com êxito do orgUnitId: 9532 para o orgUnitId: 8062'}],Next:'more'});await s.monitor.tick();assert.equal(s.saved.updates['8062'].status,'Unable to match copy logs');
});

test('incremental checks preserve confirmed results and keep batch membership stable',async()=>{
 const s=setup({Objects:[]});
 s.job.tasks[0].targets=Array.from({length:23},(_,i)=>({orgUnitId:String(i+1)}));
 s.job.copyMonitor={'1':{status:'Copied successfully',details:'saved evidence'}};
 s.job.copyCheck={targetIds:Array.from({length:22},(_,i)=>String(i+2))};
 await s.monitor.tick();assert.equal(s.saved.cursor,10);assert.equal(s.saved.updates['1'],undefined);
 for(const id of Object.keys(s.saved.updates))s.job.copyMonitor[id]={status:'Copied successfully'};
 s.job.copyMonitorCursor=s.saved.cursor;await s.monitor.tick();
 assert.deepEqual(Object.keys(s.saved.updates),Array.from({length:10},(_,i)=>String(i+12)));
 s.job.copyMonitorCursor=s.saved.cursor;await s.monitor.tick();
 assert.deepEqual(Object.keys(s.saved.updates),['22','23']);assert.equal(s.saved.cursor,0);
 assert.equal(s.job.copyMonitor['1'].details,'saved evidence');
});

test('deployment monitor checks eight replicas concurrently and keeps the ten-replica dispatch bound',async()=>{
 const job={_id:'j',tasks:[{sourceId:'1',submittedAt:1000,targets:Array.from({length:12},(_,i)=>({orgUnitId:String(i+2)})),result:{status:'submitted'}}]};
 let active=0,peak=0,calls=0,saved;
 const monitor=createCopyMonitor({leRoot:'https://tenant.example/d2l/api/le/1.99',store:{claimCopyMonitor:async()=>job,nextCopySubmission:async()=>null,saveCopyMonitor:async(_j,updates,cursor)=>{saved={updates,cursor};}},api:{read:async()=>{peak=Math.max(peak,++active);calls++;await new Promise(r=>setImmediate(r));active--;return {Objects:[],Next:null};}}});
 await monitor.tick();assert.equal(peak,8);assert.equal(active,0);assert.equal(calls,10);assert.equal(saved.cursor,10);assert.equal(Object.keys(saved.updates).length,10);
});

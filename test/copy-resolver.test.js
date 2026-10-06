'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createCopyResolver}=require('../src/copy/resolver');
const root='https://tenant.example/d2l/api/lp/1.63';
const unit=(n,code,type='SourceCourse')=>({Identifier:String(n),Code:code,Name:code,Type:{Code:type}});
const page=(rows,more=false,bookmark='next')=>({Items:rows,PagingInfo:{HasMoreItems:more,Bookmark:bookmark}});
const row=(originCode='A',destinationCode='B')=>({status:'pending',originCode,destinationCode});
const forbidden={target:async()=>assert.fail('extra course GET'),source:async()=>assert.fail('extra source GET')};
test('exact-code metadata resolves recognized types directly and repeated courses are cached per job',async()=>{
 let calls=0;const resolver=createCopyResolver({root,sourceClient:forbidden,api:{read:async url=>{calls++;const code=new URL(url).searchParams.get('exactOrgUnitCode');return page([code==='A'?unit(1,'A','CourseOffering'):unit(2,'B')]);}}});
 const resolve=await resolver([row()],async()=>{},async()=>{});
 for(let i=0;i<50;i++){assert.equal((await resolve(row(),'origin')).orgUnitId,'1');assert.equal((await resolve(row(),'destination')).orgUnitId,'2');}assert.equal(calls,2);
 const fresh=await resolver([row()],async()=>{},async()=>{});await fresh(row(),'origin');assert.equal(calls,3);
});
test('ID-only lookup uses one metadata GET; code/ID mismatch and source origin are rejected',async()=>{
 let calls=0;const resolve=await createCopyResolver({root,sourceClient:forbidden,api:{read:async url=>{calls++;return url.includes('?')?page([unit(2,'B')]):unit(2,'B');}}})([],async()=>{},async()=>{});
 for(let i=0;i<10;i++)await resolve({destinationId:'2'},'destination');assert.equal(calls,1);
 await assert.rejects(()=>resolve({destinationId:'3',destinationCode:'B'},'destination'),/different/);
 await assert.rejects(()=>resolve({originCode:'B'},'origin'),/Course Offering/);
});
test('large CSVs use exact searches only, reuse concurrent lookups and reject duplicates across pages',async()=>{
 const requests=[];const rows=Array.from({length:5000},(_,i)=>row('A','C'+i));
 const resolve=await createCopyResolver({root,sourceClient:forbidden,api:{read:async url=>{
  const u=new URL(url),code=u.searchParams.get('exactOrgUnitCode');assert.ok(code);requests.push(url);
  if(code==='A')return page([unit(1,'A')]);
  if(code==='C0')return u.searchParams.has('bookmark')?page([unit(999,'C0')]):page([unit(2,'C0')],true);
  return page([unit(Number(code.slice(1))+2,code)]);
 }}})(rows,async()=>{},async()=>{},{direct:true});
 assert.equal(requests.length,0);
 await Promise.all(rows.map(r=>resolve(r,'origin')));assert.equal(requests.length,1);
 await assert.rejects(()=>resolve(rows[0],'destination'),/exactly one/);
 for(const r of rows.slice(1))await resolve(r,'destination');assert.equal(requests.length,5002);
});
test('cancellation stops exact-code pagination before the next request',async()=>{
 let reads=0,checks=0;
 const resolve=await createCopyResolver({root,api:{read:async()=>{reads++;return page([unit(1,'A')],true);}}})([],async()=>{if(++checks===3)throw Object.assign(Error('cancelled'),{code:'JOB_CANCELLED'});},async()=>{},{direct:true});
 await assert.rejects(()=>resolve({originCode:'A'},'origin'),{code:'JOB_CANCELLED'});assert.equal(reads,1);
});
test('missing codes and malformed pagination fail closed',async()=>{
 for(const response of [page([]),{Items:[],PagingInfo:{HasMoreItems:true,Bookmark:''}}]){
 const resolve=await createCopyResolver({root,sourceClient:forbidden,api:{read:async()=>response}})([row()],async()=>{},async()=>{});await assert.rejects(()=>resolve({destinationCode:'missing'},'destination'));
 }
});

test('direct ID-only validation makes zero API requests for 5,000 mappings',async()=>{
 const rows=Array.from({length:5000},(_,i)=>({status:'pending',originId:String(i+1),destinationId:String(i+10001)}));
 const resolve=await createCopyResolver({root,sourceClient:forbidden,api:{read:async()=>assert.fail('ID validation must not call API')}})(rows,async()=>{},async()=>{},{direct:true});
 for(const row of rows){assert.equal((await resolve(row,'origin')).orgUnitId,row.originId);assert.equal((await resolve(row,'destination')).orgUnitId,row.destinationId);}
});
test('direct code validation resolves aliases without detail calls, still rejects mismatched IDs',async()=>{
 let reads=0;const resolve=await createCopyResolver({root,sourceClient:forbidden,api:{read:async()=>{reads++;return page([unit(2,'B','Custom')]);}}})([row()],async()=>{},async()=>{},{direct:true});
 assert.equal((await resolve({originCode:'B'},'origin')).orgUnitId,'2');
 await assert.rejects(()=>resolve({originCode:'B',originId:'3'},'origin'),/different/);assert.equal(reads,1);
});

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
test('full paginated inventory resolves hundreds of codes without per-course requests and detects later duplicates',async()=>{
 let calls=0;const records=Array.from({length:250},(_,i)=>unit(i+1,'C'+i));
 const resolve=await createCopyResolver({root,sourceClient:forbidden,api:{read:async url=>{calls++;return new URL(url).searchParams.has('bookmark')?page([unit(999,'C0')]):page(records,true);}}})(records.map(r=>row('',r.Code)),async()=>{},async()=>{});
 assert.equal(calls,2);await assert.rejects(()=>resolve({destinationCode:'C0'},'destination'),/exactly one/);assert.equal((await resolve({destinationCode:'C1'},'destination')).orgUnitId,'2');assert.equal(calls,2);
});
test('partial inventory is discarded and exact lookup still checks all matches',async()=>{
 let scans=0,exact=0;
 const resolve=await createCopyResolver({root,sourceClient:forbidden,api:{read:async url=>{const u=new URL(url);if(u.searchParams.has('exactOrgUnitCode')){exact++;return page([unit(1,'C0'),unit(999,'C0')]);}scans++;return page([unit(scans,'C'+(scans-1))],true,String(scans));}}})(Array.from({length:250},(_,i)=>row('','C'+i)),async()=>{},async()=>{});
 assert.equal(scans,62);await assert.rejects(()=>resolve({destinationCode:'C0'},'destination'),/exactly one/);assert.equal(exact,1);
});
test('unrecognized types retain cached authoritative checks; cancellation interrupts inventory',async()=>{
 let targets=0;const resolver=createCopyResolver({root,api:{read:async()=>page([unit(1,'A','Custom')])},sourceClient:{target:async()=>{targets++;return {};}}});const resolve=await resolver([row()],async()=>{},async()=>{});
 await resolve({originCode:'A'},'origin');await resolve({originCode:'A'},'origin');assert.equal(targets,1);
 await assert.rejects(()=>resolver(Array.from({length:250},(_,i)=>row('','C'+i)),async()=>{throw Object.assign(Error('cancelled'),{code:'JOB_CANCELLED'});},async()=>{}),{code:'JOB_CANCELLED'});
});
test('missing codes and malformed pagination fail closed',async()=>{
 for(const response of [page([]),{Items:[],PagingInfo:{HasMoreItems:true,Bookmark:''}}]){
 const resolve=await createCopyResolver({root,sourceClient:forbidden,api:{read:async()=>response}})([row()],async()=>{},async()=>{});await assert.rejects(()=>resolve({destinationCode:'missing'},'destination'));
 }
});

test('5,000 unique origin/destination pairs resolve from a complete 10,000-unit inventory',async()=>{
 const records=Array.from({length:10000},(_,i)=>unit(i+1,'C'+i,i<5000?'CourseOffering':'SourceCourse'));let requests=0;
 const rows=Array.from({length:5000},(_,i)=>row('C'+i,'C'+(5000+i)));
 const resolve=await createCopyResolver({root,sourceClient:forbidden,api:{read:async url=>{requests++;const offset=Number(new URL(url).searchParams.get('bookmark')||0);return page(records.slice(offset,offset+1000),offset<9000,String(offset+1000));}}})(rows,async()=>{},async()=>{});
 for(const r of rows){await resolve(r,'origin');await resolve(r,'destination');}
 assert.equal(requests,10);
});
test('inventory checkpoint failures abort instead of issuing fallback reads',async()=>{
 let reads=0;const resolver=createCopyResolver({root,api:{read:async()=>{reads++;return page([]);}},sourceClient:forbidden});
 await assert.rejects(()=>resolver(Array.from({length:250},(_,i)=>row('','C'+i)),async()=>{},async()=>{throw Error('storage unavailable');}),/storage unavailable/);assert.equal(reads,1);
});

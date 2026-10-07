'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createActivityWriter,buildQuizPayload,buildDiscussionTopicPayload}=require('../src/dates/activityWriters');
const {createActivityPut}=require('../src/shared/client');
const dates={start:'2027-01-01T00:00:00.000Z',due:'2027-01-02T00:00:00.000Z',end:'2027-01-03T00:00:00.000Z'};
const fixture=type=>structuredClone(require(`./fixtures/${type}-write.json`));
function setup(type,options={}){
 const current=fixture(type),calls=[];let reads=0;
 const api={supportsLeVersion:()=>true,coursePath:(org,path)=>`https://tenant.example/d2l/api/le/1.98/${org}/${path}`,async read(path){calls.push(['GET',path]);reads++;if(options.readError||(reads>1&&options.verifyError))throw new Error('SECRET');return structuredClone(current);}};
 const put=async(path,payload)=>{calls.push(['PUT',path,payload]);if(!options.ignoreWrite){current.StartDate=payload.StartDate;current.DueDate=payload.DueDate;current.EndDate=payload.EndDate;if(type==='discussionTopic'){for(const key of ['StartDateAvailabilityType','EndDateAvailabilityType'])current[key]=Object.hasOwn(payload,key)?payload[key]:(options.defaultType??0);if(options.changeAvailability)current.EndDateAvailabilityType=2;}}if(options.changeSettings)current.Name='changed';if(options.putError)throw Object.assign(new Error('SECRET'),{status:403});};
 return {current,calls,writer:createActivityWriter({api,put,type}),request:{orgUnitId:'9524',activity:{type,id:'11',...(type==='discussionTopic'?{parentId:'31'}:{})},dates}};
}
for(const type of ['quiz','discussionTopic']){
 test(`${type}: dry preview then verified update preserves payload fields`,async()=>{
  const s=setup(type);const preview=await s.writer.updateActivityDates({...s.request,dryRun:true});assert.equal(preview.status,'ready');assert.equal(s.calls.length,1);
  const result=await s.writer.updateActivityDates(s.request);assert.equal(result.status,'updated');assert.deepEqual(result.verifiedDates,dates);
  const payload=s.calls.find(c=>c[0]==='PUT')[2];assert.equal(payload.Name,s.current.Name);assert.equal(Object.hasOwn(payload,'ActivityId'),false);
  if(type==='quiz'){assert.equal(payload.Password,'secret-quiz-password');assert.equal(payload.NumberOfAttemptsAllowed,3);assert.equal(payload.SubmissionTimeLimit.TimeLimitValue,45);assert.deepEqual(payload.RestrictIPAddressRange,s.current.RestrictIPAddressRange);assert.equal(Object.hasOwn(payload,'AttemptsAllowed'),false);}
  else{assert.equal(payload.GroupTypeId,9);assert.equal(payload.StartDateAvailabilityType,1);assert.equal(payload.DisplayInCalendar,true);assert.equal(payload.ScoringType,'2');}
  assert.equal(JSON.stringify(result).includes('secret-quiz-password'),false);
  const again=await s.writer.updateActivityDates(s.request);assert.equal(again.status,'unchanged');assert.equal(s.calls.filter(c=>c[0]==='PUT').length,1);
 });
 test(`${type}: failures, mismatches and lost responses are verified without retry`,async()=>{
  for(const [options,status] of [[{ignoreWrite:true},'failed'],[{changeSettings:true},'failed'],[{putError:true},'updated'],[{putError:true,ignoreWrite:true},'failed'],[{verifyError:true},'failed'],[{readError:true},'failed']]){
   const s=setup(type,options);const result=await s.writer.updateActivityDates(s.request);assert.equal(result.status,status,JSON.stringify(options));assert.ok(s.calls.filter(c=>c[0]==='PUT').length<=1);assert.equal(JSON.stringify(result).includes('SECRET'),false);
   if(options.verifyError)assert.equal(result.verifiedDates,null);
  }
 });
 test(`${type}: missing preservation fields and invalid identity prevent writes`,async()=>{
  const s=setup(type);delete s.current.Name;const result=await s.writer.updateActivityDates(s.request);assert.equal(result.error.category,'INCOMPLETE_NATIVE_DATA');assert.deepEqual(result.error.fields,['Name']);assert.equal(s.calls.length,1);
  const wrong=setup(type);const rejected=await wrong.writer.updateActivityDates({...wrong.request,activity:{...wrong.request.activity,orgUnitId:'1'}});assert.equal(rejected.error.category,'INVALID_IDENTITY');assert.equal(wrong.calls.length,0);
 });
}
test('quiz attempts, rich text and version-specific fields map explicitly',()=>{
 const row=fixture('quiz');row.AttemptsAllowed={IsUnlimited:true,NumberOfAttemptsAllowed:null};
 const p=buildQuizPayload(row,dates,()=>false);assert.equal(p.NumberOfAttemptsAllowed,null);assert.deepEqual(p.Instructions.Text,{Type:'Html',Content:'<b>Keep</b>'});
 assert.equal(Object.hasOwn(p,'IsSingleSession'),false);assert.equal(Object.hasOwn(p,'AnnotationToolsEnabled'),false);
 row.AttemptsAllowed={IsUnlimited:false,NumberOfAttemptsAllowed:0};assert.throws(()=>buildQuizPayload(row,dates,()=>true));
});
test('collection native data previews without an item GET and apply retains both safety reads',async()=>{
 const s=setup('quiz');
 const preview=await s.writer.updateActivityDates({...s.request,dryRun:true,nativeActivity:structuredClone(s.current)});
 assert.equal(preview.status,'ready');assert.deepEqual(preview.verifiedDates,{start:null,due:null,end:null});
 assert.equal(s.calls.length,0);
 const unchanged=await s.writer.updateActivityDates({...s.request,dryRun:true,nativeActivity:{...structuredClone(s.current),StartDate:dates.start,DueDate:dates.due,EndDate:dates.end}});
 assert.equal(unchanged.status,'unchanged');assert.equal(s.calls.length,0);
 const result=await s.writer.updateActivityDates({...s.request,expectedDates:preview.verifiedDates});
 assert.equal(result.status,'updated');assert.deepEqual(s.calls.map(call=>call[0]),['GET','PUT','GET']);
});
test('Discussion Topic requires valid forum, strictly later due date and known calendar/availability values',async()=>{
 const s=setup('discussionTopic');let result=await s.writer.updateActivityDates({...s.request,dates:{...dates,due:dates.start}});assert.equal(result.error.category,'INVALID_DATES');assert.equal(s.calls.length,0);
 result=await s.writer.updateActivityDates({...s.request,activity:{type:'discussionTopic',id:'11'}});assert.equal(result.status,'failed');assert.equal(s.calls.length,0);
 s.current.ForumId=99;result=await s.writer.updateActivityDates(s.request);assert.equal(result.error.category,'INVALID_IDENTITY');
 const row=fixture('discussionTopic');delete row.DisplayInCalendar;assert.throws(()=>buildDiscussionTopicPayload(row,dates),e=>e.fields.includes('DisplayInCalendar'));
 row.DisplayInCalendar=true;row.StartDateAvailabilityType=99;assert.throws(()=>buildDiscussionTopicPayload(row,dates),e=>e.code==='UNKNOWN_AVAILABILITY');
});
test('native PUT transport is restricted separately for each writer',async()=>{
 for(const [type,path] of [['quiz','quizzes/11'],['discussionTopic','discussions/forums/31/topics/11']]){
  const calls=[];const put=createActivityPut({type,leRoot:'https://tenant.example/d2l/api/le/1.98',oauth:{getAccessToken:async()=>'token'},http:async c=>{calls.push(c);return {data:{}};}});
  await put(`https://tenant.example/d2l/api/le/1.98/9524/${path}`,{});assert.equal(calls[0].method,'PUT');
  for(const wrong of ['content/topics/11','dropbox/folders/11',path+'/specialaccess/5'])await assert.rejects(()=>put(`https://tenant.example/d2l/api/le/1.98/9524/${wrong}`,{}));
  assert.equal(calls.length,1);
 }
});

test('undated Discussion with null types uses defaults and verifies without duplicate writes',async()=>{
 for(const defaultType of [0,1,2]){
  const s=setup('discussionTopic',{defaultType});
  s.current.StartDate=null;s.current.DueDate=null;s.current.EndDate=null;
  s.current.StartDateAvailabilityType=null;s.current.EndDateAvailabilityType=null;
  assert.equal((await s.writer.updateActivityDates({...s.request,dryRun:true})).status,'ready');
  assert.equal(s.calls.length,1);
  assert.equal((await s.writer.updateActivityDates(s.request)).status,'updated');
  const payload=s.calls.find(c=>c[0]==='PUT')[2];
  assert.equal(Object.hasOwn(payload,'StartDateAvailabilityType'),false);
  assert.equal(Object.hasOwn(payload,'EndDateAvailabilityType'),false);
  assert.equal((await s.writer.updateActivityDates(s.request)).status,'unchanged');
  assert.equal(s.calls.filter(c=>c[0]==='PUT').length,1);
 }
});
test('mixed Discussion types preserve explicit values and still detect changed settings',async()=>{
 const row=fixture('discussionTopic');row.StartDateAvailabilityType=null;
 const payload=buildDiscussionTopicPayload(row,dates);
 assert.equal(Object.hasOwn(payload,'StartDateAvailabilityType'),false);
 assert.equal(payload.EndDateAvailabilityType,row.EndDateAvailabilityType);
 const s=setup('discussionTopic',{changeSettings:true});s.current.StartDateAvailabilityType=null;
 assert.equal((await s.writer.updateActivityDates(s.request)).error.category,'SETTINGS_CHANGED');
 delete row.EndDateAvailabilityType;
 assert.throws(()=>buildDiscussionTopicPayload(row,dates),e=>e.code==='INCOMPLETE_NATIVE_DATA');
});

test('stale bulk preview dates prevent PUT; matching requested dates still converge unchanged',async()=>{
 for(const type of ['quiz','discussionTopic']){
  const s=setup(type);const result=await s.writer.updateActivityDates({...s.request,expectedDates:{start:'2000-01-01T00:00:00.000Z',due:null,end:null}});
  assert.equal(result.error.category,'STALE_PREVIEW');assert.equal(result.writeAttempted,false);assert.equal(s.calls.filter(c=>c[0]==='PUT').length,0);
  Object.assign(s.current,{StartDate:dates.start,DueDate:dates.due,EndDate:dates.end});
  assert.equal((await s.writer.updateActivityDates({...s.request,expectedDates:{start:null,due:null,end:null}})).status,'unchanged');
 }
});
test('lost bulk worker lease blocks write after reading native data',async()=>{
 const s=setup('quiz');const result=await s.writer.updateActivityDates({...s.request,beforeWrite:async()=>{throw Error('lease lost');}});
 assert.equal(result.status,'failed');assert.equal(result.writeAttempted,false);assert.equal(s.calls.filter(c=>c[0]==='PUT').length,0);
});

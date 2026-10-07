'use strict';
const { isDeepStrictEqual } = require('node:util');
const { id } = require('../shared/id');
const { normalizeAssignment, normalizeInstant, normalizeQuiz, normalizeDiscussionTopic } = require('./activities/normalizers');

const fields = ['CategoryId', 'Name', 'GroupTypeId', 'DisplayInCalendar', 'NotificationEmail',
  'IsHidden', 'IsAnonymous', 'DropboxType', 'SubmissionType', 'CompletionType', 'GradeItemId',
  'AllowOnlyUsersWithSpecialAccess'];
const fail = (code, message, fields) => Object.assign(new Error(message), { code, ...(fields ? { fields } : {}) });
// Fixed-width fractions retain sub-millisecond ordering and equality.
const instantKey = value => value === null ? null : value.replace(/\.(\d+)Z$/, (_, fraction) => `.${fraction.padEnd(9, '0')}Z`);
function validateDates(dates) {
  if (!dates || Object.keys(dates).some(k => !['start','due','end'].includes(k))) throw fail('INVALID_DATES', 'Supply only start, due and end.');
  const result = {};
  for (const field of ['start','due','end']) {
    if (dates[field] == null) throw fail('INVALID_DATES', 'All three dates are required.');
    result[field] = normalizeInstant(dates[field], field);
  }
  if (instantKey(result.start) > instantKey(result.due) || instantKey(result.due) > instantKey(result.end)) {
    throw fail('INVALID_DATES', 'Dates must satisfy Start <= Due <= End.');
  }
  return result;
}
const sameDates = (a,b) => ['start','due','end'].every(key => instantKey(a[key]) === instantKey(b[key]));
function buildAssignmentPayload(current, dates, supportsLeVersion) {
  // These fields lack a documented omission-preserves-current guarantee.
  const required = ['CategoryId', 'Name', 'GroupTypeId', 'DisplayInCalendar',
    'NotificationEmail', 'CustomInstructions', 'Availability'];
  const missing = required.filter(key => !Object.hasOwn(current, key) || current[key] === undefined);
  if (missing.length) {
    throw Object.assign(fail('INCOMPLETE_NATIVE_DATA', `Required Assignment fields missing: ${missing.join(', ')}. No update was sent.`), { fields: missing });
  }
  if (typeof current.Name !== 'string' || typeof current.DisplayInCalendar !== 'boolean') {
    throw fail('INCOMPLETE_NATIVE_DATA', 'Assignment Name or DisplayInCalendar is invalid; no update was sent.');
  }
  const availability = current.Availability === null
    ? { StartDateAvailabilityType: null, EndDateAvailabilityType: null } : current.Availability;
  if (!availability || ['StartDateAvailabilityType','EndDateAvailabilityType'].some(key =>
    ![null,0,1,2,'0','1','2'].includes(availability[key]))) {
    throw fail('UNKNOWN_AVAILABILITY', 'Availability types must be null or a recognized value.');
  }
  const rich = current.CustomInstructions;
  let instructions;
  if (typeof rich?.Html === 'string') instructions = { Content: rich.Html, Type: 'Html' };
  else if (typeof rich?.Text === 'string') instructions = { Content: rich.Text, Type: 'Text' };
  else throw fail('INCOMPLETE_NATIVE_DATA', 'Assignment instructions could not be preserved.');
  // D2L documents omission/null as preserving these non-date settings.
  // Do not invent defaults when they are unavailable in the read response.
  const payload = Object.fromEntries(fields.filter(key => Object.hasOwn(current, key) && current[key] !== undefined)
    .map(key => [key, structuredClone(current[key])]));
  payload.CustomInstructions = instructions;
  if (current.Assessment?.ScoreDenominator != null) {
    payload.Assessment = { ScoreDenominator: current.Assessment.ScoreDenominator };
  }
  payload.Availability = { StartDate: dates.start, EndDate: dates.end,
    StartDateAvailabilityType: availability.StartDateAvailabilityType,
    EndDateAvailabilityType: availability.EndDateAvailabilityType };
  // Omitted unspecified types use the documented org-unit defaults.
  for (const key of ['StartDateAvailabilityType','EndDateAvailabilityType']) {
    if (payload.Availability[key] === null) delete payload.Availability[key];
  }
  payload.DueDate = dates.due;
  if (supportsLeVersion('1.98')) payload.SubmissionRule = current.SubmissionRule ?? null;
  return payload;
}
function preservedSettings(payload, requested = payload) {
  const result = structuredClone(payload);
  delete result.DueDate; delete result.Availability.StartDate; delete result.Availability.EndDate;
  // Brightspace may serialize enums as numbers or decimal strings.
  for (const key of ['DropboxType','SubmissionType','CompletionType','SubmissionRule']) {
    if (result[key] != null) result[key] = String(result[key]);
  }
  for (const key of ['StartDateAvailabilityType','EndDateAvailabilityType']) {
    if (!Object.hasOwn(requested.Availability, key)) delete result.Availability[key];
    else if (Object.hasOwn(result.Availability, key)) result.Availability[key] = String(result.Availability[key]);
  }
  return result;
}
function required(row,fields) {
  const missing=fields.filter(key=>!Object.hasOwn(row,key)||row[key]===undefined);
  if(missing.length) throw fail('INCOMPLETE_NATIVE_DATA',`Settings missing: ${missing.join(', ')}. No update was sent.`,missing);
}
function richText(value) {
  if(typeof value?.Html==='string') return {Content:value.Html,Type:'Html'};
  if(typeof value?.Text==='string') return {Content:value.Text,Type:'Text'};
  throw fail('INCOMPLETE_NATIVE_DATA','Rich text settings could not be preserved.');
}
const quizFields=['Name','IsActive','SortOrder','AutoExportToGrades','GradeItemId','IsAutoSetGraded',
  'DisplayInCalendar','LateSubmissionInfo','SubmissionTimeLimit','SubmissionGracePeriod','Password',
  'AllowHints','DisableRightClick','DisablePagerAndAlerts','NotificationEmail','CalcTypeId',
  'RestrictIPAddressRange','CategoryId','PreventMovingBackwards','Shuffle','AllowOnlyUsersWithSpecialAccess',
  'IsRetakeIncorrectOnly','PagingTypeId','IsSynchronous','DeductionPercentage','HideQuestionPoints'];
function buildQuizPayload(row,dates,supports) {
  const fields=[...quizFields];
  if(supports('1.92'))fields.push('IsSingleSession');
  if(supports('1.98'))fields.push('AnnotationToolsEnabled');
  required(row,[...fields,'AttemptsAllowed','Instructions','Description','Header','Footer']);
  const payload=Object.fromEntries(fields.map(key=>[key,structuredClone(row[key])]));
  for(const key of ['Instructions','Description','Header','Footer']) {
    if(typeof row[key]?.IsDisplayed!=='boolean')throw fail('INCOMPLETE_NATIVE_DATA',`${key}.IsDisplayed is unavailable.`);
    payload[key]={Text:richText(row[key].Text),IsDisplayed:row[key].IsDisplayed};
  }
  const attempts=row.AttemptsAllowed;
  if(typeof attempts?.IsUnlimited!=='boolean'||(!attempts.IsUnlimited&&(!Number.isInteger(attempts.NumberOfAttemptsAllowed)||attempts.NumberOfAttemptsAllowed<1||attempts.NumberOfAttemptsAllowed>10))) {
    throw fail('INCOMPLETE_NATIVE_DATA','Quiz attempt settings could not be preserved.');
  }
  for(const [key,fields] of [['LateSubmissionInfo',['LateSubmissionOption','LateLimitMinutes']],['SubmissionTimeLimit',['IsEnforced','ShowClock','TimeLimitValue']]]){
    if(!row[key]||typeof row[key]!=='object')throw fail('INCOMPLETE_NATIVE_DATA',`${key} is unavailable.`);
    required(row[key],fields);
    payload[key]=Object.fromEntries(fields.map(field=>[field,row[key][field]]));
  }
  payload.NumberOfAttemptsAllowed=attempts.IsUnlimited?null:attempts.NumberOfAttemptsAllowed;
  return {...payload,StartDate:dates.start,DueDate:dates.due,EndDate:dates.end};
}
const topicFields=['Name','AllowAnonymousPosts','IsHidden','UnlockStartDate','UnlockEndDate',
  'RequiresApproval','ScoreOutOf','IsAutoScore','IncludeNonScoredValues','ScoringType','IsLocked',
  'MustPostToParticipate','RatingType','DisplayInCalendar','DisplayUnlockDatesInCalendar','GroupTypeId',
  'StartDateAvailabilityType','EndDateAvailabilityType'];
function buildDiscussionTopicPayload(row,dates) {
  required(row,[...topicFields,'Description']);
  for(const key of ['StartDateAvailabilityType','EndDateAvailabilityType']) {
    if(![null,0,1,2,'0','1','2'].includes(row[key]))throw fail('UNKNOWN_AVAILABILITY','Discussion availability types must be null or a recognized value.');
  }
  if(typeof row.DisplayInCalendar!=='boolean'||typeof row.DisplayUnlockDatesInCalendar!=='boolean') {
    throw fail('INCOMPLETE_NATIVE_DATA','Discussion calendar settings are unknown; no update was sent.');
  }
  const payload=Object.fromEntries(topicFields.map(key=>[key,structuredClone(row[key])]));
  // Omit unspecified types so Brightspace applies its configured course defaults.
  for (const key of ['StartDateAvailabilityType','EndDateAvailabilityType']) {
    if (payload[key] === null) delete payload[key];
  }
  return {...payload,Description:richText(row.Description),StartDate:dates.start,DueDate:dates.due,EndDate:dates.end};
}
function settings(payload, requested = payload) {
  const copy=structuredClone(payload);delete copy.StartDate;delete copy.DueDate;delete copy.EndDate;
  for(const key of ['ScoringType','RatingType','StartDateAvailabilityType','EndDateAvailabilityType'])if(copy[key]!=null)copy[key]=String(copy[key]);
  for (const key of ['StartDateAvailabilityType','EndDateAvailabilityType']) {
    if (!Object.hasOwn(requested, key)) delete copy[key];
  }
  return copy;
}
function createActivityWriter({api,put,type}) {
  if(!['assignment','quiz','discussionTopic'].includes(type))throw new Error('Unsupported writer type');
  const topic=type==='discussionTopic', assignment=type==='assignment';
  const normalize=assignment?normalizeAssignment:topic?normalizeDiscussionTopic:normalizeQuiz;
  const compare=assignment?preservedSettings:settings;
  const build=assignment?buildAssignmentPayload:topic?buildDiscussionTopicPayload:buildQuizPayload;
  return { async updateActivityDates({orgUnitId,activity,dates,expectedDates,beforeWrite,dryRun=false,nativeActivity}) {
    const result={courseOrgUnitId:null,activityKey:null,type,name:null,status:'failed',requestedDates:null,verifiedDates:null,writeAttempted:false,error:null};
    let stage='validation';
    try {
      orgUnitId=id(orgUnitId);result.courseOrgUnitId=orgUnitId;
      const itemId=id(activity?.id), parentId=topic?id(activity?.parentId):null;
      result.activityKey=`${type}:${orgUnitId}:${itemId}`;
      if(activity.type!==type||(activity.orgUnitId!=null&&id(activity.orgUnitId)!==orgUnitId)||(activity.key!=null&&activity.key!==result.activityKey))throw fail('INVALID_IDENTITY','Activity identity does not match the requested course/type.');
      result.requestedDates=validateDates(dates);
      if(assignment&&instantKey(result.requestedDates.start)>=instantKey(result.requestedDates.end))throw fail('INVALID_DATES','Assignment Start must be earlier than End.');
      if(topic&&instantKey(result.requestedDates.start)>=instantKey(result.requestedDates.due))throw fail('INVALID_DATES','Discussion Topic Due must be later than Start.');
      const path=api.coursePath(orgUnitId,assignment?`dropbox/folders/${itemId}`:topic?`discussions/forums/${parentId}/topics/${itemId}`:`quizzes/${itemId}`);
      const check=row=>{if(id(row[assignment?'Id':topic?'TopicId':'QuizId'])!==itemId||(topic&&id(row.ForumId)!==parentId))throw fail('INVALID_IDENTITY','API returned an unexpected activity or parent forum.');};
      stage='read';const before=dryRun&&nativeActivity?nativeActivity:await api.read(path);check(before);
      const normalized=normalize(before,orgUnitId);result.name=normalized.name;result.verifiedDates=normalized.dates;
      const alreadyMatches=sameDates(normalized.dates,result.requestedDates);
      if(alreadyMatches&&!(dryRun&&nativeActivity))return {...result,status:'unchanged'};
      if(expectedDates && !sameDates(normalized.dates,expectedDates))throw fail('STALE_PREVIEW','Dates changed since preview. Create a new preview before updating this activity.');
      const payload=build(before,result.requestedDates,api.supportsLeVersion);
      if(alreadyMatches)return {...result,status:'unchanged'};
      if(dryRun)return {...result,status:'ready'};
      if(beforeWrite)await beforeWrite();
      stage='write';result.writeAttempted=true;
      let writeError;try{await put(path,payload);}catch(error){writeError=error;}
      stage='verification';result.verifiedDates=null;
      const after=await api.read(path);check(after);result.verifiedDates=normalize(after,orgUnitId).dates;
      const verified=build(after,result.requestedDates,api.supportsLeVersion);
      if(!isDeepStrictEqual(compare(payload),compare(verified,payload)))throw fail('SETTINGS_CHANGED','Unrelated settings differ after the update; inspect the activity before retrying.');
      if(!sameDates(result.verifiedDates,result.requestedDates)){
        if(writeError){stage='write';throw writeError;}
        throw fail('VERIFICATION_MISMATCH','Read-back dates do not match the request.');
      }
      return {...result,status:'updated',...(writeError?{reconciled:true}:{})};
    }catch(error){
      const known=['STALE_PREVIEW','INVALID_DATE','INVALID_DATES','INVALID_IDENTITY','INCOMPLETE_NATIVE_DATA','UNKNOWN_AVAILABILITY','SETTINGS_CHANGED','VERIFICATION_MISMATCH'].includes(error.code);
      result.error={category:known?error.code:stage==='validation'?'INVALID_INPUT':'API_FAILURE',stage,
        message:known?error.message:'Activity operation failed; check API configuration and Service User permissions.',
        ...(known&&error.fields?{fields:error.fields}:{}),...(Number.isInteger(error.status)?{httpStatus:error.status}:{}),
        ...(error.status === 400 && Array.isArray(error.validation) ? { validation: error.validation } : {})};
      return result;
    }
  }};
}
module.exports={createActivityWriter,buildAssignmentPayload,buildQuizPayload,buildDiscussionTopicPayload,validateDates};

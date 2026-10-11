'use strict';
const {validateDates}=require('./activityWriters');
const {localDateToUtc}=require('./timeZone');

const ACTIVITY_TYPES=Object.freeze(['assignment','quiz','discussionTopic']);
const MATCH_METHODS=Object.freeze(['contains','startsWith']);
function invalid(message,code='INVALID_SCHEDULING_RULES'){return Object.assign(new Error(message),{code});}
function validateActivityTypes(types=ACTIVITY_TYPES){
 const selected=[...new Set((Array.isArray(types)?types:[types]).map(String))];
 if(!selected.length||selected.some(type=>!ACTIVITY_TYPES.includes(type)))throw invalid('Select one or more supported activity types.','INVALID_ACTIVITY_TYPES');
 return selected;
}
function validateRules(rules,{timeZone,local=false}={}){
 if(!Array.isArray(rules)||rules.length<1||rules.length>20)throw invalid('Configure between 1 and 20 scheduling rules.');
 const ids=new Set();
 return rules.map((rule,index)=>{
  const id=String(rule?.id||'').trim(),label=String(rule?.label||'').trim(),pattern=String(rule?.pattern??rule?.titlePattern??'').trim(),method=String(rule?.method||rule?.matchingMethod||'');
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id)||ids.has(id))throw invalid(`Rule ${index+1} needs a unique rule ID using letters, numbers, underscores or hyphens.`);ids.add(id);
  if(!label||label.length>120)throw invalid(`Rule ${index+1} needs a label of at most 120 characters.`);
  if(!pattern||pattern.length>200)throw invalid(`Rule ${index+1} needs a title pattern of at most 200 characters.`);
  if(!MATCH_METHODS.includes(method))throw invalid(`Rule ${index+1} has an unsupported matching method.`);
  let dates;
  try{
   const source=local?Object.fromEntries(['start','due','end'].map(key=>[key,localDateToUtc(rule[key],timeZone)])):rule.dates||rule;
   dates=validateDates(source);
  }catch{throw invalid(`Rule ${index+1} must have valid Start, Due and End dates.`,'INVALID_DATES');}
  if(Date.parse(dates.start)>=Date.parse(dates.due)||Date.parse(dates.due)>Date.parse(dates.end))throw invalid(`Rule ${index+1} dates must satisfy Start < Due <= End.`,'INVALID_DATES');
  return {id,label,method,pattern,dates};
 });
}
function resolveActivity(activity,rules,activityTypes=ACTIVITY_TYPES){
 if(!activityTypes.includes(activity.type))return {status:'excluded',reason:'unselected'};
 const title=String(activity.name??'').toLocaleLowerCase('en-US');
 const matched=rules.filter(rule=>{
  const pattern=rule.pattern.trim().toLocaleLowerCase('en-US');
  return rule.method==='contains'?title.includes(pattern):title.startsWith(pattern);
 });
 if(matched.length>1)return {status:'conflict',ruleIds:matched.map(rule=>rule.id)};
 if(!matched.length)return {status:'unmatched'};
 return {status:'matched',rule:matched[0],dates:matched[0].dates};
}
module.exports={ACTIVITY_TYPES,MATCH_METHODS,validateActivityTypes,validateRules,resolveActivity};

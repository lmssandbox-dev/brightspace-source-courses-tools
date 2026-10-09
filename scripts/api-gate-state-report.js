'use strict';
require('dotenv').config();
const {MongoClient}=require('mongodb');
const {databaseConfig}=require('../src/shared/database');
const {rateLimitKey}=require('../src/shared/rateLimit');

const BUDGET=30000,WINDOW_MS=60000;
const DISCOVERY_ROUTE_FAMILIES=[
 ['Assignment folders',/^GET \/d2l\/api\/le\/[^/]+\/:id\/dropbox\/folders\/$/],
 ['Quizzes',/^GET \/d2l\/api\/le\/[^/]+\/:id\/quizzes\/$/],
 ['Discussion forums',/^GET \/d2l\/api\/le\/[^/]+\/:id\/discussions\/forums\/$/],
 ['Discussion topics',/^GET \/d2l\/api\/le\/[^/]+\/:id\/discussions\/forums\/:id\/topics\/$/]
];
function routeFamily(route){return DISCOVERY_ROUTE_FAMILIES.find(([,pattern])=>pattern.test(route||''))?.[0]||null;}
function estimatedCost(sample){return Math.max(1,Number.isFinite(sample?.maxCost)?sample.maxCost:125,Number(sample?.fallbackCost)||0);}
function timestamp(value){if(!Number.isFinite(value))return 'unknown';try{return new Date(value).toISOString();}catch{return 'unknown';}}
function relativeMs(value,now){return Number.isFinite(value)?Math.round(value-now):null;}
function summarizePermits(permits,now){
 if(!Array.isArray(permits))return {available:false,active:null,expired:null,ordinary:null,elevated:null,earliest:null,latest:null};
 const active=permits.filter(permit=>Number.isFinite(permit?.until)&&permit.until>now),expired=permits.filter(permit=>Number.isFinite(permit?.until)&&permit.until<=now);
 const elevated=active.filter(permit=>Boolean(permit.resolution||permit.copy||permit.dateDiscovery)).length;
 return {available:true,active:active.length,expired:expired.length,ordinary:active.length-elevated,elevated,earliest:active.length?Math.min(...active.map(permit=>permit.until)):null,latest:active.length?Math.max(...active.map(permit=>permit.until)):null,unknownExpiry:permits.filter(permit=>!Number.isFinite(permit?.until)).length};
}
function buildReport(row,now=Date.now()){
 if(!row)return {found:false,now};
 const permitSummary=summarizePermits(row.permits,now);
 const routes=[];
 for(const sample of Object.values(row.costs||{})){
  const family=routeFamily(sample?.route);if(!family)continue;
  const cost=estimatedCost(sample),minimumSpacingMs=Math.max(20,cost*2);
  routes.push({family,route:sample.route,maxCost:Number.isFinite(sample.maxCost)?sample.maxCost:null,fallbackCost:Number.isFinite(sample.fallbackCost)?sample.fallbackCost:null,estimatedReservationCost:cost,minimumSpacingMs,adaptiveSpacingExceedsMinimum:Number.isFinite(row.adaptiveSpacing)?row.adaptiveSpacing>minimumSpacingMs:null});
 }
 routes.sort((a,b)=>a.family.localeCompare(b.family)||a.route.localeCompare(b.route));
 const budgetStart=Number.isFinite(row.budgetStart)?row.budgetStart:null,budgetAgeMs=budgetStart==null?null:now-budgetStart,budgetWindowActive=budgetAgeMs!=null&&budgetAgeMs<WINDOW_MS;
 const budgetUsed=Number.isFinite(row.budgetUsed)?row.budgetUsed:null;
 const exhaustedRoutes=budgetWindowActive&&budgetUsed!=null?routes.filter(route=>budgetUsed+route.estimatedReservationCost>BUDGET):[];
 const adaptiveKnown=Number.isFinite(row.adaptiveSpacing),minimums=routes.map(route=>route.minimumSpacingMs);
 return {
  found:true,now,
  gate:{nextAt:Number.isFinite(row.nextAt)?row.nextAt:null,nextAtRelativeMs:relativeMs(row.nextAt,now),pauseUntil:Number.isFinite(row.pauseUntil)?row.pauseUntil:null,pauseUntilRelativeMs:relativeMs(row.pauseUntil,now),adaptiveSpacing:Number.isFinite(row.adaptiveSpacing)?row.adaptiveSpacing:null,budgetStart,budgetAgeMs,budgetWindowRemainingMs:budgetAgeMs==null?null:Math.max(0,WINDOW_MS-budgetAgeMs),budgetUsed,budgetCeiling:BUDGET,budgetWindowMs:WINDOW_MS,lastRemainingCredits:Number.isFinite(row.lastRemainingCredits)?row.lastRemainingCredits:null,lastResetMs:Number.isFinite(row.lastResetMs)?row.lastResetMs:null,
   cooldownActive:Number.isFinite(row.pauseUntil)?row.pauseUntil>now:null,nextAtPreventingAdmission:Number.isFinite(row.nextAt)?row.nextAt>now:null,budgetWindowActive,localBudgetAppearsExhausted:budgetWindowActive&&budgetUsed!=null&&routes.length?exhaustedRoutes.length>0:null,
   adaptiveSpacingExceedsKnownRouteMinimum:adaptiveKnown&&minimums.length?minimums.some(value=>row.adaptiveSpacing>value):null
  },permits:permitSummary,routes
 };
}
async function readGateState(collection,key){
 return collection.findOne({_id:key},{projection:{_id:0,nextAt:1,pauseUntil:1,adaptiveSpacing:1,budgetStart:1,budgetUsed:1,lastRemainingCredits:1,lastResetMs:1,'permits.until':1,'permits.resolution':1,'permits.copy':1,'permits.dateDiscovery':1,costs:1}});
}
function printReport(report){
 console.log(`Current application server time: ${timestamp(report.now)}`);
 if(!report.found){console.log('No persisted API gate document exists for this tenant.');return;}
 const gate=report.gate,fmtRelative=value=>value==null?'unknown':`${value>=0?'+':''}${value} ms`;
 console.log('\nCurrent gate state (stored values and derived status)');
 console.table([
  {field:'nextAt',stored:timestamp(gate.nextAt),relative:fmtRelative(gate.nextAtRelativeMs),interpretation:gate.nextAtPreventingAdmission==null?'unknown':gate.nextAtPreventingAdmission?'currently preventing admission':'not currently preventing admission'},
  {field:'pauseUntil',stored:timestamp(gate.pauseUntil),relative:fmtRelative(gate.pauseUntilRelativeMs),interpretation:gate.cooldownActive==null?'unknown':gate.cooldownActive?'cooldown active':'no active cooldown'},
  {field:'adaptiveSpacing',stored:gate.adaptiveSpacing==null?'unknown':`${gate.adaptiveSpacing} ms`,relative:'—',interpretation:gate.adaptiveSpacingExceedsKnownRouteMinimum==null?'route comparison unavailable':gate.adaptiveSpacingExceedsKnownRouteMinimum?'exceeds at least one known route minimum':'does not exceed known route minima'},
  {field:'budgetStart',stored:timestamp(gate.budgetStart),relative:gate.budgetAgeMs==null?'unknown':`${Math.round(gate.budgetAgeMs)} ms elapsed`,interpretation:gate.budgetWindowActive?'current local credit window':'window expired or unavailable'},
  {field:'budgetUsed',stored:gate.budgetUsed==null?'unknown':`${gate.budgetUsed} credits`,relative:'—',interpretation:`ceiling ${gate.budgetCeiling} credits / ${gate.budgetWindowMs/1000}s; ${gate.localBudgetAppearsExhausted==null?'exhaustion unknown':gate.localBudgetAppearsExhausted?'appears exhausted for at least one known discovery route':'not exhausted for known discovery routes'}`},
  {field:'lastRemainingCredits',stored:gate.lastRemainingCredits??'unknown',relative:'—',interpretation:'latest observed Brightspace balance'},
  {field:'lastResetMs',stored:gate.lastResetMs==null?'unknown':`${gate.lastResetMs} ms`,relative:'—',interpretation:'stored reset duration from the latest response, not an epoch timestamp'}
 ]);
 console.log('\nPermits (tokens omitted)');
 if(!report.permits.available)console.log('Permit state unavailable.');
 else {
  const p=report.permits;
  console.table([{unexpired:p.active,expiredEntries:p.expired,ordinaryUnexpired:p.ordinary,elevatedUnexpired:p.elevated,unknownExpiryEntries:p.unknownExpiry,earliestExpiry:timestamp(p.earliest),latestExpiry:timestamp(p.latest)}]);
 }
 console.log('\nStored Date Manager discovery route costs');
 if(!report.routes.length)console.log('No matching normalized route records found.');
 else console.table(report.routes.map(({family,route,maxCost,fallbackCost,estimatedReservationCost,minimumSpacingMs,adaptiveSpacingExceedsMinimum})=>({family,normalizedRoute:route,maxCost:maxCost??'unknown',fallbackCost:fallbackCost??'unknown',estimatedReservationCost,minimumSpacingMs,adaptiveSpacingExceedsMinimum:adaptiveSpacingExceedsMinimum==null?'unknown':adaptiveSpacingExceedsMinimum?'yes':'no'})));
 console.log('\nInterpretation is limited to this current persisted snapshot. It does not establish historical gate conditions or available Brightspace capacity; absence of 429 responses is not evidence of unused capacity.');
}
async function main(env=process.env){
 const uri=env.MONGODB_URL;databaseConfig(uri);
 if(!env.BS_URL||!env.D2L_OAUTH2_CLIENT_ID)throw Error('Missing gate configuration');
 const key=rateLimitKey(env.BS_URL,env.D2L_OAUTH2_CLIENT_ID),client=new MongoClient(uri,{serverSelectionTimeoutMS:10000});
 try{
  await client.connect();const row=await readGateState(client.db().collection('api_rate_limits'),key);
  printReport(buildReport(row,Date.now()));
 }finally{await client.close();}
}
if(require.main===module)main().catch(()=>{console.error('Could not read API gate state. Check environment and MongoDB access.');process.exitCode=1;});
module.exports={buildReport,main,printReport,readGateState,routeFamily,summarizePermits};

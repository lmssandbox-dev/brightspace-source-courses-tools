'use strict';
require('dotenv').config();
const {MongoClient}=require('mongodb');
const {databaseConfig}=require('../src/shared/database');
const {rateLimitKey}=require('../src/shared/rateLimit');
function durationSummary(sample,totalField,samplesField){
 if(!Number.isFinite(sample[samplesField])||sample[samplesField]<=0||!Number.isFinite(sample[totalField]))return 'unknown';
 const count=sample[samplesField],total=Math.round(sample[totalField]);
 return `n=${count} total=${total}ms avg=${Math.round(total/count)}ms`;
}
function buildRows(costs){
 const categories=[
  ['localReservationQueue','localReservationQueueTotalMs','localReservationQueueSamples'],
  ['mongoReservation','mongoReservationTotalMs','mongoReservationSamples'],
  ['deniedReservationRead','deniedReservationReadTotalMs','deniedReservationReadSamples'],
  ['permitContentionWait','permitContentionWaitTotalMs','permitContentionWaitSamples'],
  ['pacingBudgetWait','pacingBudgetWaitTotalMs','pacingBudgetWaitSamples'],
  ['mixedWait','mixedWaitTotalMs','mixedWaitSamples'],
  ['completionPersistence','completionPersistenceTotalMs','completionPersistenceSamples']
 ];
 return Object.values(costs||{}).map(s=>({endpoint:s.route,requests:s.requests,measured:s.observedRequests||0,min:s.minCost??'unknown',max:s.maxCost??'unknown',average:s.observedRequests?Number((s.totalCredits/s.observedRequests).toFixed(2)):'unknown',credits:s.totalCredits||0,averageHttpMs:s.timedRequests?Math.round(s.totalLatencyMs/s.timedRequests):'unknown',averageGateWaitMs:s.timedRequests?Math.round(s.totalGateWaitMs/s.timedRequests):'unknown',maxHttpMs:s.maxLatencyMs??'unknown',...Object.fromEntries(categories.map(([label,totalField,samplesField])=>[label,durationSummary(s,totalField,samplesField)])),lastSeen:new Date(s.lastSeenAt).toISOString()}));
}
async function main(){
 const uri=process.env.MONGODB_URL;databaseConfig(uri);
 const client=new MongoClient(uri,{serverSelectionTimeoutMS:10000});
 try{
  await client.connect();
  const row=await client.db().collection('api_rate_limits').findOne({_id:rateLimitKey(process.env.BS_URL,process.env.D2L_OAUTH2_CLIENT_ID)});
  if(!row){console.log('No API measurements saved yet. Run a small workflow with the updated app first.');return;}
  console.table(buildRows(row.costs));
  console.log('429 responses:',row.rateLimitResponses||0,'Last remaining credits:',row.lastRemainingCredits??'unknown');
 }finally{await client.close();}
}
if(require.main===module)main().catch(()=>{console.error('Could not read cost measurements. Check environment and MongoDB access.');process.exitCode=1;});
module.exports={buildRows,durationSummary};

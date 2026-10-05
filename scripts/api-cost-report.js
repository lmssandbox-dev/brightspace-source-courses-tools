'use strict';
require('dotenv').config();
const {MongoClient}=require('mongodb');
const {databaseConfig}=require('../src/shared/database');
const {rateLimitKey}=require('../src/shared/rateLimit');
async function main(){
 const uri=process.env.MONGODB_URL;databaseConfig(uri);
 const client=new MongoClient(uri,{serverSelectionTimeoutMS:10000});
 try{
  await client.connect();
  const row=await client.db().collection('api_rate_limits').findOne({_id:rateLimitKey(process.env.BS_URL,process.env.D2L_OAUTH2_CLIENT_ID)});
  if(!row){console.log('No API measurements saved yet. Run a small workflow with the updated app first.');return;}
  console.table(Object.values(row.costs||{}).map(s=>({endpoint:s.route,requests:s.requests,measured:s.observedRequests||0,min:s.minCost??'unknown',max:s.maxCost??'unknown',average:s.observedRequests?Number((s.totalCredits/s.observedRequests).toFixed(2)):'unknown',credits:s.totalCredits||0,lastSeen:new Date(s.lastSeenAt).toISOString()})));
  console.log('429 responses:',row.rateLimitResponses||0,'Last remaining credits:',row.lastRemainingCredits??'unknown');
 }finally{await client.close();}
}
main().catch(()=>{console.error('Could not read cost measurements. Check environment and MongoDB access.');process.exitCode=1;});

'use strict';
require('dotenv').config();
const {MongoClient}=require('mongodb');
const {createHash}=require('node:crypto');
const {databaseConfig}=require('../src/shared/database');
async function main(){
 const uri=process.env.MONGODB_URL;databaseConfig(uri);
 if(!process.env.BS_URL||!process.env.BS_DEPLOYMENT_ID)throw Error('Missing deployment configuration');
 const namespace=createHash('sha256').update(`${process.env.BS_URL}|${process.env.BS_DEPLOYMENT_ID}`).digest('hex');
 const client=new MongoClient(uri,{serverSelectionTimeoutMS:10000});
 try{
  await client.connect();
  const jobs=await client.db().collection('bulk_date_jobs').find({namespace},{projection:{_id:1,kind:1,status:1,totals:1,performance:1,createdAt:1}}).sort({createdAt:-1}).limit(20).toArray();
  console.table(jobs.map(j=>({job:j._id,tool:j.kind,status:j.status,tasks:j.totals?.total,preparationSeconds:j.performance?.preparationMs==null?'not recorded':Math.round(j.performance.preparationMs/1000),submissionSeconds:j.performance?.submissionMs==null?'not recorded':Math.round(j.performance.submissionMs/1000),checkSeconds:j.performance?.checkMs==null?'not recorded':Math.round(j.performance.checkMs/1000),checkpointRequests:j.performance?.checkpointRequests??'not recorded',checkpoints:j.performance?.checkpoints||0,checkpointSeconds:Math.round((j.performance?.checkpointMs||0)/1000)})));
  console.log('Server-side timings only. Submission time does not include Brightspace background copy completion. Interrupted phases have no finished duration.');
 }finally{await client.close();}
}
main().catch(()=>{console.error('Could not read job timings. Check environment and MongoDB access.');process.exitCode=1;});

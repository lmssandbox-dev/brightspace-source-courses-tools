'use strict';
require('dotenv').config();
const {MongoClient}=require('mongodb');
const {createHash}=require('node:crypto');
const {databaseConfig}=require('../src/shared/database');
const {formatDeploymentStep3Report}=require('../src/replication/step3UtilizationReport');

async function main(){
 const uri=process.env.MONGODB_URL;databaseConfig(uri);
 if(!process.env.BS_URL||!process.env.BS_DEPLOYMENT_ID)throw Error('Missing deployment configuration');
 const namespace=createHash('sha256').update(`${process.env.BS_URL}|${process.env.BS_DEPLOYMENT_ID}`).digest('hex');
 const client=new MongoClient(uri,{serverSelectionTimeoutMS:10000});
 try{
  await client.connect();
  const jobs=client.db().collection('bulk_date_jobs');
  const projection={_id:1,kind:1,status:1,buildSha:1,createdAt:1,'performance.deploymentStep3Utilization':1};
  const requestedId=process.argv[2];
  let job;
  if(requestedId)job=await jobs.findOne({_id:requestedId,namespace,kind:'sourceDeployment'},{projection});
  else job=await jobs.find({namespace,kind:'sourceDeployment','performance.deploymentStep3Utilization.version':1},{projection}).sort({createdAt:-1}).limit(1).next();
  if(!job&&!requestedId)job=await jobs.find({namespace,kind:'sourceDeployment'},{projection}).sort({createdAt:-1}).limit(1).next();
  if(!job){console.log(requestedId?'Source Deployer job not found.':'No Source Deployer jobs found.');return;}
  console.log(formatDeploymentStep3Report(job));
 }finally{await client.close();}
}
main().catch(()=>{console.error('Could not read Source Deployer Step 3 measurements. Check environment and MongoDB access.');process.exitCode=1;});

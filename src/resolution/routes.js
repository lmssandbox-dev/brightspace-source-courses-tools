'use strict';
const {createHmac,timingSafeEqual}=require('node:crypto');
const {logFailure}=require('../shared/diagnostics');
function createSyncControls({store,sync,secret,deploymentId,now=Date.now}){
 const authorized=res=>Boolean(deploymentId&&res.locals.token?.deploymentId===deploymentId&&typeof res.locals.token?.user==='string'&&res.locals.token.user&&res.locals.ltik);
 const signature=(res,expires)=>createHmac('sha256',secret).update(JSON.stringify(['org-directory-sync',res.locals.ltik,res.locals.token.user,deploymentId,expires])).digest('hex');
 function ticket(res){if(!authorized(res))return '';const expires=now()+2*3600000;return expires+'.'+signature(res,expires);}
 async function request(req,res){
  res.set('Cache-Control','no-store');
  if(!authorized(res))return res.status(403).json({state:'unauthorized'});
  const value=typeof req.body?.ticket==='string'?req.body.ticket:'',match=/^(\d{13})\.([a-f0-9]{64})$/.exec(value);
  if(!match||Number(match[1])<=now()||!timingSafeEqual(Buffer.from(match[2],'hex'),Buffer.from(signature(res,Number(match[1])),'hex')))return res.status(403).json({state:'expired'});
  try{
   const state=await store.requestSync();
   if(state==='queued')void sync.tick();
   return res.status(state==='cooldown'?429:202).json({state});
  }catch(error){logFailure('org_directory_request_failed',error);return res.status(503).json({state:'unavailable'});}
 }
 return {ticket,request};
}
module.exports={createSyncControls};

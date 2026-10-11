'use strict';
const {createHmac,timingSafeEqual}=require('node:crypto');
const {deploymentGuard}=require('../shared/deploymentGuard');
const {logFailure}=require('../shared/diagnostics');
const COOLDOWN_MS=5*60*1000;
function createApiHealthRoutes({service,view,secret,deploymentId,versions,inventory,minimums,now=Date.now,cooldownMs=COOLDOWN_MS}){
 if(!secret)throw new Error('API health actions require the configured application key.');
 const guard=deploymentGuard(deploymentId);let lastRequestedAt=0;
 function setNavigationRisk(res,result){if(res.app?.locals)res.app.locals.apiHealthRisk=['critical','at_risk'].includes(result?.assessment?.status)?result.assessment.status:'unknown';}
 function wantsHtml(req){return typeof req.get==='function'&&String(req.get('accept')||'').includes('text/html');}
 const session=res=>createHmac('sha256',secret).update(String(res.locals.ltik)).digest('hex');
 function ticket(res){const expires=now()+30*60*1000,data=Buffer.from(JSON.stringify({session:session(res),user:res.locals.token.user,deploymentId,expires})).toString('base64url');return `${data}.${createHmac('sha256',secret).update(data).digest('hex')}`;}
 function valid(res,value){try{const [data,sig]=String(value||'').split('.'),expected=createHmac('sha256',secret).update(data).digest('hex');if(!sig||sig.length!==expected.length||!timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return false;const payload=JSON.parse(Buffer.from(data,'base64url'));return payload.session===session(res)&&payload.user===res.locals.token.user&&payload.deploymentId===deploymentId&&payload.expires>now();}catch{return false;}}
 function authorized(req,res){res.set('Cache-Control','no-store');res.set('Referrer-Policy','no-referrer');if(!guard(res.locals.token,req,res))return false;if(!res.locals.ltik||typeof res.locals.token?.user!=='string'||!res.locals.token.user)return res.status(403).json({state:'unauthorized'}),false;if(!valid(res,req.body?.ticket))return res.status(403).json({state:'expired'}),false;return true;}
 async function check(req,res){if(!authorized(req,res))return;let state='failed',current;
  try{
   const requested=now();
   if(lastRequestedAt&&requested-lastRequestedAt<cooldownMs){state='cooldown';current=await service.getLatest();}
   else {lastRequestedAt=requested;const result=await service.checkNow();state=result?.state==='already_running'?'running':result?.state==='success'?'success':'failed';current=await service.getLatest();}
   setNavigationRisk(res,current);const html=view.render(current,{inventory,minimums,versions,checkTicket:ticket(res),ltik:res.locals.ltik,checkState:state});
   if(wantsHtml(req))return res.status(state==='cooldown'?429:200).send(html);
   return res.status(state==='cooldown'?429:200).json({state,html});
  }catch(error){logFailure('api_health_check_request_failed',error,{kind:'apiHealth',action:'check'});try{current=await service.getLatest();}catch{current={state:'unavailable',assessment:null};}const html=view.render(current,{inventory,minimums,versions,checkTicket:ticket(res),ltik:res.locals.ltik,checkState:'failed'});if(wantsHtml(req))return res.status(200).send(html);return res.status(200).json({state:'failed',html});}
 }
 function render(res,result,checkState=null){setNavigationRisk(res,result);return view.render(result,{inventory,minimums,versions,checkTicket:ticket(res),ltik:res.locals.ltik,checkState});}
 return {check,ticket,render};
}
module.exports={createApiHealthRoutes,COOLDOWN_MS};

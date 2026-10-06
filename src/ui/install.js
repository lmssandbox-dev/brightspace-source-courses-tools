'use strict';
const path=require('node:path');
const {normalizeLanguage}=require('./i18n');
const {page,escape}=require('./page');
function installUi(lti,{shell=true}={}){
 for(const name of ['app.js','app.css']){
  const route=`/assets/${name}`;
  lti.whitelist({route,method:'get'});
  lti.app.get(route,(req,res)=>{res.set('Cache-Control','public, max-age=0, must-revalidate');res.sendFile(path.join(__dirname,'../../public/assets',name));});
 }
 if(shell)installPageShell(lti.app);
}
function installPageShell(app){
 app.use((req,res,next)=>{
  const send=res.send.bind(res);
  res.send=body=>{
   const type=String(res.getHeader('Content-Type')||'');
   if(typeof body==='string'&&(!type||type.includes('text/html'))&&req.path!=='/ping'&&!req.path.startsWith('/assets/')){
    res.set('Cache-Control','no-store');res.set('Referrer-Policy','no-referrer');
    const section=req.path.endsWith('/history')?'history':req.path.startsWith('/copy')?'copy':req.path.startsWith('/deploy')?'replication':'dates';
    body=page(body.trimStart().startsWith('<')?body:`<section class="panel"><h1>Unable to continue</h1><p>${escape(body)}</p><p>Return to Workspace or relaunch from Brightspace to continue.</p></section>`,{ltik:res.locals.ltik,section,language:normalizeLanguage(req.body?.uiLanguage),syncTicket:app.locals?.orgSyncTicket?.(res)||'',launchLoading:req.path==='/'});
   }
   return send(body);
  };
  next();
 });
}
module.exports={installUi,installPageShell};

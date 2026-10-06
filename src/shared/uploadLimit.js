'use strict';
const express=require('express');
function installDateUploadLimit(app){
 // ltijs 5.9.9 installs its 100 KB parser before serverAddon. Replace that
 // parser in place so LTI still reads and authenticates the parsed ltik.
 const layer=app._router?.stack.find(layer=>layer.name==='urlencodedParser');
 if(!layer)throw Error('Cannot configure the date-upload parser for this ltijs version.');
 const original=layer.handle;
 // Percent encoding can triple the 5 MB CSV size; allow bounded form overhead.
 const larger=express.urlencoded({extended:false,limit:16*1024*1024,parameterLimit:100});
 layer.handle=(req,res,next)=>req.method==='POST'&&['/bulk/preview','/deploy/preview','/copy/preview'].includes(req.path)?larger(req,res,next):original(req,res,next);
}
module.exports={installDateUploadLimit};

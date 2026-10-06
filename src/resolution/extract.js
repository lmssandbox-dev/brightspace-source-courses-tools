'use strict';
const fs=require('node:fs');
const {mkdtemp,rm}=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {Transform}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const {crc32}=require('node:zlib');
const yauzl=require('yauzl');
const {parse}=require('csv-parse');
const {id}=require('../shared/id');
const fail=code=>Object.assign(Error('Organizational Units extract could not be imported'),{code});
const MAX_ZIP=256*1024*1024,MAX_CSV=512*1024*1024;
function limitBytes(max){let size=0;return new Transform({transform(chunk,enc,done){size+=chunk.length;done(size>max?fail('DATASET_TOO_LARGE'):null,chunk);}});}
function safeDownload(value,baseUrl,initial=false){
 const url=new URL(value),base=new URL(baseUrl);
 if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port&&url.port!=='443'||url.hostname==='localhost'||url.hostname.endsWith('.localhost')||/^\[|^\d+(\.\d+){3}$/.test(url.hostname))throw fail('DATASET_DOWNLOAD_URL');
 if(initial&&(url.origin!==base.origin||!url.pathname.startsWith('/d2l/api/')))throw fail('DATASET_DOWNLOAD_URL');
 return url.href;
}
// Only the first, tenant API request gets a bearer token. Signed redirects never do.
function createExtractReader({http,downloadHttp,oauth,baseUrl}){
 return async function readExtract(extract,consume){
  if(extract.DownloadSize>MAX_ZIP)throw fail('DATASET_TOO_LARGE');
  const directory=await mkdtemp(path.join(os.tmpdir(),'org-directory-'));
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10*60*1000);timer.unref?.();
  try{
   let url=safeDownload(extract.DownloadLink,baseUrl,true),response;
   for(let redirect=0;redirect<=3;redirect++){
    const headers=redirect===0?{Authorization:`Bearer ${await oauth.getAccessToken()}`} : {};
    response=await (redirect===0?http:downloadHttp)({method:'GET',url,headers,responseType:'stream',timeout:30000,maxRedirects:0,signal:controller.signal,validateStatus:s=>s===200||s===302});
    if(response.status===200)break;
    response.data?.destroy();
    if(redirect===3)throw fail('DATASET_REDIRECT_LIMIT');
    url=safeDownload(new URL(response.headers.location,url).href,baseUrl);
   }
   const file=path.join(directory,'extract.zip');
   await pipeline(response.data,limitBytes(MAX_ZIP),fs.createWriteStream(file,{flags:'wx',mode:0o600}),{signal:controller.signal});
   await readZip(file,consume,controller.signal);
  }finally{clearTimeout(timer);await rm(directory,{recursive:true,force:true});}
 };
}
async function readZip(file,consume,signal){
 const zip=await new Promise((resolve,reject)=>yauzl.open(file,{lazyEntries:true,autoClose:false,validateEntrySizes:true},(e,z)=>e?reject(e):resolve(z)));
 try{
  const entries=await new Promise((resolve,reject)=>{const csv=[];let total=0;
   zip.on('error',reject);zip.on('end',()=>resolve(csv));zip.on('entry',entry=>{
    if(++total>20||entry.isEncrypted()||entry.uncompressedSize>MAX_CSV){reject(fail('DATASET_ZIP_INVALID'));return;}
    if(/\.csv$/i.test(entry.fileName))csv.push(entry);zip.readEntry();
   });zip.readEntry();
  });
  if(entries.length!==1)throw fail('DATASET_CSV_COUNT');
  const entry=entries[0],stream=await new Promise((resolve,reject)=>zip.openReadStream(entry,(e,s)=>e?reject(e):resolve(s)));
  let checksum=0,bytes=0;
  const verify=new Transform({transform(chunk,enc,done){checksum=crc32(chunk,checksum);bytes+=chunk.length;done(bytes>MAX_CSV?fail('DATASET_TOO_LARGE'):null,chunk);},flush(done){done(checksum!==entry.crc32||bytes!==entry.uncompressedSize?fail('DATASET_ZIP_CHECKSUM'):null);}});
  const parser=parse({bom:true,skip_empty_lines:true,max_record_size:65536,columns:headers=>{
   if(new Set(headers).size!==headers.length||!['OrgUnitId','Code','Name','Type','IsDeleted'].every(h=>headers.includes(h)))throw fail('DATASET_HEADERS');return headers;
  }});
  let count=0;
  await pipeline(stream,verify,parser,async source=>{for await(const row of source){if(++count>1000000)throw fail('DATASET_ROW_LIMIT');await consume(row);}},{signal});
  return count;
 }finally{zip.close();}
}
function normalize(row,observedAt){
 const invalid=(field,reason)=>{throw Object.assign(fail('DATASET_ROW_INVALID'),{datasetField:field,datasetReason:reason});};
 const flag=String(row.IsDeleted??'').trim().toLowerCase();
 if(!['','0','1','true','false'].includes(flag))invalid('IsDeleted','unsupported_boolean');
 const text=(field,max,nullable=false)=>{
  const value=nullable&&row[field]==null?'':row[field];
  if(typeof value!=='string')invalid(field,'not_text');
  if(value.length>max)invalid(field,'too_long');
  return value;
 };
 const code=text('Code',512,true),name=text('Name',1024,true),type=text('Type',512);
 // Type is descriptive metadata, not authorization. Empty labels do not change ID/code identity.
 // Dates are historical; an explicit false flag takes precedence for restored units.
 const deleted=flag==='1'||flag==='true'||flag===''&&Boolean(row.DeletedDate||row.RecycledDate);
 let identifier;try{identifier=id(row.OrgUnitId);}catch{invalid('OrgUnitId','invalid_id');}
 return {Identifier:identifier,Code:code,Name:name,Type:{Code:type},deleted,observedAt};
}

module.exports={createExtractReader,readZip,normalize,safeDownload,fail};

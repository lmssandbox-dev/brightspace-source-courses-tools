'use strict';
const catalogs={en:require('./locales/en.json'),'es-419':require('./locales/es-419.json'),'pt-BR':require('./locales/pt-BR.json')};
function normalizeLanguage(value){return Object.hasOwn(catalogs,value)?value:'en';}
const patterns=Object.keys(catalogs.en).filter(key=>key.includes('{0}')).map(key=>{
 const escaped=key.replace(/[.*+?^$()|[\]\\]/g,'\\$&');
 return {key,regex:new RegExp('^'+escaped.replace(/\{\d+\}/g,'(.+?)')+'$','u')};
});
function translate(text,language='en'){
 const lang=normalizeLanguage(language),value=String(text??'');if(lang==='en')return value;
 const trimmed=value.trim();let translated=catalogs[lang][trimmed];
 if(translated===undefined)for(const {key,regex} of patterns){const match=trimmed.match(regex);if(match){translated=catalogs[lang][key].replace(/\{(\d+)\}/g,(_,n)=>match[Number(n)+1]);break;}}
 return translated===undefined?value:value.slice(0,value.length-value.trimStart().length)+translated+value.slice(value.trimEnd().length);
}
// Translate only exported headings. Names, identifiers, raw logs and machine statuses stay intact.
function translateReport(csv,language){
 const lang=normalizeLanguage(language);if(lang==='en')return csv;
 const end=csv.indexOf('\r\n'),header=end<0?csv:csv.slice(0,end);
 return header.replace(/"((?:[^"]|"")*)"/g,(_,label)=>'"'+translate(label.replace(/""/g,'"'),lang).replace(/"/g,'""')+'"')+(end<0?'':csv.slice(end));
}
module.exports={translate,translateReport,normalizeLanguage,catalogs};

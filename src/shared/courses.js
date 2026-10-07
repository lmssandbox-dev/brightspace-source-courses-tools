'use strict';
const { id } = require('./id');
function createCoursesClient({ api, baseUrl, lpVersion, sourceClient, orgResolver }) {
  const root = /^\d+\.\d+$/.test(lpVersion || '') ? `${baseUrl.replace(/\/$/,'')}/d2l/api/lp/${lpVersion}` : null;
  function configured() { if (!root) throw new Error('Configure D2L_LP_VERSION for Course Offering validation.'); }
  return {
    prepare:(rows,check)=>orgResolver?.prepare(rows.map(r=>r.orgUnitCode),check),
    async get(orgUnitId) {
      configured();orgUnitId=id(orgUnitId);
      // This endpoint returns 404 for non-Course-Offering org units.
      let row;
      try {row=await api.read(`${root}/courses/${orgUnitId}`);}catch(error){if(error.status===404 && sourceClient)return sourceClient.source(orgUnitId);throw error;}
      if (id(row.Identifier)!==orgUnitId || typeof row.Name!=='string' || (row.Code!==null && typeof row.Code!=='string')) throw new Error('Invalid Course Offering response.');
      return {orgUnitId,name:row.Name,code:row.Code};
    },
    async resolve(row,{cache=new Map(),resolver,check}={}) {
      const cached=(key,load)=>{if(!cache.has(key))cache.set(key,Promise.resolve().then(load));return cache.get(key);};
      
      configured();
      if (row.orgUnitId && !row.orgUnitCode) return {orgUnitId:id(row.orgUnitId),name:'',code:null};
      const url = new URL(`${root}/orgstructure/`);
      url.searchParams.set('exactOrgUnitCode',row.orgUnitCode);
      await check?.();
      const matches = await cached(`code:${row.orgUnitCode}`,()=>resolver?resolver.resolve(row.orgUnitCode,check).then(r=>[r]):api.list(url.href));
      // Never silently select one of multiple matches or infer that a numeric code is an ID.
      const ids=[...new Set(matches.filter(r=>r.Code===row.orgUnitCode).map(r=>id(r.Identifier)))];
      if(ids.length!==1) throw new Error(ids.length?'Course code is ambiguous.':'Course code was not found.');
      if(row.orgUnitId && id(row.orgUnitId)!==ids[0])throw Object.assign(new Error('ID and code identify different org units.'),{code:'ID_CODE_MISMATCH'});
      const match=matches.find(r=>id(r.Identifier)===ids[0]);
      return {orgUnitId:ids[0],name:typeof match.Name==='string'?match.Name:'',code:row.orgUnitCode};
    }
  };
}
module.exports={createCoursesClient};

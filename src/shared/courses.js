'use strict';
const { id } = require('./id');
function createCoursesClient({ api, baseUrl, lpVersion, sourceClient }) {
  const root = /^\d+\.\d+$/.test(lpVersion || '') ? `${baseUrl.replace(/\/$/,'')}/d2l/api/lp/${lpVersion}` : null;
  function configured() { if (!root) throw new Error('Configure D2L_LP_VERSION for Course Offering validation.'); }
  return {
    async get(orgUnitId) {
      configured();orgUnitId=id(orgUnitId);
      // This endpoint returns 404 for non-Course-Offering org units.
      let row;
      try {row=await api.read(`${root}/courses/${orgUnitId}`);}catch(error){if(error.status===404 && sourceClient)return sourceClient.source(orgUnitId);throw error;}
      if (id(row.Identifier)!==orgUnitId || typeof row.Name!=='string' || (row.Code!==null && typeof row.Code!=='string')) throw new Error('Invalid Course Offering response.');
      return {orgUnitId,name:row.Name,code:row.Code};
    },
    async resolve(row,{cache=new Map()}={}) {
      const cached=(key,load)=>{if(!cache.has(key))cache.set(key,Promise.resolve().then(load));return cache.get(key);};
      const get=value=>cached(`id:${value}`,()=>this.get(value));
      configured();
      if (row.orgUnitId && !row.orgUnitCode) return get(row.orgUnitId);
      const url = new URL(`${root}/orgstructure/`);
      url.searchParams.set('exactOrgUnitCode',row.orgUnitCode);
      const matches = await cached(`code:${row.orgUnitCode}`,()=>api.list(url.href));
      // Never silently select one of multiple matches or infer that a numeric code is an ID.
      const ids=[...new Set(matches.filter(r=>r.Code===row.orgUnitCode).map(r=>id(r.Identifier)))];
      if(ids.length!==1) throw new Error(ids.length?'Course code is ambiguous.':'Course code was not found.');
      if(row.orgUnitId && id(row.orgUnitId)!==ids[0])throw Object.assign(new Error('ID and code identify different org units.'),{code:'ID_CODE_MISMATCH'});
      const course=await get(ids[0]);
      if(course.code!==row.orgUnitCode) throw new Error('Course code changed during validation.');
      return course;
    }
  };
}
module.exports={createCoursesClient};

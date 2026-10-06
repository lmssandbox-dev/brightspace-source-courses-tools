'use strict';
const { parse } = require('csv-parse/sync');
const { id } = require('../shared/id');
const invalid = message => Object.assign(new Error(message), {code:'INVALID_CSV'});
const MAX_ROWS = 10000, MAX_BYTES = 5 * 1024 * 1024;
function parseCourseCsv(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) throw invalid('CSV must be UTF-8 text, at most 5 MB.');
  let records;
  try { records = parse(text, { bom:true, trim:true, relax_column_count:true, skip_empty_lines:false, info:true, max_record_size:MAX_BYTES }); }
  catch { throw invalid('Malformed CSV. Check quotes and comma-separated columns.'); }
  const header = records.shift()?.record;
  if (!header || header.length !== 2 || new Set(header).size !== 2 || !header.includes('OrgUnitId') || !header.includes('OrgUnitCode')) {
    throw invalid('CSV headers must be OrgUnitId,OrgUnitCode.');
  }
  if (records.length > MAX_ROWS) throw invalid('CSV supports at most 10,000 data rows.');
  const seen = new Map();
  const rows = records.map(({record,info}) => {
    const row = { row:info.lines, orgUnitId:'', orgUnitCode:'', status:'pending' };
    if (record.every(v=>!v.trim())) return {...row,status:'ignored',message:'Blank row ignored.'};
    if (record.length !== 2) return {...row,status:'invalid',message:'Expected two columns.'};
    row.orgUnitId = record[header.indexOf('OrgUnitId')].trim();
    row.orgUnitCode = record[header.indexOf('OrgUnitCode')].trim();
    if (!row.orgUnitId && !row.orgUnitCode) return {...row,status:'invalid',message:'Supply an ID, a code, or a matching ID/code pair.'};
    try { if (row.orgUnitId) row.orgUnitId = id(row.orgUnitId); }
    catch { return {...row,status:'invalid',message:'ID must be a positive decimal integer.'}; }
    if (row.orgUnitCode.length > 50 || /[\r\n\x00-\x1f]/.test(row.orgUnitCode)) return {...row,status:'invalid',message:'Invalid course code.'};
    const key = JSON.stringify([row.orgUnitId,row.orgUnitCode]);
    if (seen.has(key)) return {...row,status:'duplicate',duplicateOf:seen.get(key),message:'Repeated input; processed once.'};
    seen.set(key,row.row);return row;
  });
  if (!rows.some(r=>['pending','invalid'].includes(r.status))) throw invalid('CSV must contain at least one valid course identifier.');
  return rows;
}
module.exports = { parseCourseCsv, MAX_ROWS, MAX_BYTES };

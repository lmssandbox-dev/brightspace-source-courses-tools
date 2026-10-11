'use strict';

const HEADERS=['Full Name','User Org Code','User ID'];
function values(job) {
  const creator=job?.createdBy||{};
  return [creator.fullName,creator.orgDefinedId,creator.userId];
}
function append(rows,job) {
  if(!rows.length)return rows;
  rows[0].push(...HEADERS);
  const identity=values(job);
  for(let i=1;i<rows.length;i++)rows[i].push(...identity);
  return rows;
}
module.exports={HEADERS,values,append};

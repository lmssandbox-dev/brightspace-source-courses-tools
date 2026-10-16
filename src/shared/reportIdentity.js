'use strict';

const HEADERS=['User Full Name','User Org Defined ID','User Email'];
function values(job) {
  const creator=job?.createdBy||{};
  return [creator.fullName,creator.orgDefinedId,creator.email];
}
function append(rows,job) {
  if(!rows.length)return rows;
  rows[0].push(...HEADERS);
  const identity=values(job);
  for(let i=1;i<rows.length;i++)rows[i].push(...identity);
  return rows;
}
module.exports={HEADERS,values,append};

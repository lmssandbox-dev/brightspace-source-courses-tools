'use strict';

const MAX_IDENTITY_LENGTH=256;
function safeString(value) {
  if(typeof value!=='string')return '';
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').trim().slice(0,MAX_IDENTITY_LENGTH);
}
function extractLtiIdentity(token) {
  // ltijs mounts only validated claims in this projection of the launch token.
  const userInfo=token?.userInfo||{};
  const explicit=safeString(userInfo.name);
  const fullName=explicit||[userInfo.given_name,userInfo.family_name]
    .map(safeString).filter(Boolean).join(' ').slice(0,MAX_IDENTITY_LENGTH);

  // ltijs does not expose a verified Brightspace Org Defined ID or numeric
  // Brightspace User ID claim in its validated platform token projection.
  // In particular, token.user is the LTI subject and is not treated as either.
  return {fullName,orgDefinedId:'',userId:''};
}
module.exports={extractLtiIdentity,safeString};

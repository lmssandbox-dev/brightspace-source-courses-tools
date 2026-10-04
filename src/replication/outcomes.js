 'use strict';
function targetStatus(task,target){
 const status=task.result?.targets?.find(r=>r.orgUnitId===target.orgUnitId)?.status||task.result?.status;
 if(['submitted','failed','uncertain'].includes(status))return status;
 return 'notAttempted';
}
function canActivateTarget(task,target){return Boolean(target.deactivation)&&['submitted','uncertain'].includes(targetStatus(task,target));}
module.exports={targetStatus,canActivateTarget};

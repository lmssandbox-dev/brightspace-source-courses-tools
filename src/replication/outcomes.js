 'use strict';
function targetStatus(task,target){
 const status=task.result?.targets?.find(r=>r.orgUnitId===target.orgUnitId)?.status||task.result?.status;
 if(['submitted','failed','uncertain'].includes(status))return status;
 return 'notAttempted';
}
function canActivateTarget(task,target){return Boolean(target.deactivation)&&['submitted','uncertain'].includes(targetStatus(task,target));}
function reservesCourses(task){
 const result=task.result,status=result?.error?.httpStatus;
 // Explicit client-error rejection means no copy was initiated. Preparation
 // alone must not permanently reserve courses after this definitive outcome.
 const rejected=result?.status==='failed'&&Number.isInteger(status)&&status>=400&&status<500;
 const unresolvedTargets=result?.targets?.some(r=>['submitted','uncertain','running'].includes(r.status));
 if(rejected&&!unresolvedTargets&&!result.deploymentId&&!task.targets.some(r=>r.activation))return false;
 return task.targets.some(r=>r.deactivation)||Boolean(result?.writeAttempted&&!['failed','skipped'].includes(result.status));
}
module.exports={targetStatus,canActivateTarget,reservesCourses};

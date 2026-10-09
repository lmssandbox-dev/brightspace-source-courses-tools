'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildReport,readGateState,routeFamily,summarizePermits}=require('../scripts/api-gate-state-report');

const routes={
 folders:'GET /d2l/api/le/1.0/:id/dropbox/folders/',
 quizzes:'GET /d2l/api/le/1.0/:id/quizzes/',
 forums:'GET /d2l/api/le/1.0/:id/discussions/forums/',
 topics:'GET /d2l/api/le/1.0/:id/discussions/forums/:id/topics/'
};
test('recognizes only normalized stored Date Manager discovery route families',()=>{
 assert.equal(routeFamily(routes.folders),'Assignment folders');assert.equal(routeFamily(routes.quizzes),'Quizzes');assert.equal(routeFamily(routes.forums),'Discussion forums');assert.equal(routeFamily(routes.topics),'Discussion topics');
 assert.equal(routeFamily('GET /d2l/api/le/1.0/123/quizzes/'),null);assert.equal(routeFamily('GET /d2l/api/le/1.0/:id/quizzes/4'),null);
});

test('builds derived gate state from stored values without exposing permit tokens or hashed keys',()=>{
 const now=100000,row={nextAt:now+500,pauseUntil:now-1,adaptiveSpacing:900,budgetStart:now-30000,budgetUsed:29900,lastRemainingCredits:12000,lastResetMs:7000,
  permits:[{token:'secret1',until:now+4000},{token:'secret2',until:now+5000,dateDiscovery:true},{token:'expired',until:now-100}],
  costs:{hash1:{route:routes.folders,maxCost:100,fallbackCost:125},hash2:{route:routes.quizzes,maxCost:600,fallbackCost:700},hash3:{route:'GET /d2l/api/le/1.0/:id/import/:id/copy/',maxCost:5}}};
 const report=buildReport(row,now);assert.equal(report.gate.nextAtPreventingAdmission,true);assert.equal(report.gate.cooldownActive,false);assert.equal(report.gate.budgetWindowActive,true);assert.equal(report.gate.localBudgetAppearsExhausted,true);assert.equal(report.gate.adaptiveSpacingExceedsKnownRouteMinimum,true);
 assert.deepEqual(report.routes.map(r=>r.family),['Assignment folders','Quizzes']);assert.equal(report.routes[0].estimatedReservationCost,125);assert.equal(report.routes[1].estimatedReservationCost,700);
 assert.deepEqual({active:report.permits.active,expired:report.permits.expired,ordinary:report.permits.ordinary,elevated:report.permits.elevated},{active:2,expired:1,ordinary:1,elevated:1});assert.equal(report.permits.earliest,now+4000);assert.equal(report.permits.latest,now+5000);
 const text=JSON.stringify(report);assert.ok(!text.includes('secret1'));assert.ok(!text.includes('hash1'));
});

test('legacy fields and missing documents are handled without false positive states',()=>{
 assert.equal(buildReport(null,100).found,false);const report=buildReport({permits:[]},100);
 assert.equal(report.gate.nextAtPreventingAdmission,null);assert.equal(report.gate.cooldownActive,null);assert.equal(report.gate.localBudgetAppearsExhausted,null);assert.equal(report.gate.adaptiveSpacingExceedsKnownRouteMinimum,null);assert.deepEqual(report.routes,[]);
 assert.equal(buildReport({budgetStart:90,budgetUsed:29999,costs:{}},100).gate.localBudgetAppearsExhausted,null);
 assert.equal(summarizePermits(undefined,100).available,false);
});

test('gate state read performs exactly one projected document lookup',async()=>{
 let calls=0,args;const collection={findOne:async(...values)=>{calls++;args=values;return {nextAt:1};}};
 const row=await readGateState(collection,'hashed-key');assert.deepEqual(row,{nextAt:1});assert.equal(calls,1);assert.deepEqual(args,[{_id:'hashed-key'},{projection:{_id:0,nextAt:1,pauseUntil:1,adaptiveSpacing:1,budgetStart:1,budgetUsed:1,lastRemainingCredits:1,lastResetMs:1,'permits.until':1,'permits.resolution':1,'permits.copy':1,'permits.dateDiscovery':1,costs:1}}]);
});

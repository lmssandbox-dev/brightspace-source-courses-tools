'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {logMongoOperationFailure}=require('../src/shared/diagnostics');
function captureLogs(t){const lines=[],original=console.error;console.error=(line)=>lines.push(line);t.after(()=>{console.error=original;});return lines;}

test('Mongo conflict diagnostics keep structural paths and redact route hashes',t=>{
 const lines=captureLogs(t),routeHash='a'.repeat(64),error=Object.assign(new Error(`Updating the path 'costs.${routeHash}.fallbackCost' would create a conflict at 'costs.${routeHash}'`),{name:'MongoServerError',code:40,codeName:'ConflictingUpdateOperators'});
 logMongoOperationFailure('api_gate_completion',error);
 assert.equal(lines.length,1);const event=JSON.parse(lines[0]);
 assert.equal(event.event,'mongodb_operation_failed');assert.equal(event.operation,'api_gate_completion');assert.equal(event.error,'MongoServerError');assert.equal(event.code,40);assert.equal(event.codeName,'ConflictingUpdateOperators');
 assert.equal(event.message,"Updating the path 'costs.<routeHash>.fallbackCost' would create a conflict at 'costs.<routeHash>'");assert.ok(!lines[0].includes(routeHash));assert.ok(Number.isFinite(Date.parse(event.time)));
});

test('unsafe Mongo messages are omitted and diagnostic failures never escape',t=>{
 const lines=captureLogs(t);
 logMongoOperationFailure('planning_metadata_save',Object.assign(new Error('duplicate key value contains a secret value'),{name:'MongoServerError',code:11000,codeName:'DuplicateKey'}));
 logMongoOperationFailure('job_checkpoint_save',Object.assign(new Error("Updating the path 'users.alice@example.test' would create a conflict at 'users'"),{name:'MongoServerError',code:40}));
 logMongoOperationFailure('unapproved_operation',Object.assign(new Error('ignored'),{name:'MongoServerError',code:40}));
 assert.equal(lines.length,2);assert.equal(JSON.parse(lines[0]).message,undefined);assert.equal(JSON.parse(lines[1]).message,"Updating the path '<redacted>.<redacted>.<redacted>' would create a conflict at '<redacted>'");assert.ok(!lines[1].includes('alice@example.test'));
 const original=console.error;console.error=()=>{throw Error('logger failed');};t.after(()=>{console.error=original;});
 assert.doesNotThrow(()=>logMongoOperationFailure('api_gate_completion',Object.assign(new Error('safe'),{name:'MongoNetworkError'})));
});

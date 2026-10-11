'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {validateActivityTypes,validateRules,resolveActivity}=require('../src/dates/schedulingRules');

const rule=(id,pattern,method='contains')=>({id,label:id,pattern,method,dates:{start:'2027-01-01T00:00:00Z',due:'2027-01-02T00:00:00Z',end:'2027-01-02T00:00:00Z'}});
test('rule validation trims patterns, limits supported methods, and preserves valid UTC schedules',()=>{
 const rules=validateRules([rule('week1','  W01 -  ','startsWith')]);
 assert.equal(rules[0].pattern,'W01 -');assert.equal(rules[0].dates.due,'2027-01-02T00:00:00.000Z');
 assert.throws(()=>validateRules([rule('bad','x','regex')]),{code:'INVALID_SCHEDULING_RULES'});
 assert.throws(()=>validateRules([{...rule('bad','x'),dates:{...rule('bad','x').dates,due:'2026-12-31T00:00:00Z'}}]),{code:'INVALID_DATES'});
});
test('resolver matches contains and startsWith case-insensitively and deterministically',()=>{
 const rules=validateRules([rule('w1','W01 -','startsWith'),rule('essay','Essay','contains')]);
 assert.equal(resolveActivity({type:'assignment',name:'w01 - Assignment A'},rules).rule.id,'w1');
 assert.equal(resolveActivity({type:'quiz',name:'Final ESSAY quiz'},rules).rule.id,'essay');
 assert.equal(resolveActivity({type:'assignment',name:'Week 2 task'},rules).status,'unmatched');
});
test('resolver excludes unselected types, detects overlaps, and requires a nonempty valid type set',()=>{
 const rules=validateRules([rule('a','quiz'),rule('b','final')]);
 assert.deepEqual(resolveActivity({type:'quiz',name:'Final quiz'},rules).ruleIds,['a','b']);
 assert.equal(resolveActivity({type:'discussionTopic',name:'Final quiz'},rules,['assignment']).reason,'unselected');
 assert.deepEqual(validateActivityTypes(['assignment','quiz','assignment']),['assignment','quiz']);
 assert.throws(()=>validateActivityTypes([]),{code:'INVALID_ACTIVITY_TYPES'});
});

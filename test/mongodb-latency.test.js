'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {measure}=require('../scripts/mongodb-latency-report');
test('latency diagnostic only connects and sends ping, with no identifying output',async()=>{
 let now=0,count=0;const client={connect:async()=>{now+=100;},db:()=>({command:async command=>{assert.deepEqual(command,{ping:1});count++;now+=count*10;}})};
 const result=await measure(client,{clock:()=>now});assert.deepEqual(result,{samples:8,connectMs:100,minPingMs:10,medianPingMs:45,maxPingMs:80});assert.equal(count,8);
});

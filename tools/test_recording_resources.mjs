import test from 'node:test';import assert from 'node:assert/strict';
import {resourcePlan,ownedCommand} from './recording_resources.mjs';
test('recording uses one global CPU and memory budget',()=>{
 for(const cpus of [1,4,16])for(const gib of [1,4,32])for(const concurrency of [1,3,100])for(const jobs of [1,3,9]){
  const p=resourcePlan({concurrency,jobs},{cpus,memory:gib*1024**3});assert(p.songs*p.jobs<=p.budget);assert(p.budget<=cpus);assert(p.jobs<=3);
 }
 assert.deepEqual(resourcePlan({'resource-mode':'quiet',concurrency:9,jobs:3}),{budget:1,songs:1,jobs:1});
});
test('cleanup matches executable, exact owned profile and exact port',()=>{
 const executable='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',profile='/tmp/task profile',port=9222;
 const command=executable+' --user-data-dir='+profile+' --remote-debugging-port='+port+' about:blank';
 assert(ownedCommand(command,executable,profile,port));
 for(const altered of [command.replace('9222','92222'),command.replace(profile,profile+'-other'),command.replace('Google Chrome.app','Other.app')])assert.equal(ownedCommand(altered,executable,profile,port),false);
 assert.equal(ownedCommand(command,executable,'',port),false);
});

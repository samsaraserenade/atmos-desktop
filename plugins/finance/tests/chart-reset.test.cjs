const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const code=fs.readFileSync(__dirname+'/../src/chart-reset.js','utf8').replace('export ','');
let handler, options, resized=0;
const context=vm.createContext({});vm.runInContext(code,context);
context.bindChartResetMeasurement({},()=>({resize(){resized++;}}),{listen(surface,type,fn,opts){assert.equal(type,'dblclick');handler=fn;options=opts;}});
assert.equal(options.capture,true);
handler({target:{closest:()=>null}});assert.equal(resized,1);
handler({target:{closest:()=>({})}});assert.equal(resized,1);
console.log('Passed: each chart measures itself before double-click reset; toolbar clicks excluded');

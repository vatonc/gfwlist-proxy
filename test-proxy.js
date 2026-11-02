const assert=require('assert');
const vm=require('vm');
const fs=require('fs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const event=()=>({listeners:[],addListener(fn){this.listeners.push(fn)},fire(...args){for(const fn of this.listeners)fn(...args)}});
async function main(){
  const storage={state:{enabled:true,host:'127.0.0.1',port:'7890',rules:['example.com'],exceptions:[],userProxy:[],userDirect:[],updatedAt:0}};
  let proxy={levelOfControl:'controllable_by_this_extension',value:{mode:'direct'}},own=null,fetchWait=null,failRemove='',failClear=false,failSetState=false,failGet=false,icons=[];
  let chrome,send,context;
  function start(){
    const change=event(),message=event();
    chrome={runtime:{onInstalled:event(),onStartup:event(),onMessage:message,getURL:x=>x},storage:{local:{get:async keys=>{if(typeof keys==='string')keys=[keys];return Object.fromEntries(keys.filter(k=>k in storage).map(k=>[k,structuredClone(storage[k])]))},set:async x=>{if(failSetState&&x.state)throw Error('存储失败');Object.assign(storage,structuredClone(x))},remove:async key=>{if(failRemove===key)throw Error('删除失败');delete storage[key]}}},proxy:{settings:{onChange:change,get:async()=>{if(failGet){failGet=false;throw Error('读取失败')}return structuredClone(proxy)},set:async({value})=>{own=structuredClone(value);proxy={levelOfControl:'controlled_by_this_extension',value:structuredClone(value)};change.fire(proxy)},clear:async()=>{if(failClear)throw Error('清除失败');own=null;if(proxy.levelOfControl!=='controlled_by_other_extensions')proxy={levelOfControl:'controllable_by_this_extension',value:{mode:'direct'}};change.fire(proxy)}}},tabs:{onUpdated:event(),onActivated:event(),query:async()=>[],get:async()=>({url:'https://example.com'})},action:{setIcon:async x=>icons.push(x)}};
    context=vm.createContext({chrome,URL,AbortController,TextDecoder,atob,setTimeout,clearTimeout,console,fetch:async()=>{if(fetchWait)await fetchWait;return {status:204,ok:true,text:async()=>btoa('||example.com^\n/path')}}});
    vm.runInContext(fs.readFileSync('background.js','utf8'),context);send=msg=>new Promise(resolve=>message.listeners[0](msg,{},resolve));
  }
  start();assert((await send({type:'enable'})).ok);const original=structuredClone(proxy);
  let release;fetchWait=new Promise(r=>release=r);let pending=send({type:'test',config:{host:'127.0.0.1',port:'7892'}});await tick();assert(storage.testRecovery);chrome.proxy.settings.onChange.fire({incognitoSpecific:true,levelOfControl:'controlled_by_other_extensions',value:{mode:'direct'}});release();assert((await pending).ok);fetchWait=null;assert.deepStrictEqual(proxy,original);assert(!storage.testRecovery);
  fetchWait=new Promise(r=>release=r);pending=send({type:'test',config:{host:'127.0.0.1',port:'7892'}});await tick();assert(storage.testRecovery);start();assert((await send({type:'status'})).controlled);assert.deepStrictEqual(proxy,original);assert(!storage.testRecovery);fetchWait=null;release();await pending;
  fetchWait=new Promise(r=>release=r);pending=send({type:'test',config:{host:'127.0.0.1',port:'7892'}});await tick();proxy={levelOfControl:'controlled_by_other_extensions',value:{mode:'direct'}};chrome.proxy.settings.onChange.fire(proxy);release();assert(!(await pending).ok);fetchWait=null;start();let status=await send({type:'status'});assert(status.testRestoreError);assert.equal(proxy.levelOfControl,'controlled_by_other_extensions');assert(storage.testRecovery);
  assert((await send({type:'disable'})).ok);assert.equal(own,null);assert.equal(proxy.levelOfControl,'controlled_by_other_extensions');
  delete storage.testRecovery;delete storage.testRestoreError;proxy={levelOfControl:'controllable_by_this_extension',value:{mode:'direct'}};assert((await send({type:'enable'})).ok);
  failRemove='testRestoreError';const result=await send({type:'test',config:{host:'127.0.0.1',port:'7892'}});assert(!result.ok&&result.message.includes('代理已恢复'));failRemove='';
  const before=structuredClone(proxy);failSetState=true;const failed=await send({type:'save',config:{host:'127.0.0.1',port:'7891'}});assert(!failed.ok);assert.deepStrictEqual(proxy,before);failSetState=false;
  failClear=true;const disabled=await send({type:'disable'});assert(!disabled.ok&&disabled.message.includes('已保存关闭状态'));assert.equal(storage.state.enabled,false);failClear=false;
  chrome.runtime.onStartup.fire();await tick();await send({type:'status'});assert.equal(storage.state.enabled,false);assert.equal(own,null);
  assert((await send({type:'enable'})).ok);const update=await send({type:'update'});assert(update.ok&&update.message.includes('未统计跳过'));
  chrome.tabs.onUpdated.fire(1);await tick();assert(icons.some(x=>x.path[16]==='icon-red-16.png'));
  const elements={};for(const id of ['host','port','scheme','toggle','controls','save','test','update','siteProxy','siteDirect','result','listStatus','notice','siteStatus'])elements[id]={value:'',textContent:'',className:'',addEventListener(type,fn){this[type]=fn}};
  let testResolve,lastTest;const tabEvent=event();const popupStatus=()=>({ok:true,enabled:true,config:{host:'127.0.0.1',port:'7890'},siteHost:'example.com',siteTabId:1,listCount:1,controlText:''});
  const popupChrome={tabs:{onActivated:tabEvent,onUpdated:event()},runtime:{sendMessage:msg=>{if(msg.type==='status')return Promise.resolve(popupStatus());if(msg.type==='test'){lastTest=msg.config;return new Promise(r=>testResolve=r)}return Promise.resolve({ok:true,message:'完成'})}}};
  vm.runInNewContext(fs.readFileSync('popup.js','utf8'),{chrome:popupChrome,document:{getElementById:id=>elements[id]},setInterval,clearInterval,console});await tick();elements.port.value='7892';elements.port.input();const testing=elements.test.onclick();assert.equal(lastTest.port,'7892');elements.port.value='7893';elements.port.input();testResolve({ok:true,message:'成功'});await testing;assert(elements.result.textContent.includes('输入已更改'));
  for(const scheme of ['http','https','socks5']){
    const config={host:'127.0.0.1',port:'7892',scheme};
    assert((await send({type:'save',config})).ok);
    assert.equal(storage.state.scheme,scheme);
    assert((await send({type:'test',config})).ok);
    assert.equal(storage.state.scheme,scheme);
  }
  const saved=structuredClone(storage.state),savedProxy=structuredClone(proxy);
  for(const config of [{host:'evil.com/path',port:'7890',scheme:'http'},{host:'127.0.0.1',port:'0',scheme:'http'},{host:'127.0.0.1',port:'65536',scheme:'http'},{host:'127.0.0.1',port:'7890',scheme:'socks4'}]){
    assert(!(await send({type:'save',config})).ok);
    assert.deepStrictEqual(storage.state,saved);assert.deepStrictEqual(proxy,savedProxy);
  }
  elements.host.value='draft.example';elements.host.input();elements.scheme.value='socks5';elements.scheme.input();tabEvent.fire();await tick();
  assert.equal(elements.host.value,'draft.example');assert.equal(elements.port.value,'7893');assert.equal(elements.scheme.value,'socks5');
  chrome.runtime.onStartup.fire();status=await send({type:'status'});assert.equal(status.enabled,false);assert.equal(own,null);
  console.log('模拟测试通过');
}
main().catch(e=>{console.error(e);process.exitCode=1});

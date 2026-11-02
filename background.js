const LIST_URL='https://raw.githubusercontent.com/gfwlist/gfwlist/master/gfwlist.txt';
const DEFAULTS={enabled:false,host:'127.0.0.1',port:'7890',scheme:'http',rules:[],exceptions:[],userProxy:[],userDirect:[],updatedAt:0};
let state=DEFAULTS;
let busy=false,updating=false,updateResult=null,testing=null,testProgress='';
const initialLoad=loadState();
let startupTask=initialLoad.then(recoverTest);
const iconVersions=new Map();

chrome.runtime.onInstalled.addListener(()=>{startupTask=startupTask.then(async()=>{await initializeList();await refreshAllIcons()}).catch(e=>{updateResult={ok:false,message:`内置名单初始化失败：${e.message}；请检查代理设置或手动更新名单。`};console.error(updateResult.message)})});
chrome.runtime.onStartup.addListener(()=>{startupTask=startupTask.then(initializeStartup).catch(e=>{updateResult={ok:false,message:`启动初始化失败：${e.message}；请检查代理设置或手动更新名单。`};console.error(updateResult.message)})});
chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{(async()=>{
  await startupTask;
  if(msg.type==='status')return status();
  if(msg.type==='testProgress')return {ok:true,testing:!!testing,message:testProgress};
  if(msg.type==='updateProgress')return {ok:true,updating,result:updateResult};
  if(busy)return {ok:false,message:'另一项代理操作正在进行，请稍后再试'};
  busy=true;
  try{
    await loadState();
    if(msg.type==='save'&&!state.enabled)return {ok:false,message:'请先开启代理'};
    if(msg.type==='enable'&&!state.rules.length)await initializeList();
    if(msg.type==='disable'){await disableProxy();await refreshAllIcons();return {ok:true,message:'代理已关闭'}}
    if(msg.type==='enable'||msg.type==='save'){
      const c=msg.config||{host:state.host,port:state.port,scheme:state.scheme};
      if(!validConfig(c))return {ok:false,message:'请填写有效的代理地址、端口并选择支持的协议'};
      const next={...state,host:c.host,port:c.port,scheme:c.scheme??'http',enabled:true};
      await commitProxy(next);await refreshAllIcons();return {ok:true,message:msg.type==='save'?`配置已保存并生效：${c.host}:${c.port}`:'代理已开启'};
    }
    if(msg.type==='update'){updating=true;updateResult=null;try{return updateResult=await updateList()}finally{updating=false}}
    if(!state.enabled)return {ok:false,message:'请先开启代理'};
    if(msg.type==='test')return await testProxy(msg.config);
    if(msg.type==='site'){
      const h=validSiteHost(msg.host);
      if(!h)return {ok:false,message:'当前页面不支持站点规则'};
      if(!['proxy','direct'].includes(msg.action))return {ok:false,message:'无效的站点操作'};
      const next={...state,userProxy:state.userProxy.filter(x=>x!==h),userDirect:state.userDirect.filter(x=>x!==h)};
      next[msg.action==='proxy'?'userProxy':'userDirect'].push(h);
      await commitProxy(next);await refreshAllIcons();return {ok:true,message:msg.action==='proxy'?`${h} 已设为强制代理`:`${h} 已设为强制直连`};
    }
    return {ok:false,message:'未知操作'};
  }finally{busy=false}
})().then(sendResponse).catch(e=>sendResponse({ok:false,message:e.message}));return true});
chrome.tabs.onUpdated.addListener(id=>updateIcon(id));
chrome.tabs.onActivated.addListener(({tabId})=>updateIcon(tabId));
chrome.proxy.settings.onChange.addListener(details=>{if(testing&&details.incognitoSpecific!==true&&(!matchesTest(details.value,testing.config)||details.levelOfControl!=='controlled_by_this_extension'))testing.interrupted=true;refreshAllIcons()});

function validConfig(c){if(!c||!['http','socks5','https'].includes(c.scheme??'http')||typeof c.host!=='string'||typeof c.port!=='string'||!/^[1-9]\d{0,4}$/.test(c.port)||Number(c.port)>65535||/[\s:/?#@\\]/.test(c.host))return false;try{const u=new URL(`http://${c.host}/`);return !!u.hostname&&!u.port&&u.hostname.toLowerCase()===c.host.toLowerCase()}catch{return false}}
function proxyDirective(c){return `${{http:'PROXY',socks5:'SOCKS5',https:'HTTPS'}[c.scheme??'http']} ${c.host}:${c.port}`}
function matchesTest(value,c){const p=value&&value.rules&&value.rules.singleProxy;return value&&value.mode==='fixed_servers'&&p&&p.scheme===(c.scheme??'http')&&typeof p.host==='string'&&p.host.toLowerCase()===c.host.toLowerCase()&&p.port===Number(c.port)&&Object.keys(value.rules).length===1}
async function restoreTest(record){
  const current=await chrome.proxy.settings.get({incognito:false});
  if(current.levelOfControl!=='controlled_by_this_extension'||!matchesTest(current.value,record.config))throw new Error('代理控制权或配置已变化，为避免覆盖其他配置未自动恢复');
  if(record.previous.levelOfControl==='controlled_by_this_extension')await chrome.proxy.settings.set({scope:'regular',value:record.previous.value});
  else await chrome.proxy.settings.clear({scope:'regular'});
  const restored=await chrome.proxy.settings.get({incognito:false});
  if(record.previous.levelOfControl==='controlled_by_this_extension'&&(restored.levelOfControl!=='controlled_by_this_extension'||JSON.stringify(restored.value)!==JSON.stringify(record.previous.value)))throw new Error('恢复后的代理设置与先前设置不一致或已失去控制权');
  if(record.previous.levelOfControl!=='controlled_by_this_extension'&&restored.levelOfControl==='controlled_by_this_extension')throw new Error('临时代理设置未清除');
}
async function recoverTest(){
  const {testRecovery}=await chrome.storage.local.get('testRecovery');
  if(!testRecovery)return;
  try{await restoreTest(testRecovery);await chrome.storage.local.remove('testRecovery')}
  catch(e){const message=`测试代理自动恢复失败：${e.message}。请检查浏览器代理设置。`;try{await chrome.storage.local.set({testRestoreError:message})}catch{} }
}
async function testProxy(config){
  if(!validConfig(config))return {ok:false,message:'请填写有效的代理地址、端口并选择支持的协议'};
  const pending=await chrome.storage.local.get('testRecovery');
  if(pending.testRecovery)return {ok:false,message:'存在未完成的测试恢复记录，请先检查浏览器代理设置。'};
  const previous=await chrome.proxy.settings.get({incognito:false});
  if(!['controlled_by_this_extension','controllable_by_this_extension'].includes(previous.levelOfControl))return {ok:false,message:'无法测试：本扩展没有代理控制权，请检查其他扩展或浏览器策略'};
  const record={config,previous};
  await chrome.storage.local.set({testRecovery:record});
  let result,restoreError='',changed=false;
  testing={config,interrupted:false};testProgress='正在接管浏览器代理设置…';
  try{
    await chrome.proxy.settings.set({scope:'regular',value:{mode:'fixed_servers',rules:{singleProxy:{scheme:config.scheme??'http',host:config.host,port:Number(config.port)}}}});changed=true;
    testProgress='代理设置已应用，正在确认控制权…';
    const current=await chrome.proxy.settings.get({incognito:false});
    if(current.levelOfControl!=='controlled_by_this_extension'||!matchesTest(current.value,config)||testing.interrupted)throw new Error('测试期间代理控制权或配置发生变化');
    testProgress='正在通过测试地址连接（最多 10 秒）…';
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    try{const response=await fetch('https://www.gstatic.com/generate_204',{cache:'no-store',credentials:'omit',redirect:'error',signal:controller.signal});if(response.status!==204)throw new Error(`测试地址返回 HTTP ${response.status}`);result={ok:true,message:'测试地址连接成功；这不保证所有网站均可访问。'}}finally{clearTimeout(timer)}
  }catch(e){result={ok:false,message:`测试失败：${e.name==='AbortError'?'连接超时':e.message}。请检查代理服务是否运行，以及地址、端口和协议是否正确。`}}
  finally{
    testProgress='测试完成，正在恢复原代理设置…';
    try{
      if(changed){if(testing.interrupted)throw new Error('代理控制权或配置已变化，为避免覆盖其他配置未自动恢复');testing=null;await restoreTest(record)}
      else {const current=await chrome.proxy.settings.get({incognito:false});if(current.levelOfControl==='controlled_by_this_extension'&&matchesTest(current.value,config)){testing=null;await restoreTest(record)}}
      await chrome.storage.local.remove('testRecovery');
    }catch(e){restoreError=e.message}
    testing=null;testProgress='';try{await refreshAllIcons()}catch{}
  }
  if(restoreError){const message=`${result.message} 恢复失败：${restoreError}。请检查浏览器代理设置。`;try{await chrome.storage.local.set({testRestoreError:message})}catch{}return {ok:false,message}}
  try{await chrome.storage.local.remove('testRestoreError')}catch(e){return {ok:false,message:`${result.message} 代理已恢复，但清除历史恢复错误失败：${e.message}`}}
  return result;
}
async function loadState(){const o=await chrome.storage.local.get('state');state={...DEFAULTS,...(o.state||{})}}
async function status(){const hasControl=await proxyMatches(state);const tabs=await chrome.tabs.query({active:true,currentWindow:true});const tab=tabs[0],url=siteUrl(tab),host=siteHost(url);const {testRestoreError,testRecovery}=await chrome.storage.local.get(['testRestoreError','testRecovery']);return {ok:true,updating,updateResult,config:{host:state.host,port:state.port,scheme:state.scheme},listCount:state.rules.length,updatedAt:state.updatedAt,enabled:state.enabled,controlled:hasControl,siteTabId:tab&&tab.id,siteHost:host,siteProxy:host?expected(url):null,testing:!!testing,testProgress,testRestoreError:testRestoreError||(testRecovery&&!testing?'存在未完成的测试恢复记录，请检查浏览器代理设置。':''),controlText:!testing&&state.enabled&&!hasControl?'代理未开启：本扩展未控制代理，请检查其他扩展或浏览器策略。':''}}
async function proxyMatches(config){if(!config.rules.length)return false;const x=await chrome.proxy.settings.get({incognito:false});return x.levelOfControl==='controlled_by_this_extension'&&x.value?.mode==='pac_script'&&x.value.pacScript?.data===makePac(config.rules,proxyDirective(config),config.exceptions,config.userProxy,config.userDirect)}
async function rollbackProxy(next,previous){const current=await chrome.proxy.settings.get({incognito:false});const pac=makePac(next.rules,proxyDirective(next),next.exceptions,next.userProxy,next.userDirect);if(current.levelOfControl!=='controlled_by_this_extension'||current.value?.mode!=='pac_script'||current.value.pacScript?.data!==pac)throw new Error('代理控制权或配置已变化，未覆盖当前设置');if(previous.levelOfControl==='controlled_by_this_extension')await chrome.proxy.settings.set({scope:'regular',value:previous.value});else await chrome.proxy.settings.clear({scope:'regular'})}
async function commitProxy(next){const previous=await chrome.proxy.settings.get({incognito:false});if(!['controlled_by_this_extension','controllable_by_this_extension'].includes(previous.levelOfControl))throw new Error('代理未开启：本扩展未获得代理控制权，请检查其他扩展或浏览器策略');let attempted=false;try{const pac=makePac(next.rules,proxyDirective(next),next.exceptions,next.userProxy,next.userDirect);attempted=true;await chrome.proxy.settings.set({scope:'regular',value:{mode:'pac_script',pacScript:{data:pac,mandatory:true}}});if(!await proxyMatches(next))throw new Error('代理验证失败');await chrome.storage.local.set({state:next});state=next}catch(e){if(attempted){try{await rollbackProxy(next,previous)}catch(rollback){throw new Error(`${e.message}；代理回滚未完成：${rollback.message}，请检查浏览器代理设置`)}}throw e}}
async function disableProxy(){const next={...state,enabled:false};await chrome.storage.local.set({state:next});state=next;try{await clearOwnedProxy()}catch(e){throw new Error(`已保存关闭状态，但清除本扩展代理失败：${e.message}；请检查浏览器代理设置`)} }
function makePac(rules,proxy,exceptions,userProxy,userDirect){return `function FindProxyForURL(url,host){var h=host.toLowerCase();var p=${JSON.stringify(userProxy||[])},d=${JSON.stringify(userDirect||[])},r=${JSON.stringify(rules)},e=${JSON.stringify(exceptions||[])};if(p.indexOf(h)!==-1)return ${JSON.stringify(proxy)};if(d.indexOf(h)!==-1)return "DIRECT";for(var i=0;i<e.length;i++){if(h===e[i]||h.endsWith('.'+e[i]))return "DIRECT";}for(var j=0;j<r.length;j++){if(h===r[j]||h.endsWith('.'+r[j]))return ${JSON.stringify(proxy)};}return "DIRECT";}`}
function hostFromRule(line){let s=line.trim();if(!s||s.startsWith('!')||s.startsWith('['))return null;s=s.replace(/^@@/,'');if(s.startsWith('||'))s=s.slice(2);if(s.endsWith('^'))s=s.slice(0,-1);if(!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(s))return null;return s.toLowerCase()}
function decodeBase64(text){const clean=text.replace(/\s/g,'');const bin=atob(clean);const bytes=Uint8Array.from(bin,c=>c.charCodeAt(0));return new TextDecoder('utf-8',{fatal:false}).decode(bytes)}
function parseList(text){const lines=decodeBase64(text).split(/\r?\n/);const set=new Set(),exceptions=new Set();for(const line of lines){const h=hostFromRule(line);if(!h)continue;if(line.trim().startsWith('@@'))exceptions.add(h);else set.add(h)}for(const h of exceptions)set.delete(h);if(!set.size)throw new Error('名单为空或格式无法识别');return {rules:[...set],exceptions:[...exceptions]}}
async function initializeList(){await loadState();if(state.rules.length)return;const res=await fetch(chrome.runtime.getURL('gfwlist.txt'));if(!res.ok)throw new Error(`读取内置资源失败：HTTP ${res.status}`);const parsed=parseList(await res.text());const next={...state,...parsed};await chrome.storage.local.set({state:next});state=next}
async function updateList(){try{const controller=new AbortController();let timer;const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('网络请求超时（15 秒）'))},15000)});let text;try{text=await Promise.race([(async()=>{const res=await fetch(LIST_URL,{cache:'no-store',signal:controller.signal});if(!res.ok)throw new Error(`HTTP ${res.status}`);return await res.text()})(),timeout])}finally{clearTimeout(timer)}const parsed=parseList(text);const next={...state,...parsed,updatedAt:Date.now()};if(next.enabled)await commitProxy(next);else{await chrome.storage.local.set({state:next});state=next}try{await refreshAllIcons()}catch{}return {ok:true,message:`名单已更新：${next.rules.length} 条域名；仅支持域名规则，未统计跳过的规则`}}catch(e){return {ok:false,message:`更新失败：${e.message}`}}}
async function clearOwnedProxy(){await chrome.proxy.settings.clear({scope:'regular'})}
async function initializeStartup(){await disableProxy();await initializeList();await refreshAllIcons()}
function siteHost(url){try{const u=new URL(url);return ['http:','https:'].includes(u.protocol)&&u.hostname?u.hostname.toLowerCase():null}catch{return null}}
function siteUrl(tab){if(!tab)return null;if(tab.pendingUrl){if(siteHost(tab.pendingUrl))return tab.pendingUrl;if(!tab.pendingUrl.startsWith('chrome-error://'))return null}return siteHost(tab.url)?tab.url:null}
function validSiteHost(host){if(typeof host!=='string'||!host||host!==host.toLowerCase()||/[\s/?#@\\]/.test(host))return null;try{const u=new URL(`http://${host}/`);return u.hostname===host&&!u.port?host:null}catch{return null}}
function expected(url){const h=siteHost(url);if(!h)return null;if(state.userProxy.includes(h))return true;if(state.userDirect.includes(h))return false;if((state.exceptions||[]).some(r=>h===r||h.endsWith('.'+r)))return false;return state.rules.some(r=>h===r||h.endsWith('.'+r))}
async function updateIcon(id){const version=(iconVersions.get(id)||0)+1;iconVersions.set(id,version);let color='gray';try{await initialLoad;if(!testing&&state.enabled&&await proxyMatches(state)){const tab=await chrome.tabs.get(id);const x=expected(siteUrl(tab));color=x===null?'gray':x?'red':'green'}}catch{}if(iconVersions.get(id)===version)return setIcon(id,color)}
function setIcon(id,color){return chrome.action.setIcon({tabId:id,path:{16:`icon-${color}-16.png`,48:`icon-${color}-48.png`,128:`icon-${color}-128.png`}}).catch(()=>{})}
async function refreshAllIcons(){const tabs=await chrome.tabs.query({});for(const tab of tabs)await updateIcon(tab.id)}

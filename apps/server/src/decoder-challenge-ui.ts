// Runs inside the relayed official UI, using public DOM events only. As with
// mirror-controls, browser behavior is exercised separately by Playwright.
export const decoderChallengeCss = `
#mirror-format-lab-launcher{position:relative;z-index:20;display:inline-flex;align-items:center;gap:6px;margin:0 8px 8px auto;border:1px solid #485462;border-radius:999px;background:#20262e;color:#d9e7f4;padding:7px 12px;font:12px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer;box-shadow:0 3px 12px #0003}
#mirror-format-lab-launcher:hover{background:#2b3541;border-color:#7acdb4;color:#fff}
#mirror-format-lab-launcher .mfl-spark{color:#91e8c9;font-size:14px}
#mirror-decoder{color-scheme:dark;color:#eee;background:#181b20;border:1px solid #424953;border-radius:18px;width:min(720px,calc(100vw - 24px));max-height:calc(100dvh - 32px);padding:24px;box-shadow:0 24px 90px #0009;font:14px/1.5 ui-sans-serif,system-ui,sans-serif}
#mirror-decoder::backdrop{background:#0009}
#mirror-decoder *{box-sizing:border-box}
#mirror-decoder h2{font-size:24px;font-weight:650;margin:0 0 4px}
#mirror-decoder p{margin:6px 0 16px;color:#b8c1cc}
#mirror-decoder .md-eyebrow{color:#86dfc5;font-size:11px;letter-spacing:.12em;text-transform:uppercase;margin-bottom:5px}
#mirror-decoder .md-close{float:right;background:transparent;border:0;color:#ccc;font-size:22px;cursor:pointer}
#mirror-decoder .md-options{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:20px 0}
#mirror-decoder label{display:block;color:#cbd3dd;font-size:12px}
#mirror-decoder select,#mirror-decoder textarea{display:block;width:100%;border:1px solid #4b5360;border-radius:8px;background:#101318;color:#eee;font:inherit;padding:9px;margin-top:5px}
#mirror-decoder textarea{font:12px/1.5 ui-monospace,monospace;resize:vertical}
#mirror-decoder .md-actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
#mirror-decoder .md-actions button,#mirror-decoder .md-actions a{border:1px solid #4b5360;border-radius:8px;background:#2b313b;color:#eee;padding:9px 13px;font:inherit;text-decoration:none;cursor:pointer}
#mirror-decoder .md-actions .md-primary{background:#94e6cc;border-color:#94e6cc;color:#11281f;font-weight:600}
#mirror-decoder button:disabled{opacity:.45;cursor:wait}
#mirror-decoder .md-card{margin-top:18px;border-top:1px solid #39404a;padding-top:18px}
#mirror-decoder .md-meta{font-size:12px;color:#a5b1c0;overflow-wrap:anywhere}
#mirror-decoder .md-result{padding:12px;border:1px solid #4b5360;border-radius:9px;margin:12px 0;background:#232a33;white-space:pre-wrap}
#mirror-decoder .md-result:empty{display:none}
#mirror-decoder .md-result[data-verdict=exact]{border-color:#74d7b7;color:#9af1d3}
#mirror-decoder .md-result[data-verdict=partial]{border-color:#ddbc75;color:#f0d39a}
#mirror-decoder .md-result[data-verdict=mismatch]{border-color:#c87d85;color:#ffb5bc}
#mirror-decoder summary{cursor:pointer;color:#bccddd;margin-top:12px}
#mirror-decoder :focus-visible{outline:2px solid #94e6cc;outline-offset:3px}
@media(max-width:560px){#mirror-decoder{padding:18px}#mirror-decoder .md-options{grid-template-columns:1fr;gap:8px}}
`;

export const decoderChallengeJs = String.raw`(()=>{
if(window.__mirrorDecoderInstalled)return;
window.__mirrorDecoderInstalled=true;
var dialog=null,active=null,busy=false,history=[];
var storageKey='mirror-decoder-active-v1';
function save(){try{sessionStorage.setItem(storageKey,JSON.stringify({activeId:active.id,items:history}));}catch(e){}}
function remember(challenge){active=challenge;history.unshift(challenge);history=history.slice(0,16);save();render();field('answer').value='';}
function field(name){return dialog.querySelector('[data-md="'+name+'"]');}
function status(text,verdict){field('status').textContent=text;field('status').dataset.verdict=verdict||'';}
function render(){
  field('recent').replaceChildren();
  history.forEach(function(item){
    var option=document.createElement('option');option.value=item.id;
    option.textContent=formatLabel(item.format)+' · '+guidanceLabel(item.guidance)+' · '+item.id.slice(0,8);
    field('recent').appendChild(option);
  });
  field('recent-label').hidden=!active;
  field('challenge').hidden=!active;
  if(!active)return;
  field('recent').value=active.id;
  field('meta').textContent=formatLabel(active.format)+' · '+guidanceLabel(active.guidance)+' · '+payloadLabel(active.payload)+' · 编码文件 '+active.artifactBytes.toLocaleString()+' 字节';
  field('expiry').textContent='挑战 ID：'+active.id+' · 到期时间：'+new Date(active.expiresAt).toLocaleString('zh-CN')+'。Mirror 重启或会话变更也会使其失效。';
  field('prompt').value=active.prompt;
  field('download').href='/api/decoder-challenges/'+active.id+'/artifact';
  field('download').download=active.filename;
  field('size-note').textContent=active.prompt.length>16000?'提示词较长。你可以下载 prompt.txt 并将其作为附件发送给 ChatGPT，再让 GPT 完成其中的挑战。':'提示词中包含经过压缩的原始文件 Base64 数据。GPT 需要代码执行能力才能可靠地完成解码。插入操作只会准备草稿，仍需你手动发送。';
}
async function request(url,body){
  var r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  var data=await r.json();
  if(!r.ok)throw Error(typeof data.error==='string'?data.error:(data.error&&data.error.message)||'Mirror 请求失败。');
  return data;
}
function downloadBlob(blob,filename){
  var url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;a.click();
  setTimeout(function(){URL.revokeObjectURL(url);},1000);
}
async function downloadKit(ids){
  var r=await fetch('/api/decoder-challenges/kit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ids:ids})});
  if(!r.ok){var error=await r.json();throw Error(error.error||'无法下载挑战套件。');}
  downloadBlob(await r.blob(),'mirror-decoder-kits.tar.gz');
}
async function run(action){
  if(busy)return;
  busy=true;
  dialog.querySelectorAll('button:not(.md-close),select').forEach(function(b){b.disabled=true;});
  try{await action();}catch(e){status(e.message||String(e));}
  finally{busy=false;dialog.querySelectorAll('button,select').forEach(function(b){b.disabled=false;});}
}
function markedAnswer(text){
  var marker='MIRROR_ANSWER_'+active.id+':';
  var lines=text.split(/\r?\n/).map(function(line){return line.trim();});
  var candidates=lines.filter(function(line){return line.startsWith(marker);});
  if(candidates.length!==1)throw Error('此挑战应包含且仅包含一行 MIRROR_ANSWER 答案标记。请让 GPT 按提示词中的格式输出该标记。');
  return candidates[0].slice(marker.length).trim();
}
async function verify(hex){
  hex=hex.replace(/\s/g,'');
  if(!/^(?:[0-9a-fA-F]{2})+$/.test(hex))throw Error('请粘贴完整的十六进制字节对，或 GPT 返回的带标记答案行。');
  status('正在检查恢复出的字节…');
  var result=await request('/api/decoder-challenges/'+active.id+'/verify',{hex:hex});
  var title=result.verdict==='exact'?'完全匹配 — GPT 已恢复全部字节。':result.verdict==='partial'?'部分匹配 — 请继续检查。':'不匹配 — 恢复出的字节与原始内容不同。';
  status(title+'\n'+result.matchingBytes+' / '+result.expectedBytes+' 字节在相同位置匹配。提交内容：'+result.actualBytes+' 字节。',result.verdict);
}
function visible(el){return !!el&&el.getClientRects().length>0;}
function composer(){
  return Array.from(document.querySelectorAll('#prompt-textarea,[data-testid="prompt-textarea"],textarea[placeholder*="Message"]')).find(function(el){return visible(el)&&(el.tagName==='TEXTAREA'||el.isContentEditable);});
}
function insertPrompt(){
  var el=composer();
  if(!el)throw Error('未找到 ChatGPT 输入框。请使用“复制提示词”，然后粘贴到对话中。');
  if((el.value||el.textContent||'').trim())throw Error('输入框中已有草稿。请复制挑战提示词，或先清空草稿再插入。');
  dialog.close();el.focus();
  if(el.tagName==='TEXTAREA'){
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,active.prompt);
    el.dispatchEvent(new Event('input',{bubbles:true}));
  }else{
    var selection=window.getSelection(),range=document.createRange();
    range.selectNodeContents(el);selection.removeAllRanges();selection.addRange(range);
    // Native insertText creates nested divs and can double blank lines in
    // contenteditable. Escaped text + explicit line breaks preserves the
    // exact transport while still going through the editor's input events.
    var text=document.createElement('div');text.textContent=active.prompt;
    document.execCommand('insertHTML',false,text.innerHTML.replace(/\n/g,'<br>'));
  }
  var value=el.tagName==='TEXTAREA'?el.value:el.innerText;
  if(value.replace(/\r\n/g,'\n')!==active.prompt){dialog.showModal();throw Error('ChatGPT 未能完整接收提示词。请使用“复制提示词”，并在发送前替换不完整的草稿。');}
  status('挑战提示词已插入。请在 ChatGPT 中发送，然后重新打开“格式实验室”检查回复。');
}
function build(){
  dialog=document.createElement('dialog');dialog.id='mirror-decoder';
  dialog.setAttribute('aria-labelledby','mirror-decoder-title');
  dialog.innerHTML='<button class="md-close" aria-label="关闭解码挑战">×</button><div class="md-eyebrow">Mirror 实验室 · 与 GPT 共创</div><h2 id="mirror-decoder-title">格式实验室</h2><p>给 GPT 一个编码谜题，或让它使用 Mirror 的四种特殊格式创建、改编一个小型文件。</p>'
    +'<div class="md-options"><label>格式<select data-md="format"><option value="loaf">LoaF</option><option value="pngspeak" selected>PngSpeak</option><option value="gptgif">gptgif 原版</option><option value="gptgif-v4">gptgif v4</option></select></label><label>提示模式<select data-md="guidance"><option value="guided">附带格式说明</option><option value="independent">让 GPT 自行研究</option></select></label><label>隐藏载荷<select data-md="payload"><option value="text">UTF-8 文本</option><option value="binary">随机二进制数据</option></select></label></div>'
    +'<div class="md-actions"><button class="md-primary" data-md="generate">生成挑战</button></div><details><summary>可选：获取文件和提示词</summary><p>下载一套完整的挑战资料：编码文件、对应的 GPT 提示词、单独的格式说明和操作指南。答案密钥仅保存在此处。</p><div class="md-actions"><button data-md="all-kits">下载全部四种格式套件</button></div><p>使用当前选择的提示模式和载荷类型。下载一个可在电脑上解压的 .tar.gz 归档文件。</p></details><div class="md-result" data-md="status" role="status" aria-live="polite"></div><label data-md="recent-label" hidden>最近的挑战<select data-md="recent"></select></label>'
    +'<section class="md-card" data-md="workshop"><strong>GPT 创作工坊</strong><p>描述你希望 GPT 创建、改编或解释的内容。Mirror 会生成一份针对所选格式的详细需求，要求 GPT 输出可用文件和简明的变更记录。</p><label>创作需求<textarea data-md="brief" rows="3" placeholder="制作一个有三个房间和隐藏结局的简短互动冒险故事。"></textarea></label><div class="md-actions"><button class="md-primary" data-md="build">让 GPT 按需求创作</button><button data-md="remix">让 GPT 改编此格式</button><button data-md="explain">让 GPT 解释此格式</button></div></section>'
    +'<section class="md-card" data-md="challenge" hidden><strong>解码挑战</strong><div class="md-meta" data-md="meta"></div><div class="md-actions"><button class="md-primary" data-md="insert">插入对话</button><button data-md="copy">复制提示词</button><a data-md="download">下载编码文件</a><button data-md="packet">下载提示词</button><button data-md="kit">下载此套件</button></div>'
    +'<p data-md="size-note"></p>'
    +'<details><summary>查看挑战提示词</summary><textarea data-md="prompt" aria-label="挑战提示词" rows="7" readonly></textarea></details>'
    +'<div class="md-card"><strong>2. 校验恢复出的字节</strong><div class="md-actions"><button data-md="latest">检查 GPT 最新回复</button></div><label>或粘贴恢复出的十六进制内容 / 带标记的答案行<textarea data-md="answer" rows="3" maxlength="8192" spellcheck="false" placeholder="在此粘贴 GPT 返回的十六进制答案"></textarea></label><div class="md-actions"><button data-md="verify">校验粘贴的答案</button></div><div class="md-meta" data-md="expiry"></div></div></section>';
  document.body.appendChild(dialog);
  dialog.querySelector('.md-close').onclick=function(){dialog.close();};
  field('generate').onclick=function(){run(async function(){
    status('正在生成新的编码挑战…');
    var next=await request('/api/decoder-challenges',{format:field('format').value,guidance:field('guidance').value,payload:field('payload').value});
    remember(next);
    status('已就绪。请将挑战插入 ChatGPT。答案密钥仅保存在 Mirror 服务器上。');
  });};
  function briefBase64(text){
    var bytes=new TextEncoder().encode(text),binary='';
    for(var i=0;i<bytes.length;i++)binary+=String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  async function workshopPrompt(kind){
    var format=field('format').value, brief=field('brief').value.trim()||'a tiny interactive story with a surprising ending';
    var lead=kind==='build'?'Create':kind==='remix'?'Remix':'Explain';
    var note=kind==='explain'?'Explain how the format represents bytes, then demonstrate with a tiny valid example. If code execution is available, generate and inspect the exact bytes.':'Produce the actual artifact bytes or a complete reproducible script that creates them. Keep a manifest of files/bytes, describe format-specific tradeoffs, and end with a short CHANGELOG for the next iteration. Do not pretend an image is ordinary visual art if it is carrying data.';
    var response=await fetch('/api/convert/gpt-prompt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({dataBase64:briefBase64(brief),format:format,filename:'format-lab-brief.txt',note:note})});
    var data=await response.json();
    if(!response.ok)throw Error(data.error||'转换接口无法生成此格式的提示词。');
    return data.prompt+'\n\nYou are collaborating with Mirror Format Lab. '+lead+' a '+format+' artifact for this brief: '+brief+'\nUse the format exactly as described above, preserve Unicode and binary bytes, and clearly label anything that is a lossy visual experiment. Mirror will display the resulting file and can feed a later remix back to you.';
  }
  async function putWorkshopPrompt(kind){var text=await workshopPrompt(kind);field('prompt').value=text;field('prompt').closest('details').open=true;status('创作需求已准备就绪。请将其插入对话，或复制后发送给 GPT。');}
  field('build').onclick=function(){run(async function(){await putWorkshopPrompt('build');});};
  field('remix').onclick=function(){run(async function(){await putWorkshopPrompt('remix');});};
  field('explain').onclick=function(){run(async function(){await putWorkshopPrompt('explain');});};
  field('recent').onchange=function(){active=history.find(function(item){return item.id===field('recent').value;});save();render();field('answer').value='';status('已选择此挑战，请在下方校验对应的 GPT 答案。');};
  field('kit').onclick=function(){run(async function(){await downloadKit([active.id]);status('挑战套件已下载：包含编码文件、提示词、可选格式说明和操作指南。');});};
  field('all-kits').onclick=function(){run(async function(){
    var ids=[];
    for(var format of ['loaf','pngspeak','gptgif','gptgif-v4']){
      status('正在准备 '+formatLabel(format)+' 套件…');
      var next=await request('/api/decoder-challenges',{format:format,guidance:field('guidance').value,payload:field('payload').value});
      remember(next);ids.push(next.id);
    }
    await downloadKit(ids);status('四种格式的挑战套件已全部下载。请在“最近的挑战”中选择要校验的项目。');
  });};
  field('insert').onclick=function(){run(async function(){insertPrompt();});};
  field('copy').onclick=function(){run(async function(){
    try{await navigator.clipboard.writeText(active.prompt);status('提示词已复制，请粘贴到 ChatGPT。');}
    catch(e){field('prompt').closest('details').open=true;field('prompt').focus();field('prompt').select();throw Error('无法访问剪贴板。提示词已选中，请使用键盘快捷键复制。');}
  });};
  field('packet').onclick=function(){
    downloadBlob(new Blob([active.prompt],{type:'text/plain;charset=utf-8'}),'decoder-'+active.id+'-prompt.txt');
  };
  field('latest').onclick=function(){run(async function(){
    var messages=Array.from(document.querySelectorAll('[data-message-author-role="assistant"]')).filter(visible);
    if(!messages.length)throw Error('未找到可见的 GPT 回复。你可以在下方粘贴恢复出的十六进制内容。');
    var hex=markedAnswer(messages[messages.length-1].innerText);field('answer').value=hex;await verify(hex);
  });};
  field('verify').onclick=function(){run(async function(){
    var text=field('answer').value.trim();await verify(text.includes('MIRROR_ANSWER_')?markedAnswer(text):text);
  });};
  try{
    var saved=JSON.parse(sessionStorage.getItem(storageKey)||'null');
    if(saved&&Array.isArray(saved.items)){
      history=saved.items.filter(function(item){return item&&/^[0-9a-f-]{36}$/.test(item.id)&&typeof item.prompt==='string'&&typeof item.artifactBytes==='number'&&item.expiresAt>Date.now();}).slice(0,16);
      active=history.find(function(item){return item.id===saved.activeId;})||history[0]||null;
    }
  }catch(e){}
  render();
}
window.addEventListener('mirror:decoder-open',function(){
  if(!dialog)build();
  if(!dialog.isConnected)document.body.appendChild(dialog);
  if(!dialog.open)dialog.showModal();
});
function findComposerAnchor(){
  var candidates=Array.from(document.querySelectorAll('#prompt-textarea,[data-testid="prompt-textarea"],textarea[placeholder*="Message"],textarea[placeholder*="Send"]'));
  return candidates.find(function(el){return el.getClientRects().length>0;});
}
function mountFormatLauncher(){
  if(document.getElementById('mirror-format-lab-launcher'))return true;
  var composer=findComposerAnchor();if(!composer)return false;
  var host=composer.closest('form')||composer.parentElement;
  if(!host||!host.parentElement)return false;
  var button=document.createElement('button');button.id='mirror-format-lab-launcher';button.type='button';button.innerHTML='<span class="mfl-spark">✦</span><span>格式实验室</span>';
  button.title='打开 Mirror 的 GPT 格式创作工坊';button.onclick=function(){window.dispatchEvent(new Event('mirror:decoder-open'));};
  host.parentElement.insertBefore(button,host);
  return true;
}
mountFormatLauncher();
var launchTimer=setInterval(function(){if(mountFormatLauncher())clearInterval(launchTimer);},500);
})();`;

export const connectionWidgetUri = "ui://superlog/integration-connection.html";

export const connectionWidgetHtml = String.raw`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{color-scheme:light dark;font-family:var(--font-sans,system-ui,sans-serif);color:var(--color-text-primary,light-dark(#202123,#ececec))}
*{box-sizing:border-box}body{margin:0}main{display:flex;align-items:center;gap:20px;padding:16px}section{flex:1;min-width:0}h2{font-size:14px;line-height:20px;font-weight:600;margin:0 0 3px}p{font-size:13px;line-height:19px;color:var(--color-text-secondary,light-dark(#62666b,#b0b4b8));margin:0}nav{display:flex;gap:8px;flex-shrink:0}button{font-family:inherit;font-weight:500;font-size:13px;line-height:20px;white-space:nowrap;border:1px solid transparent;border-radius:8px;padding:7px 12px;background:var(--color-text-primary,light-dark(#202123,#ececec));color:var(--color-background-primary,light-dark(#fff,#202123));cursor:pointer}button:disabled{opacity:.55;cursor:default}#check{background:transparent;color:inherit;border-color:var(--color-border-primary,light-dark(#ddd,#555))}button:focus-visible{outline:2px solid #3888ff;outline-offset:3px}[hidden]{display:none!important}@media(max-width:380px){main{align-items:flex-start;flex-direction:column;gap:12px}nav{flex-wrap:wrap}}
</style>
<main id="card"><section><h2 id="title">Connect your integration</h2><p id="status" role="status" aria-live="polite">Preparing connection…</p></section><nav aria-label="Connection actions"><button id="connect" disabled>Connect</button><button id="check" hidden>Try again</button></nav></main>
<script>
(() => {
  const title = document.getElementById('title'), status = document.getElementById('status');
  const connect = document.getElementById('connect'), check = document.getElementById('check');
  const pending = new Map(); let next = 1, data, timer, checking = false, checkFailed = false, active = false, sent = false, ready = false;
  const names = {slack:'Slack',github:'GitHub',gcp:'Google Cloud',posthog:'PostHog',sentry:'Sentry',linear:'Linear',discord:'Discord',vercel:'Vercel',axiom:'Axiom'};
  function request(method, params) {
    const id = next++;
    return new Promise((resolve,reject) => {
      const timeout = setTimeout(() => {pending.delete(id);reject(Error('Host unavailable'));},15000);
      pending.set(id,{resolve,reject,timeout});
      window.parent.postMessage({jsonrpc:'2.0',id,method,params},'*');
    });
  }
  function persist() {
    window.openai?.setWidgetState?.({connection: data?.handoffUrl || data?.url, active, sent});
  }
  function parse(result) {
    if (result?.isError) throw Error('Connection check failed');
    if (result?.structuredContent) return result.structuredContent;
    const text = result?.content?.find(item => item.type === 'text')?.text;
    return text ? JSON.parse(text) : result;
  }
  function render(value) {
    if (!value?.provider || !value.url) return;
    data = value;
    const saved = window.openai?.widgetState;
    if (saved?.connection === (data.handoffUrl || data.url)) {active = saved.active === true;sent = saved.sent === true;}
    title.textContent = 'Connect ' + (names[data.provider] || data.provider);
    status.textContent = data.connectionType === 'secure_setup'
      ? 'Finish setup securely in Superlog.'
      : 'Choose your workspace and approve access.';
    connect.textContent = data.connectionType === 'secure_setup' ? 'Open secure setup' : 'Connect ' + (names[data.provider] || data.provider);
    connect.disabled = false;
    check.hidden = !checkFailed;
    if(checkFailed)status.textContent="Couldn’t verify access. Try again.";
    connect.hidden = false;
    if (sent) {status.textContent='Connected. Continue in the conversation.';connect.hidden=true;check.hidden=true;}
    else if (data.status === 'connected') {active=true;checkConnection();}
    else if (active) schedule();
  }
  function schedule() {clearTimeout(timer);if(active && !sent) timer=setTimeout(checkConnection,3000);}
  async function followUp() {
    if(sent)return;
    sent=true;persist();
    const prompt=(names[data.provider] || data.provider)+' is connected to my Superlog workspace. Verify its resources and continue our setup from where we left off.';
    try {
      if (ready) await request('ui/message',{role:'user',content:[{type:'text',text:prompt}]});
      else if (window.openai?.sendFollowUpMessage) await window.openai.sendFollowUpMessage({prompt});
      else throw Error('Follow-up unavailable');
      status.textContent='Connected. Continuing in the conversation…';check.hidden=true;
    } catch {
      status.textContent='Connected. Tell the chat “continue” to pick up your setup.';
      check.hidden=true;
    }
  }
  async function checkConnection() {
    if(checking || !data || sent)return;
    if(data.expiresAt && Date.now()>Date.parse(data.expiresAt)) {
      active=false;clearTimeout(timer);status.textContent='This link has expired. Ask the chat to check your connection or create a fresh link.';connect.disabled=true;return;
    }
    checking=true;check.disabled=true;
    try {
      const result=parse(window.openai?.callTool
        ? await window.openai.callTool('list_integrations',{})
        : await request('tools/call',{name:'list_integrations',arguments:{}}));
      checkFailed=false;check.hidden=true;
      if(result.integrations?.some(account => account.provider === data.provider)) {
        active=false;clearTimeout(timer);connect.hidden=true;
        status.textContent='Connected successfully.';
        await followUp();
      } else status.textContent='Waiting for approval…';
    } catch {status.textContent='Couldn’t verify access. Try again.';active=false;checkFailed=true;check.hidden=false;}
    finally {checking=false;check.disabled=false;schedule();}
  }
  connect.onclick=async()=>{
    if(data.expiresAt && Date.now()>=Date.parse(data.expiresAt)) {
      active=false;clearTimeout(timer);persist();connect.disabled=true;
      status.textContent='This link has expired. Ask the chat for a fresh connection link.';return;
    }
    active=true;persist();
    try {
      // The host appends a trusted conversation return address to our handoff
      // endpoint. Never append that address to the provider's consent URL.
      if(window.openai?.openExternal) await window.openai.openExternal({href:data.handoffUrl || data.url});
      else await request('ui/open-link',{url:data.handoffUrl || data.url});
      status.textContent='Waiting for approval…';
      schedule();
    } catch {active=false;persist();status.textContent='Couldn’t open authorization. Try Connect again.';}
  };
  check.onclick=()=>{active=true;persist();return checkConnection();};
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible' && active)checkConnection();});
  window.addEventListener('message',event=>{
    if(event.source!==window.parent)return;
    const message=event.data;if(!message || message.jsonrpc!=='2.0')return;
    const item=pending.get(message.id);
    if(item){pending.delete(message.id);clearTimeout(item.timeout);message.error?item.reject(message.error):item.resolve(message.result);return;}
    if(message.method==='ui/notifications/tool-result')render(parse(message.params));
  });
  window.addEventListener('openai:set_globals',()=>render(window.openai?.toolOutput));
  function resize() {
    const height=Math.ceil(document.getElementById('card').getBoundingClientRect().height);
    window.openai?.notifyIntrinsicHeight?.();
    if(ready)window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{height}},'*');
  }
  if(typeof ResizeObserver!=='undefined')new ResizeObserver(resize).observe(document.getElementById('card'));
  render(window.openai?.toolOutput);
  request('ui/initialize',{protocolVersion:'2026-01-26',appInfo:{name:'Superlog connection',version:'1.0.0'},appCapabilities:{}})
    .then(()=>{ready=true;window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*');resize();})
    .catch(()=>{});
})();
</script></html>`;

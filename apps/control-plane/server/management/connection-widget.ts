export const connectionWidgetUri = "ui://superlog/integration-connection.html";

export const connectionWidgetHtml = String.raw`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>:root{color-scheme:light dark}body{font:14px/1.5 system-ui;margin:0;padding:18px;color:var(--text-primary,inherit)}h2{font-size:17px;margin:0 0 6px}p{margin:0 0 14px;opacity:.8}button{font:inherit;border:0;border-radius:8px;padding:9px 14px;background:#245de1;color:white;cursor:pointer}button:disabled{opacity:.5;cursor:default}#check{background:transparent;color:inherit;border:1px solid #8886;margin-left:6px}button:focus-visible{outline:2px solid #699cff;outline-offset:3px}</style>
<h2 id="title">Connect your integration</h2><p id="status" role="status" aria-live="polite">Preparing your connection…</p>
<button id="connect" disabled>Connect</button><button id="check" hidden>Check connection</button>
<script>
(() => {
  const title = document.getElementById('title'), status = document.getElementById('status');
  const connect = document.getElementById('connect'), check = document.getElementById('check');
  const pending = new Map(); let next = 1, data, timer, checking = false, active = false, sent = false, ready = false;
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
      ? 'Complete secure setup, then return here. Keep credentials out of chat.'
      : 'Approve access in the next window. We’ll check the connection and continue setup here.';
    connect.textContent = data.connectionType === 'secure_setup' ? 'Open secure setup' : 'Connect ' + (names[data.provider] || data.provider);
    connect.disabled = false;
    check.hidden = false;
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
      if(result.integrations?.some(account => account.provider === data.provider)) {
        active=false;clearTimeout(timer);connect.hidden=true;
        status.textContent='Connected successfully.';
        await followUp();
      } else status.textContent='Waiting for authorization. Complete it in the other window, then return here.';
    } catch {status.textContent='Couldn’t check the connection yet. Try Check connection again.';active=false;}
    finally {checking=false;check.disabled=false;schedule();}
  }
  connect.onclick=async()=>{
    active=true;persist();
    try {
      // The host appends a trusted conversation return address to our handoff
      // endpoint. Never append that address to the provider's consent URL.
      if(window.openai?.openExternal) await window.openai.openExternal({href:data.handoffUrl || data.url});
      else await request('ui/open-link',{url:data.handoffUrl || data.url});
      status.textContent='Approve access in the other window. We’ll continue when the connection is ready.';
      schedule();
    } catch {active=false;persist();status.textContent='Couldn’t open authorization. Use the connection link in the conversation.';}
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
  render(window.openai?.toolOutput);
  request('ui/initialize',{protocolVersion:'2026-01-26',appInfo:{name:'Superlog connection',version:'1.0.0'},appCapabilities:{}})
    .then(()=>{ready=true;window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*');})
    .catch(()=>{});
})();
</script></html>`;

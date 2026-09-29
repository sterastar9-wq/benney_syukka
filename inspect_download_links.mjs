async function cdp(ws, method, params = {}) {
  const payload = { id: ++cdp.nextId, method, params };
  ws.send(JSON.stringify(payload));
  return await new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== payload.id) return;
      ws.removeEventListener("message", onMessage);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    };
    ws.addEventListener("message", onMessage);
  });
}
cdp.nextId = 0;

const tabs = await fetch("http://localhost:9222/json").then(r => r.json());
const tab = tabs.find(t => t.type === "page" && /order\.goqsystem\.com\/goq21\/downloadpage\.php/.test(t.url));
if (!tab) throw new Error("download page tab not found");

const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
await cdp(ws, "Runtime.enable");
await cdp(ws, "Page.bringToFront");
const result = await cdp(ws, "Runtime.evaluate", {
  awaitPromise: true,
  returnByValue: true,
  expression: `(() => {
    const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
    const links = [...document.querySelectorAll('a')].map(a => ({
      text: norm(a.innerText || a.textContent),
      href: a.href,
      row: norm((a.closest('tr') || a.parentElement || a).innerText || '').slice(0, 1000)
    })).filter(x => x.text || x.href);
    const body = norm(document.body.innerText || '');
    return {
      url: location.href,
      title: document.title,
      links,
      pdfLinks: links.filter(x => /pdf|b2|ネコポス|発払い|コンパクト|A4|マルチ/i.test(decodeURIComponent(x.href + ' ' + x.text + ' ' + x.row))),
      errors: body.split(' ').filter(x => /失敗|エラー|ES\\d+|送り状/.test(x)).slice(0, 120),
      bodyTail: body.slice(-3000)
    };
  })()`
});
console.log(JSON.stringify(result.result.value, null, 2));
ws.close();

const destination = process.argv[2];
if (!destination) throw new Error("destination required");

async function cdp(method, params = {}) {
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
const tab = tabs.find(t => t.type === "page" && t.url === "chrome://print/");
if (!tab) throw new Error("print preview tab not found");

const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
await cdp("Runtime.enable");
await cdp("Input.enable").catch(() => {});

const prep = await cdp("Runtime.evaluate", {
  awaitPromise: true,
  returnByValue: true,
  expression: `(() => {
    const wanted = ${JSON.stringify(destination)};
    const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
    const seen = new Set();
    const nodes = [];
    function walk(node) {
      if (!node || seen.has(node)) return;
      seen.add(node);
      if (node.nodeType === 1) {
        nodes.push(node);
        if (node.shadowRoot) walk(node.shadowRoot);
      }
      for (const child of node.childNodes || []) walk(child);
    }
    walk(document);
    const textNode = nodes.find(el => {
      const r = el.getBoundingClientRect?.() || {};
      return (r.width || 0) > 0 && (r.height || 0) > 0 && norm(el.innerText || el.textContent) === wanted;
    });
    if (!textNode) return { ok: false, reason: 'text_not_found' };
    let el = textNode;
    const candidates = [];
    while (el) {
      const r = el.getBoundingClientRect?.() || {};
      const text = norm(el.innerText || el.textContent);
      if ((r.width || 0) > 0 && (r.height || 0) > 0) {
        candidates.push({ tag: el.tagName, text, x: r.x, y: r.y, w: r.width, h: r.height });
      }
      if (/DESTINATION|LIST|ITEM|BUTTON|OPTION/.test(el.tagName || '') || el.getAttribute?.('role')) break;
      el = el.parentElement || el.getRootNode()?.host;
    }
    const hit = candidates.find(c => c.w > 200 && c.h >= 28) || candidates[candidates.length - 1];
    return { ok: true, x: Math.round(hit.x + hit.w / 2), y: Math.round(hit.y + hit.h / 2), hit, candidates };
  })()`
});

const value = prep.result.value;
if (!value.ok) {
  console.log(JSON.stringify(value, null, 2));
  process.exit(1);
}

await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: value.x, y: value.y, button: "none" });
await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: value.x, y: value.y, button: "left", clickCount: 1 });
await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: value.x, y: value.y, button: "left", clickCount: 1 });
await new Promise(r => setTimeout(r, 2500));

const after = await cdp("Runtime.evaluate", {
  awaitPromise: true,
  returnByValue: true,
  expression: `(() => {
    const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
    const seen = new Set();
    const nodes = [];
    function walk(node) {
      if (!node || seen.has(node)) return;
      seen.add(node);
      if (node.nodeType === 1) {
        nodes.push(node);
        if (node.shadowRoot) walk(node.shadowRoot);
      }
      for (const child of node.childNodes || []) walk(child);
    }
    walk(document);
    return nodes.filter(el => el.tagName === 'SELECT').map(sel => ({
      selectedText: sel.selectedOptions?.[0] ? norm(sel.selectedOptions[0].textContent) : '',
      value: sel.value
    })).slice(0, 3);
  })()`
});

console.log(JSON.stringify({ ok: true, destination, click: value, after: after.result.value }, null, 2));
ws.close();

const needle = process.argv[2] || "";

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
const tab = tabs.find(t =>
  t.type === "page" &&
  /pdf/i.test(decodeURIComponent(t.url + " " + t.title)) &&
  (!needle || decodeURIComponent(t.url + " " + t.title).includes(needle))
);
if (!tab) throw new Error(`PDF tab not found for ${needle}`);

const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
await cdp(ws, "Runtime.enable");
await cdp(ws, "Page.bringToFront");
await cdp(ws, "Runtime.evaluate", { expression: "window.print()", awaitPromise: false });
await new Promise(r => setTimeout(r, 5000));
const after = await fetch("http://localhost:9222/json").then(r => r.json());
console.log(JSON.stringify({
  ok: after.some(t => t.type === "page" && t.url === "chrome://print/"),
  target: { title: tab.title, url: tab.url },
  printTabs: after.filter(t => t.type === "page" && t.url === "chrome://print/").map(t => ({ title: t.title, url: t.url })),
}, null, 2));
ws.close();

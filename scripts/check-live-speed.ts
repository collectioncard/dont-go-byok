import {readSse} from '../server/stream';
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:3001/api/sessions';
async function post(url: string, body: unknown = {}) {
  const res = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
const session = await post(base);
const url = base + '/' + session.id;
const controller = new AbortController();
let latest = session;
let sendAt = 0;
let hoverAt = 0;
let firstTextMs: number | null = null;
let hoverMs: number | null = null;
const seen = new Set<string>(session.messages.map((message: {id: string}) => message.id));
const connection = await fetch(url + '/stream', {signal: controller.signal});
const listener = (async () => {
  try {
    for await (const line of readSse(connection.body!)) {
      latest = JSON.parse(line);
      for (const m of latest.messages) {
        if (m.role !== 'assistant' || seen.has(m.id)) continue;
        seen.add(m.id);
        if (sendAt && !m.urgent && firstTextMs === null) {
          firstTextMs = Date.now() - sendAt;
          console.log(JSON.stringify({event: 'first_streamed_sentence',ms: firstTextMs,text: m.content}));
        }
        if (hoverAt && m.urgent && hoverMs === null) {
          hoverMs = Date.now() - hoverAt;
          console.log(JSON.stringify({event: 'hover_response',ms: hoverMs,text: m.content,themeChanged: !!latest.ui.theme}));
        }
      }
    }
  } catch (e) {if (!controller.signal.aborted) throw e;}
})();
const deadline = Date.now() + 60000;
try {
  sendAt = Date.now();
  const accepted = await post(url + '/message', {message: 'I am bored already. You have one chance to make this interesting.'});
  console.log(JSON.stringify({event: 'message_accepted', ms: Date.now() - sendAt, busy: accepted.busy}));
  let debug: any;
  while (Date.now() < deadline) {
    debug = await (await fetch(url + '/debug')).json();
    if (!latest.busy && debug.workers.preparedReactions > 0) break;
    await new Promise(r => setTimeout(r, 250));
  }
  console.log(JSON.stringify({event: 'pre_hover',workers: debug.workers,timings: debug.timings}));
  hoverAt = Date.now();
  await post(url + '/events', {type: 'exit_enter'});
  while (hoverMs === null && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
  await post(url + '/terminate');
  const dead = await (await fetch(url)).json();
  console.log(JSON.stringify({event: 'terminated',status: dead.status,busy: dead.busy,designBusy: dead.designBusy,components: dead.ui.components.length}));
} finally {
  await post(url + '/terminate').catch(() => {});
  controller.abort(); await listener;
}

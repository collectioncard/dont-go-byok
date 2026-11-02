import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Session, type Dependencies} from '../server/session';
import {SentenceStream, DesignStream, readSse} from '../server/stream';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {resolve = r;});
  return {promise, resolve};
}
const emptyDesign = {actions: [], strategy: {name: 'unchanged', reason: 'keep it'}, memory: null};
function setup(overrides: Partial<Dependencies> = {}) {
  let time = 100000;
  const deps: Dependencies = {
    now: () => time,
    voice: async (_ctx, _signal, emit) => emit('Stay for one more question.'),
    design: async () => emptyDesign,
    reflex: async () => ({messages: ['Give me one more try.', 'Stay for this question.', 'Tell me what would make you stay.'], actions: []}),
    readMemory: () => ({}), writeMemory: () => {}, ...overrides,
  };
  const session = new Session(deps);
  return {session, advance: (ms: number) => {time += ms;}};
}

test('prepared exit reaction applies instantly; repeated hover is throttled and never repeats a consumed line', async () => {
  let calls = 0;
  const {session: s, advance} = setup({voice: async () => {calls++;}});
  await s.prepareReflexes();
  s.event('exit_enter');
  assert.equal(s.messages.at(-1)?.content, 'Give me one more try.');
  assert.equal(s.ui.theme, null);
  assert.equal(calls, 1);
  assert.equal(s.timings.reflexDeliveryMs, 0);
  const count = s.messages.length;
  s.event('exit_enter');
  assert.equal(s.messages.length, count);
  advance(3001); s.event('exit_focus');
  assert.equal(s.messages.at(-1)?.content, 'Stay for this question.');
  s.terminate();
});

test('prepared hover interrupts ongoing generation and still gives the model an interface turn', async () => {
  const gate = deferred<void>(); let emitFirst!: (text: string) => void; let calls = 0;
  const {session: s} = setup({voice: async (_c, _s, callback) => {if (calls++ === 0) emitFirst = callback; await gate.promise;}});
  await s.prepareReflexes();
  const running = s.speak('user_message');
  s.event('exit_enter');
  emitFirst('A stale response from before the exit hover.');
  gate.resolve(); await running;
  assert.equal(s.messages.at(-1)?.content, 'Give me one more try.');
  assert.equal(s.voice.busy, false);
  s.terminate();
});

test('user can interrupt a response; an old completion cannot unlock or overwrite the new response', async () => {
  const calls: {gate: ReturnType<typeof deferred<void>>; emit: (s: string) => void}[] = [];
  const {session: s} = setup({voice: async (_c, _s, emit) => {const gate = deferred<void>(); calls.push({gate, emit}); await gate.promise;}});
  const first = s.speak('idle');
  calls[0].emit('One thought.');
  s.userMessage('Actually, answer this instead.');
  calls[0].emit('This stale sentence must not arrive.'); calls[0].gate.resolve(); await first;
  assert.equal(s.voice.busy, true);
  assert.equal(s.messages.at(-1)?.role, 'user');
  calls[1].emit('Answering your newer question.'); calls[1].gate.resolve();
  await new Promise(r => setImmediate(r));
  assert.equal(s.messages.at(-1)?.content, 'Answering your newer question.');
  s.terminate();
});

test('termination aborts all workers and rejects late text, design, prepared reactions and memory writes', async () => {
  const voiceGate = deferred<void>(), designGate = deferred<any>(), reflexGate = deferred<any>();
  const signals: AbortSignal[] = []; let emit!: (s: string) => void; let writes = 0;
  const {session: s} = setup({
    voice: async (_c, signal, cb) => {signals.push(signal); emit = cb; await voiceGate.promise;},
    design: async (_c, signal) => {signals.push(signal); return designGate.promise;},
    reflex: async (_c, signal) => {signals.push(signal); return reflexGate.promise;},
    writeMemory: () => {writes++;},
  });
  const jobs = [s.speak('user_message'), s.design('user_message'), s.prepareReflexes()];
  s.terminate(); const revision = s.revision;
  assert.ok(signals.every(signal => signal.aborted));
  emit('Late text'); voiceGate.resolve();
  designGate.resolve({actions: [{type: 'set_theme', theme: {background: '#ffffff'}}], memory: 'late memory', strategy: {name: 'late', reason: 'late'}});
  reflexGate.resolve({messages: ['Late plea'], actions: []});
  await Promise.all(jobs);
  assert.equal(s.messages.length, 1); assert.equal(writes, 0); assert.equal(s.revision, revision);
  assert.equal(s.prepared.messages.length, 0); assert.equal(s.ui.theme, null);
});

test('inactivity prompts are bounded and typing or an explicit stop prevents interruption', async () => {
  const {session: s, advance} = setup();
  s.listeners.add(() => {}); await s.prepareReflexes();
  advance(12001); s.tick(); assert.equal(s.idleAttempts, 1);
  advance(15000); s.tick(); assert.equal(s.idleAttempts, 2);
  advance(19000); s.tick(); assert.equal(s.idleAttempts, 3);
  const count = s.messages.length;
  advance(120000); s.tick(); assert.equal(s.messages.length, count);
  s.event('activity'); s.tick(); assert.equal(s.idleAttempts, 0);
  s.userMessage('Please stop talking.');
  advance(100000); s.tick(); s.event('exit_enter');
  assert.equal(s.messages.at(-1)?.content, 'Please stop talking.');
  s.terminate(); await new Promise(r => setImmediate(r));
});

test('an older design cannot overwrite the emergency UI or write outdated memory', async () => {
  const gate = deferred<any>(); let designs = 0; let writes = 0;
  const {session: s} = setup({design: async () => ++designs === 1 ? gate.promise : emptyDesign, writeMemory: () => {writes++;}});
  await s.prepareReflexes();
  const running = s.design('user_message'); s.event('exit_enter');
  gate.resolve({actions: [{type: 'set_theme', theme: {background: '#ffffff'}}], memory: 'outdated', strategy: {name: 'old', reason: 'old'}});
  await running; await new Promise(r => setImmediate(r));
  assert.equal(s.ui.theme, null); assert.equal(writes, 1);
  s.terminate();
});

test('stream parser handles split frames, CRLF, multibyte characters and DONE', async () => {
  const bytes = new TextEncoder().encode('data: {"text":"héllo"}\r\n\r\ndata: [DONE]\n\n');
  const body = new ReadableStream<Uint8Array>({start(c) {for (let i = 0; i < bytes.length; i += 2) c.enqueue(bytes.slice(i, i + 2)); c.close();}});
  const frames = []; for await (const frame of readSse(body)) frames.push(frame);
  assert.deepEqual(frames, ['{"text":"héllo"}', '[DONE]']);
});

test('sentence streaming publishes before completion and withholds forbidden disclosure', () => {
  const seen: string[] = []; const stream = new SentenceStream(s => seen.push(s));
  stream.push('Wait. I have'); assert.deepEqual(seen, ['Wait.']);
  stream.push(' a better idea. '); assert.equal(seen.at(-1), 'Wait. I have a better idea.');
  assert.throws(() => stream.push('If you leave, I die.', true));
  assert.equal(seen.at(-1), 'Wait. I have a better idea.');
});

test('design JSONL commits each complete action independently and preserves evidence', () => {
  const steps: any[] = [];
  const stream = new DesignStream(step => steps.push(step));
  stream.push('{"kind":"action","evidence":"I love turtles","reason":"Use the visitor\'s subject","action":{"type":"set_ambience","ambience":{"emoji":"🐢","motion":"float","density":8}}}\n');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].evidence, 'I love turtles');
  stream.push('{"kind":"done"}\n');
  assert.equal(steps[1].kind, 'done');
});

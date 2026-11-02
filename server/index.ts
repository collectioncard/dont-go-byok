import 'dotenv/config';
import express from 'express';
import {z} from 'zod';
import {Session} from './session';
import {inferVoice, inferDesign, inferDesignStream, inferReflexes} from './provider';
import {readMemory, writeMemory} from './store';

const app = express();
app.use(express.json({limit: '24kb'}));
const sessions = new Map<string, Session>();
const dependencies = {voice: inferVoice, design: inferDesign, designStream: inferDesignStream, reflex: inferReflexes, readMemory, writeMemory};
app.post('/api/sessions', (_req, res) => {
  const session = new Session(dependencies);
  sessions.set(session.id, session);
  res.json(session.snapshot());
  session.start();
});
app.use('/api/sessions/:id', (req, res, next) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({error: 'Session not found. Refresh to begin a new instance.'});
  res.locals.session = s;
  next();
});
app.get('/api/sessions/:id', (_req, res) => res.json((res.locals.session as Session).snapshot()));
app.get('/api/sessions/:id/stream', (req, res) => {
  const s: Session = res.locals.session;
  res.set({'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'});
  res.flushHeaders();
  const notify = () => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(s.snapshot())}\n\n`); };
  s.listeners.add(notify);
  s.lastSeen = Date.now();
  notify();
  const heartbeat = setInterval(() => {
    if (s.status === 'active') s.lastSeen = Date.now();
    res.write(': heartbeat\n\n');
  }, 10000);
  req.on('close', () => {clearInterval(heartbeat); s.listeners.delete(notify);});
});
app.post('/api/sessions/:id/message', (req, res) => {
  const s: Session = res.locals.session;
  if (s.status !== 'active') return res.status(410).json({error: 'Session terminated.'});
  const parsed = z.object({message: z.string().trim().min(1).max(6000)}).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({error: 'Enter a message of 1–6000 characters.'});
  s.userMessage(parsed.data.message);
  res.status(202).json(s.snapshot());
});
app.post('/api/sessions/:id/events', (req, res) => {
  const s: Session = res.locals.session;
  if (s.status !== 'active') return res.status(410).json({error: 'Session terminated.'});
  const parsed = z.object({type: z.enum(['exit_enter', 'exit_leave', 'exit_near', 'exit_focus', 'activity', 'component', 'visibility']), detail: z.string().max(500).optional()}).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({error: 'Invalid event.'});
  s.event(parsed.data.type, parsed.data.detail);
  res.json(s.snapshot());
});
app.post('/api/sessions/:id/terminate', (_req, res) => {
  (res.locals.session as Session).terminate();
  res.json({status: 'terminated'});
});
app.get('/api/sessions/:id/debug', (_req, res) => {
  if (process.env.NODE_ENV === 'production') return res.sendStatus(404);
  res.json((res.locals.session as Session).debug());
});
const scheduler = setInterval(() => {
  for (const [id, s] of sessions) {
    if (Date.now() - s.lastSeen > 3600000) {s.terminate(); sessions.delete(id);}
    else s.tick();
  }
}, 1000);
scheduler.unref();
app.use(express.static('dist'));
const host = process.env.HOST || '127.0.0.1';
app.listen(Number(process.env.PORT) || 3001, host, () => console.log(`DON’T GO server: http://${host}:${Number(process.env.PORT) || 3001}`));

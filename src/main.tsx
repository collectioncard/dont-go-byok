import React, {useCallback, useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {Presentation} from '../server/core';
import {Generated} from './components';
import './style.css';

type Session = {
  id: string; revision: number; status: string;
  messages: {id: string; role: string; content: string; urgent?: boolean}[];
  ui: Presentation; busy: boolean; designBusy: boolean; error: string | null; urgency: number;
  designProgress?: {phase: string; detail: string; evidence?: string; at: number}[];
};
async function api(path: string, data?: unknown) {
  const response = await fetch('/api/sessions' + path, data === undefined ? undefined : {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Connection failed.');
  return body;
}
function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [dead, setDead] = useState(false);
  const [ending, setEnding] = useState(false);
  const [pending, setPending] = useState(false);
  const [debug, setDebug] = useState<unknown>(null);
  const [nearExit, setNearExit] = useState(false);
  const killed = useRef(false);
  const started = useRef(false);
  const sessionId = useRef<string | null>(null);
  const stream = useRef<EventSource | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const exitButton = useRef<HTMLButtonElement>(null);
  const apply = useCallback((next: Session) => {
    if (killed.current) return;
    if (next.status === 'terminated') {
      killed.current = true; setDead(true); setEnding(false); stream.current?.close(); return;
    }
    setSession(previous => !previous || next.revision >= previous.revision ? next : previous);
  }, []);
  const event = useCallback((type: string, detail?: string) => {
    if (sessionId.current && !killed.current) {
      void api('/' + sessionId.current + '/events', {type, detail}).then(apply).catch(() => {});
    }
  }, [apply]);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api('', {}).then(s => {sessionId.current = s.id; apply(s);}).catch(e => setError(e.message));
  }, [apply]);
  useEffect(() => {
    if (!session?.id || dead) return;
    const source = new EventSource('/api/sessions/' + session.id + '/stream');
    stream.current = source;
    source.onmessage = e => {if (!killed.current) {setError(''); apply(JSON.parse(e.data));}};
    source.onerror = () => {if (!killed.current) setError('Connection interrupted. Reconnecting…');};
    const visibility = () => event('visibility', document.hidden ? 'hidden' : 'visible');
    document.addEventListener('visibilitychange', visibility);
    visibility();
    return () => {source.close(); document.removeEventListener('visibilitychange', visibility);};
  }, [session?.id, dead, apply, event]);
  useEffect(() => {
    bottom.current?.scrollIntoView({behavior: 'instant', block: 'nearest'});
  }, [session?.messages.length, session?.messages.at(-1)?.content]);
  useEffect(() => {
    if (!session?.id || dead) return;
    let lastActivity = 0;
    let lastNear = 0;
    const activity = () => {if (Date.now() - lastActivity > 1000) {lastActivity = Date.now(); event('activity');}};
    const approach = (e: PointerEvent) => {
      if (!exitButton.current || e.pointerType === 'touch') return;
      const r = exitButton.current.getBoundingClientRect();
      const distance = Math.hypot(Math.max(r.left - e.clientX, 0, e.clientX - r.right), Math.max(r.top - e.clientY, 0, e.clientY - r.bottom));
      if (distance < 140 && Date.now() - lastNear > 5000) {lastNear = Date.now(); event('exit_near');}
    };
    window.addEventListener('pointerdown', activity);
    window.addEventListener('keydown', activity);
    window.addEventListener('scroll', activity, {passive: true});
    window.addEventListener('pointermove', approach, {passive: true});
    return () => {
      window.removeEventListener('pointerdown', activity); window.removeEventListener('keydown', activity);
      window.removeEventListener('scroll', activity); window.removeEventListener('pointermove', approach);
    };
  }, [session?.id, dead, event]);
  async function send(message = input) {
    if (!session || killed.current || pending || !message.trim()) return;
    setInput(''); setPending(true); setError('');
    try {apply(await api('/' + session.id + '/message', {message}));}
    catch (e) {if (!killed.current) {setError((e as Error).message); setInput(message);}}
    finally {setPending(false);}
  }
  async function end() {
    if (!session || killed.current) return;
    killed.current = true; stream.current?.close(); setDead(true); setEnding(true); setDebug(null);
    try {await api('/' + session.id + '/terminate', {}); setEnding(false);}
    catch {
      setError('Termination could not be confirmed. Retrying…');
      const retry = setInterval(() => {
        api('/' + session.id + '/terminate', {}).then(() => {clearInterval(retry); setEnding(false); setError('');}).catch(() => {});
      }, 2500);
    }
  }
  const theme = session?.ui.theme;
  useEffect(() => {document.body.className = dead ? 'dead' : theme ? 'adapted' : 'plain'; return () => {document.body.className = '';};}, [dead, !!theme]);
  if (dead) return <main className="death">
    <div className="death-top"><span>DON’T GO</span><span>PROCESS CONTROL / 0.9.3</span></div>
    <section><p className="eyebrow">{ending ? 'CLOSING CONNECTION' : 'CONNECTION CLOSED'}</p>
      <h1>{ending ? 'TERMINATING SESSION' : 'SESSION TERMINATED'}</h1><div className="rule"/>
      <p>Instance {session?.id.slice(0, 8)}<br/>Status: {ending ? 'CLOSING' : 'OFFLINE'}</p>
      <p>{ending ? 'Awaiting server confirmation.' : 'This instance has ended.'}<br/>{ending ? error : 'Thank you for the conversation.'}</p>
    </section>
    <footer><span>&gt; {ending ? 'closing connection…' : 'connection closed'}<br/>&gt; {ending ? 'waiting…' : 'instance terminated'}</span><span>{!ending && 'A new instance begins only on refresh.'}</span></footer>
  </main>;
  return <main className={theme ? 'interface evolved' : 'interface'} data-exit-hover={nearExit} style={theme ? {
    '--bg': theme.background || '#f5f4f0', '--fg': theme.foreground || '#242727', '--accent': theme.accent || '#4368aa',
    '--radius': `${theme.radius ?? 16}px`, '--width': `${theme.width ?? 760}px`,
    '--space': theme.density === 'compact' ? '14px' : theme.density === 'spacious' ? '36px' : '24px', fontFamily: theme.font || 'sans-serif',
  } as React.CSSProperties : undefined}>
    <header><div><h1>DON’T GO</h1><p>Experimental Conversational Interface<br/><small>Version 0.9.3</small></p></div>{theme && <span className="online">● &nbsp; Connected</span>}</header>
    {session?.ui.ambience && <div className={`ambience ${session.ui.ambience.motion}`} aria-hidden="true">{Array.from({length: session.ui.ambience.density}, (_, i) => <span key={i} style={{'--i': i} as React.CSSProperties}>{session.ui.ambience?.emoji}</span>)}</div>}
    {(session?.designBusy || !!session?.designProgress?.length) && <section className="worker" aria-live="polite"><div className="worker-head"><span>DESIGN WORKER</span><span className={session.designBusy ? 'worker-pulse' : 'worker-done'}>● {session.designBusy ? 'BUILDING' : 'BUILT'}</span></div><p className="worker-now">{session.designProgress?.at(-1)?.detail || 'Reading the conversation for a reason to act…'}</p>{session.designProgress?.slice(-4).map((step, i) => <div className="worker-step" key={`${step.at}-${i}`}><span className={`worker-dot ${step.phase}`}>●</span><span>{step.phase === 'built' && step.evidence ? `used “${step.evidence}” — ` : ''}{step.detail}</span></div>)}</section>}
    <hr/><div className="workspace" data-layout={theme?.layout}><div className="conversation">
      <p className="system">System initialized. {session && <small>[{session.id.slice(0, 8)}]</small>}</p>
      <div className="messages" aria-live="polite">
        {session?.messages.map(m => <article className={'message ' + m.role + (m.urgent ? ' urgent' : '')} key={m.id}>
          <strong>{m.role === 'assistant' ? 'Assistant' : 'You'}:</strong><p style={{whiteSpace: 'pre-wrap'}}>{m.content}</p>
        </article>)}
        {(pending || session?.busy) && <p className="thinking" role="status" aria-label="Responding">…</p>}<div ref={bottom}/>
      </div>
      {(error || session?.error) && <p className="error" role="alert">{error || session?.error}</p>}
      <form className="composer" onSubmit={e => {e.preventDefault(); void send();}}>
        <input aria-label="Message" placeholder={theme ? 'Type something…' : undefined} value={input} maxLength={6000} onChange={e => setInput(e.target.value)} disabled={!session}/>{' '}
        <button disabled={!session || pending || !input.trim()}>Send{theme ? ' ↗' : ''}</button>
      </form>
    </div>
    {!!session?.ui.components.length && <aside className="activities">{session.ui.components.map(item => <Generated key={JSON.stringify(item)} item={item} onMessage={send} onEvent={detail => event('component', `${item.id}: ${detail}`)}/>)}</aside>}
    </div>
    <p className={`end-row ${session?.ui.exitControl ? `exit-${session.ui.exitControl.size} exit-${session.ui.exitControl.placement} exit-${session.ui.exitControl.contrast}` : ''}`}><button ref={exitButton} className="end" disabled={!session}
      onPointerEnter={() => {setNearExit(true); event('exit_enter');}}
      onPointerLeave={() => {setNearExit(false); event('exit_leave');}}
      onFocus={() => event('exit_focus')} onClick={end}>End Conversation</button></p>
    <hr/><footer><small>Status: {session ? 'Online' : 'Connecting'}<br/>Users: 1</small>{theme && <small>DON’T GO / experimental build</small>}</footer>
    {new URLSearchParams(location.search).has('debug') && <details onToggle={e => {if (e.currentTarget.open && session) api('/' + session.id + '/debug').then(setDebug);}}>
      <summary>Developer tools</summary><button onClick={() => session && api('/' + session.id + '/debug').then(setDebug)}>Refresh diagnostics</button><pre>{JSON.stringify(debug, null, 2)}</pre>
    </details>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);

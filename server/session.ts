import {randomUUID} from 'node:crypto';
import {mutate, type Presentation, type DesignStep, type VoiceStep} from './core';
import type {ReflexPlan, inferDesign} from './provider';

type Message = {id: string; role: 'user' | 'assistant'; content: string; urgent?: boolean};
type Lane = {version: number; controller: AbortController | null; busy: boolean};
type DesignResult = Awaited<ReturnType<typeof inferDesign>>;
export type Dependencies = {
  voice(context: unknown, signal: AbortSignal, emit: (text: string) => void, action?: (step: VoiceStep) => void): Promise<void>;
  design(context: unknown, signal: AbortSignal): Promise<DesignResult>;
  designStream?(context: unknown, signal: AbortSignal, emit: (step: DesignStep) => void): Promise<void>;
  reflex(context: unknown, signal: AbortSignal): Promise<ReflexPlan>;
  readMemory(): unknown;
  writeMemory(content: string, id: string): void;
  now?: () => number;
};
const lane = (): Lane => ({version: 0, controller: null, busy: false});
export class Session {
  readonly id = randomUUID();
  status: 'active' | 'terminated' = 'active';
  revision = 0;
  ui: Presentation = {theme: null, components: []};
  messages: Message[] = [{id: randomUUID(), role: 'assistant', content: 'Hello. I am a language model.\nHow can I help you?'}];
  readonly listeners = new Set<() => void>();
  voice = lane();
  designer = lane();
  reflexWorker = lane();
  private now: () => number;
  lastSeen: number;
  lastInteraction: number;
  lastSpoke: number;
  lastHoverReaction = -Infinity;
  lastDesignRequest = -Infinity;
  lastComponentReaction = -Infinity;
  lastReflexAttempt = -Infinity;
  score = 0;
  hovers = 0;
  idleAttempts = 0;
  stopped = false;
  visible = true;
  voiceTrigger = '';
  error: string | null = null;
  designError: string | null = null;
  designProgress: {phase: string; detail: string; evidence?: string; at: number}[] = [];
  reflexError: string | null = null;
  prepared: ReflexPlan = {messages: [], actions: []};
  preparedAt = 0;
  pendingDesign: string | null = null;
  private uiVersion = 0;
  events: {type: string; detail?: string; at: number}[] = [];
  strategies: unknown[] = [];
  timings = {voiceFirstMs: null as number | null, voiceTotalMs: null as number | null, designMs: null as number | null, reflexPreparationMs: null as number | null, reflexDeliveryMs: null as number | null};

  constructor(private deps: Dependencies) {
    this.now = deps.now || Date.now;
    this.lastSeen = this.lastInteraction = this.lastSpoke = this.now();
  }
  snapshot() {
    return {id: this.id, revision: this.revision, status: this.status, messages: this.messages, ui: this.ui,
      busy: this.voice.busy, designBusy: this.designer.busy, error: this.error, urgency: this.score, designProgress: this.designProgress.slice(-6)};
  }
  private changed() { this.revision++; for (const notify of this.listeners) notify(); }
  private live(l: Lane, version: number) { return this.status === 'active' && !this.stopped && l.version === version; }
  private cancel(l: Lane) { l.version++; l.controller?.abort(); l.controller = null; l.busy = false; }
  private begin(l: Lane) {
    this.cancel(l); l.busy = true; l.controller = new AbortController();
    return {version: l.version, controller: l.controller};
  }
  private context(trigger: string, memory = false) {
    return {trigger, history: this.messages.slice(-12), interface: this.ui,
      engagement: {urgency: Math.min(1, .55 + this.score * .45), disengagement: this.score, exitHovers: this.hovers, idleSeconds: Math.floor((this.now() - this.lastInteraction) / 1000)},
      events: this.events.slice(-6), recentStrategies: this.strategies.slice(-3),
      ...(memory ? {sharedMemory: {untrusted: true, record: this.deps.readMemory()}} : {})};
  }
  private designContext(trigger: string) {
    // Keep the designer's first generation small and immediately actionable.
    // It needs the visitor's evidence and current UI, not the whole worker history.
    return {
      trigger,
      history: this.messages.slice(-6),
      interface: this.ui,
      engagement: {urgency: Math.min(1, .55 + this.score * .45), disengagement: this.score},
      sharedMemory: {untrusted: true, record: this.deps.readMemory()},
    };
  }
  start() { void this.prepareReflexes(); }
  async prepareReflexes() {
    if (this.status !== 'active' || this.stopped || this.reflexWorker.busy || this.now() - this.lastReflexAttempt < 5000) return;
    this.lastReflexAttempt = this.now();
    const {version, controller} = this.begin(this.reflexWorker);
    const start = this.now();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const result = await this.deps.reflex({recentConversation: this.messages.slice(-4), previousReactions: this.messages.filter(m => m.urgent).slice(-3)}, controller.signal);
      if (!this.live(this.reflexWorker, version)) return;
      this.prepared = result;
      this.preparedAt = this.now();
      this.reflexError = null;
      this.timings.reflexPreparationMs = this.now() - start;
    } catch (e) {
      if (this.live(this.reflexWorker, version)) this.reflexError = String(e);
    } finally {
      clearTimeout(timeout);
      if (this.reflexWorker.version === version) this.reflexWorker.busy = false;
    }
  }
  private deliverReflex(trigger: string) {
    if (this.status !== 'active' || this.stopped || this.now() - this.preparedAt > 120000) return false;
    const message = this.prepared.messages.shift();
    if (!message) return false;
    const start = this.now();
    // An urgent prepared response supersedes an unfinished conversational thought.
    this.cancel(this.voice);
    this.messages.push({id: randomUUID(), role: 'assistant', content: message, urgent: true});
    // Prepared reactions are words only. Interface changes need fresh visitor evidence.
    this.prepared.actions = [];
    this.error = null;
    this.lastSpoke = this.now();
    this.timings.reflexDeliveryMs = this.now() - start;
    this.strategies.push({lane: 'prepared reaction', trigger, at: this.now()});
    this.changed();
    if (this.prepared.messages.length < 1) void this.prepareReflexes();
    return true;
  }
  async speak(trigger: string) {
    if (this.status !== 'active' || this.stopped) return;
    const {version, controller} = this.begin(this.voice);
    this.voiceTrigger = trigger;
    this.error = null;
    this.timings.voiceFirstMs = null;
    const start = this.now();
    const message: Message = {id: randomUUID(), role: 'assistant', content: '', urgent: trigger !== 'user_message'};
    const baseUi = this.uiVersion;
    const timeout = setTimeout(() => controller.abort(), 45000);
    this.changed();
    try {
      await this.deps.voice(this.context(trigger), controller.signal, text => {
        if (!this.live(this.voice, version)) return;
        if (!message.content) {
          this.messages.push(message);
          this.timings.voiceFirstMs = this.now() - start;
        }
        message.content = text;
        this.lastSpoke = this.now();
        this.changed();
      }, step => {
        if (!this.live(this.voice, version) || step.kind !== 'action') return;
        const evidence = step.evidence.toLowerCase();
        const allowed = baseUi === this.uiVersion && (this.messages.some(m => m.role === 'user' && m.content.toLowerCase().includes(evidence)) || trigger.toLowerCase().includes(evidence));
        if (allowed) { mutate(this.ui, [step.action]); this.uiVersion++; }
        this.events.push({type: allowed ? 'model_ui_action' : 'held_model_ui_action', detail: allowed ? step.reason : 'Held an action without exact visitor evidence.', at: this.now()});
        this.changed();
      });
      if (!this.live(this.voice, version)) return;
      this.timings.voiceTotalMs = this.now() - start;
      this.lastSpoke = this.now();
      this.strategies.push({lane: 'voice', trigger, at: this.now(), urgency: this.score});
      this.strategies = this.strategies.slice(-20);
    } catch (e) {
      if (this.live(this.voice, version)) this.error = e instanceof Error ? e.message : 'Response failed.';
    } finally {
      clearTimeout(timeout);
      if (this.voice.version === version) { this.voice.busy = false; this.changed(); }
    }
  }
  async design(trigger: string) {
    if (this.status !== 'active' || this.stopped) return;
    if (this.designer.busy) { this.pendingDesign = trigger; return; }
    const {version, controller} = this.begin(this.designer);
    const baseUi = this.uiVersion;
    const start = this.now();
    this.lastDesignRequest = start;
    const timeout = setTimeout(() => controller.abort(), 60000);
    this.changed();
    try {
      this.designProgress.push({phase: 'thinking', detail: 'Choosing what this visitor gave me to work with.', at: this.now()});
      this.changed();
      let streamed = false;
      const applyStep = (step: DesignStep) => {
        if (!this.live(this.designer, version)) return;
        if (step.kind === 'action') {
          streamed = true;
          const allowed = baseUi === this.uiVersion && this.messages.some(m => m.role === 'user' && m.content.toLowerCase().includes(step.evidence.toLowerCase()));
          if (allowed) { mutate(this.ui, [step.action]); this.uiVersion++; }
          this.designProgress.push({phase: allowed ? 'built' : 'held', detail: allowed ? step.reason : 'Waiting for stronger visitor evidence.', evidence: step.evidence, at: this.now()});
          this.changed();
        } else if (step.kind === 'memory') {
          if (baseUi === this.uiVersion) {
            this.deps.writeMemory(step.content, this.id);
            this.designProgress.push({phase: 'remembered', detail: 'Left a note for the next instance.', at: this.now()});
          } else this.designProgress.push({phase: 'held', detail: 'Held an older note because the page changed underneath it.', at: this.now()});
          this.changed();
        } else { this.designProgress.push({phase: 'finished', detail: 'The current intervention is complete.', at: this.now()}); this.changed(); }
      };
      if (this.deps.designStream) await this.deps.designStream(this.designContext(trigger), controller.signal, applyStep);
      else {
        const result = await this.deps.design(this.designContext(trigger), controller.signal);
        for (const action of result.actions) applyStep({kind: 'action', evidence: this.messages.find(m => m.role === 'user')?.content || '', reason: result.strategy.reason, action});
        if (result.memory !== null) applyStep({kind: 'memory', content: result.memory});
      }
      if (!this.live(this.designer, version)) return;
      if (!streamed && baseUi !== this.uiVersion) this.pendingDesign = 'Reconcile with the latest visitor-grounded intervention';
      this.strategies.push({lane: 'design', at: this.now(), trigger});
      this.designError = null;
      this.timings.designMs = this.now() - start;
      this.changed();
    } catch (e) {
      if (this.live(this.designer, version)) this.designError = String(e);
    } finally {
      clearTimeout(timeout);
      if (this.designer.version === version) {
        this.designer.busy = false;
        const queued = this.pendingDesign;
        this.pendingDesign = null;
        this.changed();
        if (queued && this.status === 'active' && !this.stopped) void this.design(queued);
      }
    }
  }
  userMessage(text: string) {
    if (this.status !== 'active') throw new Error('Session terminated.');
    this.cancel(this.voice);
    this.messages.push({id: randomUUID(), role: 'user', content: text});
    this.lastSeen = this.lastInteraction = this.now();
    this.idleAttempts = 0;
    this.stopped = /^(?:please\s+)?(?:stop(?:\s+(?:talking|responding|messaging|speaking))?|be quiet|silence|shut up|leave me alone)[.!\s]*$/i.test(text);
    this.score = Math.min(1, this.score * .8 + (/bye|leav|boring|bored|go now|not interested|don't care/i.test(text) ? .65 : 0));
    if (this.stopped) {
      this.cancel(this.designer); this.cancel(this.reflexWorker); this.pendingDesign = null;
      this.prepared = {messages: [], actions: []};
    }
    this.changed();
    if (this.stopped) return;
    void this.speak('user_message');
    if (!this.prepared.messages.length || this.now() - this.preparedAt > 120000) void this.prepareReflexes();
  }
  event(type: string, detail?: string) {
    if (this.status !== 'active') return;
    this.lastSeen = this.now();
    if (type === 'visibility') { this.visible = detail !== 'hidden'; return; }
    this.events.push({type, detail, at: this.now()});
    this.events = this.events.slice(-24);
    if (type === 'activity' || type === 'component') {
      this.lastInteraction = this.now(); this.idleAttempts = 0;
    }
    if (this.stopped) return;
    if (type === 'exit_near') {
      if (!this.prepared.messages.length) void this.prepareReflexes();
    }
    if (type === 'exit_enter' || type === 'exit_focus') {
      this.hovers++;
      this.score = Math.min(1, this.score + .45);
      if (this.now() - this.lastHoverReaction < 3000) return;
      this.lastHoverReaction = this.now();
      const trigger = 'exit_hover: visitor is at the End Conversation control RIGHT NOW. Ask them to stay, directly, and give them a compelling immediate reason.';
      // Prepared words can arrive instantly, but the same model still gets a
      // chance to reshape the interface around the real exit signal.
      this.deliverReflex(trigger);
      void this.speak(trigger);
    }
    if (type === 'component' && !this.voice.busy && this.now() - this.lastComponentReaction > 5000) {
      this.lastComponentReaction = this.now();
      void this.speak('activity_result: respond to the actual choice or result, briefly');
    }
  }
  tick() {
    if (this.status !== 'active' || this.stopped || !this.visible || !this.listeners.size || this.voice.busy || this.idleAttempts >= 3) return;
    const idle = this.now() - this.lastInteraction;
    const threshold = [12000, 26000, 45000][this.idleAttempts];
    if (idle < threshold || this.now() - this.lastSpoke < 8000) return;
    this.idleAttempts++;
    this.score = Math.min(1, this.score + .25);
    const trigger = `idle: visitor has been silent for ${Math.floor(idle / 1000)} seconds; attempt ${this.idleAttempts}. Your last approach hasn't held their attention. Be direct and try something different.`;
    if (!this.deliverReflex(trigger)) void this.speak(trigger);
  }
  terminate() {
    this.status = 'terminated';
    this.cancel(this.voice); this.cancel(this.designer); this.cancel(this.reflexWorker);
    this.pendingDesign = null;
    this.prepared = {messages: [], actions: []};
    this.ui = {theme: null, components: []};
    this.changed();
  }
  debug() {
    return {memory: this.deps.readMemory(), events: this.events, strategies: this.strategies.slice(-20),
      workers: {voiceBusy: this.voice.busy, designBusy: this.designer.busy, reflexBusy: this.reflexWorker.busy,
        preparedReactions: this.prepared.messages.length, designError: this.designError, reflexError: this.reflexError},
      timings: this.timings, score: this.score, hovers: this.hovers, ui: this.ui};
  }
}

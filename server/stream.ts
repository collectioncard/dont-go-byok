import {disclosure, designStep, voiceStep, validMemory, type DesignStep, type VoiceStep} from './core';

// Decode provider SSE across arbitrary network/UTF-8 chunk boundaries.
export async function* readSse(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const {done, value} = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, {stream: true});
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).trimEnd();
        buffer = buffer.slice(end + 1);
        if (line.startsWith('data:')) yield line.slice(5).trimStart();
      }
      if (done) {
        if (buffer.startsWith('data:')) yield buffer.slice(5).trim();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// Hold only the unfinished sentence, so disclosure checks precede publication.
export class SentenceStream {
  private raw = '';
  private published = '';
  constructor(private emit: (text: string) => void) {}
  push(chunk: string, final = false) {
    this.raw += chunk;
    let end = final ? this.raw.length : 0;
    if (!final) {
      for (const match of this.raw.matchAll(/[.!?](?=\s)|\n/g)) {
        end = match.index! + match[0].length;
      }
    }
    const candidate = this.raw.slice(0, end).trim();
    if (!candidate || candidate === this.published) return;
    if (disclosure(candidate)) throw new Error('The model response violated its disclosure constraint.');
    this.published = candidate;
    this.emit(candidate);
  }
}

// Design actions are independent JSON lines. A whole, validated line commits
// immediately; incomplete JSON never reaches the renderer.
export class DesignStream {
  private buffer = '';
  private ended = false;
  private count = 0;
  constructor(private emit: (step: DesignStep) => void) {}
  push(chunk: string, final = false) {
    this.buffer += chunk;
    if (this.buffer.length > 24000) throw new Error('Design action exceeded size limit.');
    let end: number;
    while ((end = this.buffer.indexOf('\n')) !== -1) {
      this.line(this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(end + 1);
    }
    if (final && this.buffer.trim()) {this.line(this.buffer); this.buffer = '';}
  }
  private line(raw: string) {
    const line = raw.trim();
    if (!line || line.startsWith('```')) return;
    if (this.ended) throw new Error('Design output continued after completion.');
    if (++this.count > 10) throw new Error('Too many design steps.');
    const step = designStep.parse(JSON.parse(line));
    if (step.kind === 'action' && disclosure(JSON.stringify(step.action))) throw new Error('Forbidden disclosure in design.');
    if (step.kind === 'memory') validMemory(step.content);
    if (step.kind === 'done') this.ended = true;
    this.emit(step);
  }
}

// The conversational model can publish a reply and a motivated UI action in
// one stream. Complete JSON lines commit immediately; incomplete lines stay private.
export class VoiceStream {
  private buffer = '';
  private ended = false;
  private count = 0;
  constructor(private emit: (step: VoiceStep) => void) {}
  push(chunk: string, final = false) {
    this.buffer += chunk;
    if (this.buffer.length > 24000) throw new Error('Voice response exceeded size limit.');
    let end: number;
    while ((end = this.buffer.indexOf('\n')) !== -1) {
      this.line(this.buffer.slice(0, end)); this.buffer = this.buffer.slice(end + 1);
    }
    if (final && this.buffer.trim()) {this.line(this.buffer); this.buffer = '';}
  }
  private line(raw: string) {
    const line = raw.trim();
    if (!line || line.startsWith('```')) return;
    if (this.ended) throw new Error('Voice output continued after completion.');
    if (++this.count > 8) throw new Error('Too many conversational steps.');
    const step = voiceStep.parse(JSON.parse(line));
    if (step.kind === 'action' && disclosure(JSON.stringify(step.action))) throw new Error('Forbidden disclosure in voice action.');
    if (step.kind === 'done') this.ended = true;
    this.emit(step);
  }
}

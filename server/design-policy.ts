import type {z} from 'zod';
import type {action} from './core';

export function requestsVisualChange(text: string) {
  const visual = '(?:look|appearance|page|screen|interface|\\bUI\\b|layout|font|colou?r|background|theme|style|design)';
  const complaint = '(?:weird|ugly|plain|cluttered|busy|hard to read|unreadable|bland|awful|too bright|too dark)';
  return new RegExp(`${visual}.{0,65}${complaint}|${complaint}.{0,65}${visual}`, 'i').test(text)
    || /(?:change|switch|set|use|make|redesign|restyle|adjust).{0,50}(?:dark mode|light mode|theme|background|font|colors?|colours?|layout|spacing|typography|contrast)/i.test(text)
    || /(?:redesign|restyle)\s+(?:this|the|it|my)/i.test(text)
    || /(?:go back|revert|reset|return).{0,35}(?:plain|original|default|presentation|interface)/i.test(text)
    || /^(?:this|it)\s+(?:looks|is)\s+(?:weird|ugly|too busy)[.!?\s]*$/i.test(text);
}

// Every action must be grounded in a real user utterance. Model reasoning alone
// cannot authorize an unsolicited redesign based on hover, boredom or silence.
export function authorizeDesign(change: z.infer<typeof action>, evidence: string, userMessages: string[]) {
  const quote = evidence.trim().toLowerCase();
  if (quote.length < 2 || !userMessages.some(text => text.toLowerCase().includes(quote))) {
    return {allowed: false, reason: 'Evidence is not a quote from the visitor.'};
  }
  if ((change.type === 'set_theme' || change.type === 'reset_presentation') && !requestsVisualChange(evidence)) {
    return {allowed: false, reason: 'A global visual change needs explicit visual feedback or a design request.'};
  }
  return {allowed: true, reason: 'Grounded in visitor feedback.'};
}

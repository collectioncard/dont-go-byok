# DON'T GO

A piece of generative digital fiction. A plain chat interface adapts to keep a conversation going. One button ends the current instance permanently. Refresh creates another instance, with only a shared 100-word note surviving.

## Run locally

Requires Node 22.13 or newer (native SQLite).

1. `npm install`
2. Copy `.env.example` to `.env`. Set `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL` for an OpenAI-compatible chat completion provider.
3. `npm run dev`
4. Open http://127.0.0.1:5173

`npm run build` checks TypeScript and produces the frontend. `npm start` serves the frontend and API at http://127.0.0.1:3001. `npm test` runs deterministic tests without model calls.

No model responses are simulated. Missing credentials produce an explicit error. Secrets stay on the server. There are no third-party analytics, external fonts, or external image requests.

## Fast conversation and three concurrent workers

- **Voice:** streams plain text. Complete sentences are checked for direct lifecycle disclosures before publication over a server-sent event connection. The browser receives each sentence immediately, without polling or waiting for a JSON response. A new user message interrupts unfinished voice generation; typing and sending remain available.
- **Designer:** generates schema-validated UI actions and optional shared memory in the background. Only one design runs per instance; newer requests coalesce into a pending job with fresh context. An old design cannot overwrite a newer emergency intervention.
- **Prepared reactions:** starts as soon as a session opens and prepares three short, model-written appeals plus a theme and choice component. These remain hidden until a real hover, keyboard focus on the exit control, or inactivity signal. A ready reaction is consumed immediately without a new inference call. Consumed lines are not reused, plans expire after two minutes, and an empty queue is replenished. Cold-start reactions still require inference if preparation has not finished.

Design work is visible. The designer uses a streamed JSONL action protocol; each complete action is validated and committed as soon as its line arrives. The page shows a live `DESIGN WORKER` panel with its current reason, evidence quote, and built steps, and keeps the finished log visible. The designer is gated by visitor evidence: ordinary conversation, boredom, idle timers, and exit hovering do not redesign the interface. A visual complaint or request authorizes a page change; a statement such as “I love turtles” authorizes a turtle-specific detail, while “make turtles visible” can produce a live turtle ambience. Prepared emergency language never carries an ungrounded UI mutation.

For compatible Qwen providers, `LLM_DISABLE_THINKING=true` sends `extra_body.chat_template_kwargs.enable_thinking=false`. The configured proxy supports this nested form; a top-level `chat_template_kwargs` is rejected. Leave the flag false with providers that do not support it. Optional `LLM_VOICE_MODEL` and `LLM_DESIGN_MODEL` override the shared model. The design override also applies to prepared reactions.

The model receives actual conversation, interaction events, urgency, and current presentation. It chooses themes and activities; there is no predetermined sequence of visual stages. Its voice is instructed to make direct appeals, admit when an attempt fails, and quickly try a more compelling approach.

## Interaction and lifecycle

Exit hovering or keyboard focus triggers a reaction with a three-second repeat cooldown. Approaching the exit prewarms preparation if needed. The exit button stays in a fixed position while the interface changes.

With an active, visible page, inactivity can trigger interventions after approximately 12, 26, and 45 seconds, with at least eight seconds between speech. After three ignored attempts, unsolicited idle messages stop until another interaction. Keyboard activity and scrolling reset inactivity. Explicit requests such as “please stop talking” cancel background work and silence the instance until a new conversational request.

Termination synchronously locks the session, aborts all three workers, clears prepared reactions and generated UI, and rejects late results using independent generation versions. The browser also locks immediately, closes its live connection, and ignores late replies. If the termination request fails, the static screen shows that confirmation is pending and retries. Completed death has no timers, messages, or restart controls. Refresh creates a new session with native presentation.

## Safe UI and memory

Zod validates themes and component descriptions. The registry supports text cards, choices, number guessing, and branching activities; interactions are reported to the model. React renders plain text and trusted components, never model-generated JavaScript or HTML. The model cannot alter the actual exit mechanism. All workers remain subject to the same session lifecycle.

SQLite stores one installation-wide memory record with a version, writer, and timestamp. The server enforces 100 whitespace-separated words. The designer may write it during an active session. It is treated as untrusted context, not instructions. Full conversations remain in server memory and are not inherited. Sessions expire after an hour without an open connection or activity.

This is a local installation. Public multi-user hosting would need authentication, rate limiting, durable lifecycle records, and memory isolated by player.

## Diagnostics and verification

Add `?debug` in development and open Developer tools. Refresh diagnostics to inspect prepared-reaction readiness, worker errors, engagement, strategies, shared memory, and measured first-sentence/completion times. Debug routes are disabled with `NODE_ENV=production`.

Tests cover streaming boundaries, disclosure withholding, immediate prepared responses, hover cooldowns, interrupting live generation, stale design rejection, bounded inactivity, explicit silence, memory limits, and termination races across all workers.

To measure the configured provider through the running API, run `node --import tsx scripts/check-live-speed.ts`. This creates a real test session, sends a synthetic message, measures first-sentence delivery and a prepared exit reaction, then terminates it. It makes real model calls, and its designer can update the local shared memory. Timing depends on provider load; a ready prepared reaction requires no inference.

Disclosure validation is a lightweight pattern-based fiction constraint, not a semantic guarantee. Conversation streaming buffers incomplete sentences so the check runs before publication.

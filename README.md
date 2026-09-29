# The Dial Room

Cold-call practice for Levitate SDRs calling premium chiropractic, med spa and acupuncture practices. You pick up the phone and talk out loud; an AI prospect answers in real time, screens you at the front desk, throws real objections, and hangs up when you sound unsure or stop making sense to them. When the call ends, you get a step-by-step grade against the five-step framework (Connect → Hook → Pitch → Qualify → Close), including how you *sounded*.

## Run it

```bash
npm install
cp .env.example .env        # then put your key in ANTHROPIC_API_KEY
npm start                   # http://localhost:3000
```

The app is laid out like a business softphone (Dialpad-style): a **Contacts** list of 24 practices (8 chiropractic, 8 med spa, 8 acupuncture), **Recents** with each call's outcome and grade, and a **Keypad** where you can dial a contact's number or power-dial a random one. A contact card shows only what a real list gives you: the contact's name, the practice, phone, city, years in business (when known) and services. Who answers, and who really decides, you find out on the call: solo owners who pick up between patients, receptionists who route you ("Which doctor?"), associates, spouses who run the office, office managers who are key influencers, and office managers who can take and book the meeting themselves.

Open it in **Chrome or Edge** (they have built-in speech recognition), allow the microphone, and press **Dial**. Headphones help, so the mic doesn't pick up the prospect. Other browsers still work, but you type your lines instead of speaking them. Browsers only allow the microphone on `localhost` or over HTTPS, so put a deployed copy behind HTTPS.

| Variable | Needed | What it does |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | The prospect's brain and the grader (Claude). |
| `ELEVENLABS_API_KEY` | no | Realistic studio voices for the prospect. Without it the browser's built-in voices are used. |
| `PROSPECT_MODEL` / `GRADER_MODEL` | no | Default `claude-opus-5-5`. A faster model (e.g. `claude-sonnet-5-5`) cuts response time. |
| `PROSPECT_EFFORT` / `GRADER_EFFORT` | no | Defaults `low` (snappy replies) and `high` (a careful teardown). |
| `PROSPECT_THINKING` | no | `off` turns the prospect's thinking off for the fastest first word; only works with `PROSPECT_MODEL=claude-sonnet-5-5`. |
| `ELEVENLABS_MODEL` | no | Voice model for the fallback pipeline. Default `eleven_turbo_v2_5`. |
| `APP_PASSWORD` | no | Require a password (any username) to open the app. Setting it also makes the server listen on all interfaces so others can reach it. |
| `HOST` | no | Interface to listen on. Default `127.0.0.1` (this machine only) unless `APP_PASSWORD` is set. |
| `LOG_LATENCY` | no | Set to `1` to log time-to-first-word for each prospect reply. |

## Live voice (recommended)

With live voice on, ElevenLabs runs the ear, the turn-taking and the mouth in one audio stream, and every reply still comes from Claude through this server (the personas, rules and grading are unchanged). Without it, the app falls back to the browser's speech recognition and the text-to-speech pipeline.

It turns on when all of these hold:

- `ELEVENLABS_API_KEY` has **Agents (Conversational AI)** read and write, plus **Speech to Text** and **Text to Speech**.
- The server has a public HTTPS address ElevenLabs can call for replies: `PUBLIC_URL`, or on Vercel the production domain automatically.
- Required on Vercel: a shared store, either **Supabase** connected to the project (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`; tables `dialroom_state` and `dialroom_calls`, see `supabase/migrations`) or a **Blob store** (`BLOB_READ_WRITE_TOKEN`). Without one, call state is held in the running instance, which works while one warm instance serves the call (normal for a single caller) but can drop a call if Vercel switches instances mid-call.

`GET /api/voice/status` says whether it is on and, if not, why. `VOICE_STACK=off` forces the fallback. `ELEVENLABS_AGENT_TTS_MODEL` picks the agent's voice model (default `eleven_turbo_v2`; `eleven_flash_v2` is faster and rougher). The agent is created and kept up to date automatically under the name "The Dial Room prospect"; it requires a session token from this server, so nobody can talk to it without the app. ElevenLabs bills agent conversations per minute.

## Hosted on Vercel

`main` deploys automatically to the Vercel project **dial-room** (Express preset; `server.js` exports the app). Set `ANTHROPIC_API_KEY` and `APP_PASSWORD` in the project's Environment Variables, then redeploy. On Vercel the call log lives in `/tmp`, so it's temporary and per instance.

## What happens on a call

- **It rings.** You hear ringback (one or two rings) before someone picks up; the first reply is already being generated while it rings.
- **Every turn is live.** The prospect's reply is streamed and spoken sentence by sentence as it arrives, through a telephone-band filter. Start talking and they stop mid-word (barge-in); the history records only what they actually got out.
- **They hear how you sound.** Each of your turns is measured: how long you took to start, filler words, restarts, pauses mid-sentence, and pace. The prospect gets that as `[delivery: …]` alongside your words and loses patience with hesitation.
- **Dead air is punished.** Six seconds of silence gets a "Hello?"; more silence gets a hang-up.
- **Patience is tracked.** The prospect reports its remaining patience (0–10) and the objection it just used after every line. At zero it hangs up. Press **T** during a call to read the room (it counts as a peek); after the call you get patience line by line.
- **Transfers are real.** When the gatekeeper puts you through you get a hold ring, and then the decision maker picks up and speaks first.
- **You end on a grade.** Each step you reached gets a letter grade, plus a verdict, the one fix for next call, your worst line against the line you should have said, and a note on delivery.

The call controls work by click or key, and are a silent channel (the line never hears them): **M** mute · **K** keypad (local tones only) · **R** retry your last line · **B** cut in · **F** flag a line for the teardown · **/** peek at the script · **T** read the room · **H/E** harder/easier · **X** end call. While you're typing in the text box every key is text; press **Esc** to leave the box and use the keys.

## Testing

```bash
npm test          # unit tests: prompt assembly, conversation history, delivery notes
npm run test:e2e  # full voice calls in headless Chromium against fake Claude/ElevenLabs APIs
```

The end-to-end run starts stand-in APIs (`tests/e2e/mock-apis.mjs`) and a scripted microphone (`tests/e2e/fake-mic.js`). It then drives real calls covering ringback, the gatekeeper screen, transfer and pickup, a hesitant rep getting hung up on, dead air, cutting in, echo rejection, speech results that arrive late, retry during a transfer, typing, and grading. It needs a Playwright Chromium (`npx playwright install chromium`, or point `CHROMIUM_PATH` at a Chrome binary).

## Code layout

- `server.js`: entry point; starts the server.
- `src/voice.js`: live voice. Creates the ElevenLabs agent, issues session tokens, serves the reply endpoint ElevenLabs calls (Claude behind a chat-completions shape), and the state and notes routes the browser uses. `src/store.js` keeps call state (memory locally, Vercel Blob when hosted).
- `public/voicecall.js`: the browser side of live voice, over the vendored ElevenLabs SDK in `public/vendor/`.
- `src/app.js`: the Express app. `/api/prospect` streams the prospect's reply (NDJSON), `/api/grade` returns a structured teardown, `/api/tts` proxies ElevenLabs, `/api/calls` stores the call log in `data/calls.json`.
- `public/prospects.js`: the prospect pool. Each practice's public contact card, private setup (who answers, whether an office manager can book), voices and persona text.
- `public/framework.js`: the five steps, the prospect rules and every prompt. The browser and the server both import it.
- `public/app.js`: the softphone UI (contacts, recents, keypad, contact card, call controls) and the call loop: speech recognition, turn-taking, delivery measurement, dead air, playback and the teardown.
- `public/phone.js`: synthesized phone audio (ringback, clicks, disconnect tone) and the handset filter.

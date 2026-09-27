import { app, PORT, HOST, LOOPBACK, HAS_BRAIN, ELEVEN_KEY, APP_PASSWORD, ON_VERCEL } from "./src/app.js";

// On Vercel the platform runs the exported app; locally we listen ourselves.
if (!ON_VERCEL) {
const server = app.listen(PORT, HOST, (err) => {
  if (err) {
    console.error(`Can't listen on ${HOST}:${PORT}: ${err.message}`);
    process.exit(1);
  }
  const shown = HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST;
  console.log(`The Dial Room is on http://${shown}:${PORT}`);
  if (!HAS_BRAIN) console.warn("No ANTHROPIC_API_KEY set — the prospect can't answer until you set one.");
  console.log(ELEVEN_KEY ? "Voices: ElevenLabs" : "Voices: browser speech (set ELEVENLABS_API_KEY for realistic voices)");
  if (!LOOPBACK && !APP_PASSWORD) console.warn("Listening beyond this machine without APP_PASSWORD — anyone who can reach this server can use your API keys.");
});
server.on("error", (err) => {
  console.error(`Server error: ${err.message}`);
  process.exit(1);
});
}

export default app;

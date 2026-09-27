import { app, PORT, HOST, HAS_BRAIN, ELEVEN_KEY, APP_PASSWORD } from "./src/app.js";

const server = app.listen(PORT, HOST, (err) => {
  if (err) {
    console.error(`Can't listen on ${HOST}:${PORT}: ${err.message}`);
    process.exit(1);
  }
  const shown = HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST;
  console.log(`The Dial Room is on http://${shown}:${PORT}`);
  if (!HAS_BRAIN) console.warn("No ANTHROPIC_API_KEY set — the prospect can't answer until you set one.");
  console.log(ELEVEN_KEY ? "Voices: ElevenLabs" : "Voices: browser speech (set ELEVENLABS_API_KEY for realistic voices)");
  if (process.env.HOST && !APP_PASSWORD) console.warn("HOST is set but APP_PASSWORD isn't — anyone who can reach this server can use your API keys.");
});
server.on("error", (err) => {
  console.error(`Server error: ${err.message}`);
  process.exit(1);
});

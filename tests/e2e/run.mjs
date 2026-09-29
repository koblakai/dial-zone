// End-to-end voice-call tests: starts the mock APIs, runs the app twice (with and
// without studio voices), and drives calls in headless Chromium with a scripted mic.
//   npm run test:e2e            (set CHROMIUM_PATH to use a specific browser binary)
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMock } from "./mock-apis.mjs";
import { runCalls } from "./calls.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const executablePath = process.env.CHROMIUM_PATH
  || ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((p) => existsSync(p));
const tmp = mkdtempSync(path.join(tmpdir(), "dial-room-e2e-"));

const mock = await startMock(0);
const mockUrl = `http://127.0.0.1:${mock.address().port}`;

function startApp(port, extraEnv) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", APP_PASSWORD: "", ANTHROPIC_API_KEY: "test",
      ANTHROPIC_BASE_URL: mockUrl, ELEVENLABS_API_KEY: "", DATA_FILE: path.join(tmp, `calls-${port}.json`), ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("app didn't start")), 10000);
    child.stdout.on("data", (d) => { if (/Dial Room is on/.test(d)) { clearTimeout(t); resolve(child); } });
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("exit", (code) => { clearTimeout(t); reject(new Error(`app exited ${code}`)); });
  });
}

const base = 40000 + Math.floor(Math.random() * 20000);
let total = { pass: 0, fail: 0 };
const apps = [];
try {
  apps.push(await startApp(base, { ELEVENLABS_API_KEY: "test", ELEVENLABS_BASE_URL: mockUrl }));
  apps.push(await startApp(base + 1, {}));
  apps.push(await startApp(base + 2, { ELEVENLABS_API_KEY: "test", ELEVENLABS_BASE_URL: mockUrl, PUBLIC_URL: "https://dial.example.test" }));
  const only = (process.env.MODES || "premium,browser,agent").split(",");
  for (const [mode, port] of [["premium", base], ["browser", base + 1], ["agent", base + 2]].filter(([m]) => only.includes(m))) {
    const r = await runCalls({ mode, appUrl: `http://localhost:${port}/`, mockUrl, executablePath, log: !!process.env.VERBOSE });
    total.pass += r.pass; total.fail += r.fail;
  }
} catch (e) {
  console.error(e); total.fail++;
} finally {
  apps.forEach((c) => c.kill());
  mock.close();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${total.pass} passed, ${total.fail} failed`);
process.exit(total.fail ? 1 : 0);

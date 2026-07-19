#!/usr/bin/env node
// Fake agent CLI: prints numbered lines at a target rate, then a DONE marker.
// Gives the pty scenario a deterministic amount of output to check for loss.
//   node mock-agent.cjs --lines 1200 --rate 120 --bytes 160 --tag S3

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const lines = parseInt(arg('lines', '100'), 10);
const rate = parseInt(arg('rate', '50'), 10); // lines per second
const bytes = parseInt(arg('bytes', '120'), 10);
const tag = arg('tag', 'S0');

const TICK_MS = 50;
const perTick = Math.max(1, Math.round((rate * TICK_MS) / 1000));
// header is like "S12:000047 " — pad the rest of the line out to `bytes`
const pad = 'x'.repeat(Math.max(1, bytes - (tag.length + 9)));

let emitted = 0;
const timer = setInterval(() => {
  let chunk = '';
  for (let i = 0; i < perTick && emitted < lines; i++, emitted++) {
    chunk += `${tag}:${String(emitted).padStart(6, '0')} ${pad}\n`;
  }
  if (chunk) process.stdout.write(chunk);
  if (emitted >= lines) {
    clearInterval(timer);
    process.stdout.write(`${tag}:DONE n=${emitted}\n`);
    // give the pty a beat to drain before exiting
    setTimeout(() => process.exit(0), 100);
  }
}, TICK_MS);

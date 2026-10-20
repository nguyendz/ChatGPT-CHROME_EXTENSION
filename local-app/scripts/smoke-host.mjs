import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFrames } from '../host/framing.ts';
import { ECHO_BYTES, HOST_NAME } from '../../lib/sync/protocol.ts';

const browser = process.argv.includes('--edge') ? 'Microsoft\\Edge' : 'Google\\Chrome';
const registry = `HKCU\\Software\\${browser}\\NativeMessagingHosts\\${HOST_NAME}`;
const result = execFileSync('reg.exe', ['query', registry, '/ve'], { encoding: 'utf8' });
const match = result.match(/REG_SZ\s+(.+)\r?\n/);
if (!match) throw new Error(`No registered manifest at ${registry}`);
const manifest = JSON.parse(readFileSync(match[1].trim(), 'utf8'));
const origin = manifest.allowed_origins[0];
// cmd.exe requires the extra outer quotes when the executable path contains spaces.
const child = spawn(process.env.ComSpec ?? 'cmd.exe', [
  '/d', '/s', '/c', `""${manifest.path}" "${origin}""`,
], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: true });
const timer = setTimeout(() => { child.kill(); console.error('Registered host timed out'); process.exitCode = 1; }, 15_000);
child.stderr.on('data', data => process.stderr.write(data));
let inputError;
child.stdin.on('error', error => { inputError = error; });
const exited = new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (code !== 0) reject(new Error(`Registered launcher exited: ${code ?? signal}`));
    else resolve();
  });
});
// Attach a rejection handler immediately, before reading stdout.
exited.catch(() => {});
function send(id, type, payload) {
  const body = Buffer.from(JSON.stringify({ v: 1, id, type, payload }));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  child.stdin.write(Buffer.concat([header, body]));
}
try {
  const data = 'x'.repeat(ECHO_BYTES);
  const expected = createHash('sha256').update(data).digest('hex');
  send('ping', 'ping', {});
  send('hello', 'hello', { protocolVersion: 1, extVersion: 'smoke' });
  send('echo', 'echo', { data });
  child.stdin.end();
  const replies = new Map();
  for await (const frame of readFrames(child.stdout)) {
    const reply = JSON.parse(frame.toString('utf8'));
    if (reply.type === 'error') throw new Error(JSON.stringify(reply.payload));
    replies.set(reply.id, reply);
  }
  await exited;
  if (inputError) throw inputError;
  if (replies.get('ping')?.type !== 'ping.ok' || replies.get('hello')?.type !== 'hello.ok') {
    throw new Error('Missing ping or hello response');
  }
  const echo = replies.get('echo')?.payload;
  if (echo?.bytes !== ECHO_BYTES || echo.sha256 !== expected) throw new Error('10 MB echo did not match');
  console.log('Registered launcher: ping OK');
  console.log(JSON.stringify(replies.get('hello').payload, null, 2));
  console.log('10 MB echo: SHA-256 verified. Host exited cleanly.');
} finally {
  clearTimeout(timer);
  if (child.exitCode === null) child.kill();
}

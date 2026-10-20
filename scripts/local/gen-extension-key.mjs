import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const directory = new URL('../../.local/', import.meta.url);
const keyFile = new URL('extension-key.pub.txt', directory);
mkdirSync(directory, { recursive: true });
let publicKey;
if (existsSync(keyFile) && !process.argv.includes('--force')) {
  publicKey = readFileSync(keyFile, 'utf8').trim();
} else {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  writeFileSync(keyFile, `${publicKey}\n`);
}
const id = createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex')
  .slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
writeFileSync(new URL('extension-id.txt', directory), `${id}\n`);
console.log(`Extension ID: ${id}\nPublic key: ${fileURLToPath(keyFile)}`);

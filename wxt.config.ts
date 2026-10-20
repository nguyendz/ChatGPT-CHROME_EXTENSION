import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';
import { existsSync, readFileSync } from 'node:fs';

const localKeyPath = new URL('./.local/extension-key.pub.txt', import.meta.url);
const localKey = existsSync(localKeyPath) ? readFileSync(localKeyPath, 'utf8').trim() : undefined;

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  webExt: { disabled: true },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: {
    ...(localKey ? { key: localKey } : {}),
    name: 'ChatGPT Local Sync',
    description: 'Sync your open ChatGPT conversation to a local database',
    action: {
      default_title: 'ChatGPT Local Sync',
    },
    host_permissions: ['https://chatgpt.com/*'],
    permissions: ['activeTab', 'nativeMessaging'],
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self';",
    },
  },
});

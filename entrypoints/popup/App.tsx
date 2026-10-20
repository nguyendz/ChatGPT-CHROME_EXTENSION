import { LocalSyncPanel } from './LocalSyncPanel';

export default function App() {
  return (
    <section className="mx-auto w-[440px] overflow-hidden bg-white shadow-[0_14px_38px_10px_rgba(0,0,0,0.22)]">
      <main className="space-y-6 p-5">
        <header className="flex items-center gap-4">
          <img src="/icons/icon-logoA-64x64.svg" alt="" className="size-14 shrink-0" />
          <div>
            <h1 className="text-lg font-bold text-[#215145]">ChatGPT Local Sync</h1>
            <p className="text-sm text-[#6B7280]">Sync conversations to your local database</p>
          </div>
        </header>
        <LocalSyncPanel />
      </main>
      <footer className="border-t border-[#D3D3D3] bg-[#E7F2E8]/45 px-5 py-3 text-right text-sm">
        <a
          className="text-[#00A582]"
          href="https://github.com/FredySandoval/ChatGPT-CHROME_EXTENSION"
          target="_blank"
          rel="noreferrer"
        >
          GitHub
        </a>
      </footer>
    </section>
  );
}

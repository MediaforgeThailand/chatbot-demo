import Image from "next/image";
import { WebChatWidget } from "@/components/web-chat-widget";

export default function WebPage() {
  return (
    <main className="relative h-screen w-screen overflow-hidden bg-background text-on-background">
      <WebsiteMockup />
      <WebChatWidget />
    </main>
  );
}

function WebsiteMockup() {
  return (
    <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
      <div className="mx-auto max-w-7xl px-margin-mobile py-10 opacity-30 blur-md md:px-margin-desktop md:py-12">
        <header className="mb-14 flex items-center justify-between gap-6">
          <div className="flex items-center gap-4">
            <Image
              alt="PSC Logo"
              src="/logo-pongsawadi.png"
              width={48}
              height={48}
              priority
              className="h-12 w-12 rounded-full object-contain"
            />
            <div className="font-headline-lg text-headline-lg text-on-surface">
              Pongsawadi Tech
            </div>
          </div>
          <nav className="hidden gap-8 font-label-bold text-label-bold text-on-surface-variant md:flex">
            <span>Admissions</span>
            <span>Programs</span>
            <span>Student Life</span>
            <span>Contact</span>
          </nav>
        </header>

        <section className="mb-20 grid gap-12 md:grid-cols-2">
          <div className="space-y-6">
            <div className="h-16 w-3/4 rounded-lg bg-surface-container-high" />
            <div className="h-4 w-full rounded-lg bg-surface-container" />
            <div className="h-4 w-5/6 rounded-lg bg-surface-container" />
            <div className="h-12 w-40 rounded-full bg-primary/20" />
          </div>
          <div className="relative h-80 overflow-hidden rounded-xl bg-surface-container-highest">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.9),rgba(223,14,132,0.18)_38%,rgba(225,227,228,1)_70%)]" />
            <div className="absolute bottom-8 left-8 right-8 h-28 rounded-xl border border-white/60 bg-white/40" />
            <div className="absolute bottom-12 left-14 h-20 w-16 rounded-t-lg bg-surface-container-lowest/80" />
            <div className="absolute bottom-12 left-36 h-20 w-16 rounded-t-lg bg-surface-container-lowest/80" />
            <div className="absolute bottom-12 left-58 h-20 w-16 rounded-t-lg bg-surface-container-lowest/80" />
          </div>
        </section>

        <section className="grid grid-cols-1 gap-8 md:grid-cols-3">
          <div className="h-48 rounded-lg bg-surface-container-low" />
          <div className="h-48 rounded-lg bg-surface-container-low" />
          <div className="h-48 rounded-lg bg-surface-container-low" />
        </section>
      </div>

      <div className="absolute inset-0 bg-gradient-to-tr from-background/30 via-transparent to-primary-fixed/30" />
      <div className="absolute left-6 top-6 rounded-full border border-outline-variant bg-surface-container-lowest/70 px-4 py-2 font-label-bold text-label-bold text-on-surface-variant backdrop-blur">
        web001 mockup
      </div>
    </div>
  );
}

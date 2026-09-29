"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { HelpCircle, Sparkles } from "lucide-react";
import { AuthGuard } from "@/components/auth/auth-guard";
import { ComposeProvider } from "@/components/compose/compose-context";
import { FloatingComposer } from "@/components/compose/floating-composer";
import { MailSearchInput } from "@/components/mail-search/mail-search-input";
import { MailSearchProvider } from "@/components/mail-search/mail-search-context";
import { MailboxProvider } from "@/components/mailbox-provider";
import { MailboxSelector } from "@/components/mailbox-selector";
import { AgentPanel } from "@/components/agent/agent-panel";
import { AssistantOpenContext } from "@/components/agent/assistant-open-state";
import { Button } from "@/components/ui/button";
import { DashboardNav } from "@/components/dashboard-nav";
import { SidebarHeader } from "@/components/sidebar-header";
import { SidebarProvider } from "@/components/sidebar-state";
import { SidebarResizeBoundary } from "@/components/sidebar-resize-boundary";
import { ShortcutsProvider } from "@/components/shortcuts";
import clsx from "clsx";
import { useDashboardState } from "./dashboard-state";
import { useAssistantAvailability } from "./use-assistant-availability";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { assistantOpen, setAssistantOpen, assistantFullSize, setAssistantFullSize } = useDashboardState();
  const assistantEnabled = useAssistantAvailability();
  const assistantVisible = assistantEnabled === true && assistantOpen;
  const pathname = usePathname();
  const isCalendarPage = pathname === "/calendar" || pathname.startsWith("/calendar/");

  useEffect(() => {
    if (assistantEnabled === false && (assistantOpen || assistantFullSize)) {
      setAssistantOpen(false);
      setAssistantFullSize(false);
    }
  }, [assistantEnabled, assistantOpen, assistantFullSize, setAssistantOpen, setAssistantFullSize]);

  return (
    <AuthGuard>
      <SidebarProvider>
        <MailboxProvider>
          <ComposeProvider>
            <MailSearchProvider>
              <ShortcutsProvider>
                <div className={clsx("grid h-dvh overflow-hidden bg-[#f6f8fc] transition-[grid-template-columns]", isCalendarPage ? "grid-cols-[minmax(0,1fr)]" : "grid-cols-[72px_minmax(0,1fr)] md:grid-cols-[var(--sidebar-width)_minmax(0,1fr)]")} style={{ transitionDuration: "var(--sidebar-transition-duration)" }}>
                  {!isCalendarPage && <aside className="relative z-30 w-[var(--sidebar-width)] min-h-0 min-w-0 bg-[#f6f8fc]">
                    <div className="h-full overflow-y-auto overscroll-contain px-3 py-4 scrollbar-gutter-stable">
                      <DashboardNav />
                    </div>
                    <SidebarResizeBoundary />
                  </aside>}
                  <div className="flex min-h-0 min-w-0 flex-col">
                    <header className="flex h-16 w-full shrink-0 items-center gap-3 pr-4 text-sm">
                      {isCalendarPage && <div className="shrink-0 px-3 transition-[width] duration-200 ease-in-out motion-reduce:transition-none [&>div]:mb-0" style={{ width: "calc(var(--sidebar-width) + 1.5rem)" }}><SidebarHeader href="/inbox" /></div>}
                      {isCalendarPage ? <div id="calendar-header-slot" className="flex min-w-0 flex-1 items-center" /> : <MailSearchInput />}
                      {/* <Link
                        href="/settings/account"
                        className="flex h-10 w-10 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-200"
                        title="Account Settings"
                      >
                        <HelpCircle className="h-5 w-5" />
                      </Link> */}
                      {assistantEnabled && <Button type="button" variant="ghost" size="sm" className={assistantOpen ? "bg-blue-50 text-blue-700" : "text-neutral-600"} onClick={() => { setAssistantOpen((current) => !current); setAssistantFullSize(false); }} aria-label={assistantOpen ? "Close email assistant" : "Open email assistant"} aria-expanded={assistantOpen} aria-controls="email-assistant-panel"><Sparkles className="h-5 w-5" /></Button>}
                      <MailboxSelector />
                    </header>
                    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
                      <AssistantOpenContext.Provider value={assistantVisible}>
                        <main className={clsx("min-h-0 min-w-0 flex-1 overscroll-contain scrollbar-gutter-stable", isCalendarPage ? "overflow-hidden bg-[#f6f8fc]" : "rounded-t-3xl overflow-y-auto bg-white")} aria-hidden={assistantVisible && assistantFullSize} inert={assistantVisible && assistantFullSize}>
                          {children}
                        </main>
                      </AssistantOpenContext.Provider>
                      <aside className={clsx(assistantFullSize ? "pl-0" : "pl-4", `min-h-0 min-w-0 shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out motion-reduce:transition-none pr-2 pb-2`, assistantVisible ? "" : "opacity-0")} style={{ width: assistantVisible ? assistantFullSize ? "100%" : "min(390px, 100%)" : "0px" }} aria-hidden={!assistantVisible} inert={!assistantVisible}>
                        {assistantEnabled && <AgentPanel open={assistantVisible} fullSize={assistantFullSize} onToggleFullSize={() => setAssistantFullSize((current) => !current)} onClose={() => { setAssistantOpen(false); setAssistantFullSize(false); }} />}
                      </aside>
                    </div>
                  </div>
                  <FloatingComposer />
                </div>
              </ShortcutsProvider>
            </MailSearchProvider>
          </ComposeProvider>
        </MailboxProvider>
      </SidebarProvider>
    </AuthGuard>
  );
}

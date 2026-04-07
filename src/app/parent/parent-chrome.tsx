"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useParentPushLifecycleResync } from "@/lib/firebase/use-parent-push-lifecycle-resync";
import { subscribeForegroundMessages } from "@/lib/firebase/web-push";

const glassOverlay =
  "rounded-[1.75rem] border border-white/70 bg-[rgba(252,251,248,0.98)] p-6 shadow-[0_24px_80px_-20px_rgba(0,0,0,0.2)]";

export function ParentChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [attnOpen, setAttnOpen] = useState(false);
  const [attnBody, setAttnBody] = useState("");

  useParentPushLifecycleResync();

  useEffect(() => {
    const listen =
      pathname.startsWith("/parent") && !pathname.startsWith("/parent/session");
    if (!listen) return;
    return subscribeForegroundMessages((body) => {
      setAttnBody(body);
      setAttnOpen(true);
    });
  }, [pathname]);

  return (
    <>
      {children}
      {attnOpen ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4">
          <div className={`w-full max-w-sm ${glassOverlay}`} role="alertdialog" aria-live="polite">
            <p className="text-sm font-medium text-foreground">알림</p>
            <p className="mt-3 text-sm text-neutral-700">{attnBody}</p>
            <button
              type="button"
              onClick={() => setAttnOpen(false)}
              className="mt-5 w-full rounded-2xl bg-[#222] dark:bg-neutral-100 py-2.5 text-sm font-medium text-white dark:text-neutral-950"
            >
              확인
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

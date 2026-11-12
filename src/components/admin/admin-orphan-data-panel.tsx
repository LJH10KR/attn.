"use client";

import { httpsCallable } from "firebase/functions";
import { useCallback, useState } from "react";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";

type OrphanReport = {
  phantomAcademies: { academyId: string; collections: Record<string, number> }[];
  academiesWithoutOwnerAuth: { academyId: string; ownerUid: string }[];
  orphanLoginIndex: { key: string; academyId: string; role: string }[];
  orphanSignupLinks: { id: string; academyId: string }[];
  orphanUserDocs: string[];
  orphanConsents: string[];
  unusedAuthUsers: string[];
  pendingDeletions: string[];
};

const ROWS: { key: keyof OrphanReport; label: string; purge: boolean }[] = [
  { key: "phantomAcademies", label: "① 학원 문서 없이 남은 하위 데이터", purge: true },
  { key: "academiesWithoutOwnerAuth", label: "② 원장 계정이 없는 학원(보고만)", purge: false },
  { key: "orphanLoginIndex", label: "③ 가리키는 계정이 없는 로그인 색인", purge: true },
  { key: "orphanSignupLinks", label: "④ 학원이 없는 가입 링크", purge: true },
  { key: "orphanUserDocs", label: "⑤ 계정이 없는 사용자 문서", purge: true },
  { key: "orphanConsents", label: "⑤ 계정이 없는 동의 기록", purge: true },
  { key: "unusedAuthUsers", label: "⑥ 어디에도 쓰이지 않는 로그인 계정(보고만)", purge: false },
  { key: "pendingDeletions", label: "⑦ 끝나지 않은 학원 삭제(보고만)", purge: false },
];

function detail(key: keyof OrphanReport, report: OrphanReport): string[] {
  if (key === "phantomAcademies") {
    return report.phantomAcademies.map(
      (p) => `${p.academyId}: ${Object.entries(p.collections).map(([c, n]) => `${c} ${n}`).join(", ") || "하위 없음"}`,
    );
  }
  if (key === "academiesWithoutOwnerAuth") return report.academiesWithoutOwnerAuth.map((a) => a.academyId);
  if (key === "orphanLoginIndex") return report.orphanLoginIndex.map((x) => `${x.key} (${x.role}, ${x.academyId || "학원 없음"})`);
  if (key === "orphanSignupLinks") return report.orphanSignupLinks.map((x) => x.academyId || x.id);
  return report[key] as string[];
}

/**
 * 관리자 — 운영 잔여 데이터 점검·정리(2-N N10). [점검]은 읽기만, [정리]는 ①③④⑤만 지우고 다시 점검.
 * ②⑥⑦은 보고만(원장 계정·끝나지 않은 삭제는 사람이 판단).
 */
export function AdminOrphanDataPanel() {
  const [report, setReport] = useState<OrphanReport | null>(null);
  const [busy, setBusy] = useState<"scan" | "purge" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [purgedNote, setPurgedNote] = useState<string | null>(null);

  const run = useCallback(async (mode: "scan" | "purge") => {
    if (mode === "purge" && !window.confirm("①③④⑤ 항목을 지웁니다. 되돌릴 수 없습니다. 진행할까요?")) return;
    setBusy(mode);
    setError(null);
    setPurgedNote(null);
    try {
      const res = await httpsCallable(getFirebaseFunctions(), "adminOrphanData", { timeout: 540_000 })({ mode });
      const data = res.data as { report: OrphanReport; before?: OrphanReport };
      setReport(data.report);
      if (mode === "purge" && data.before) {
        const b = data.before;
        setPurgedNote(
          `정리 전: 학원 ${b.phantomAcademies.length} · 색인 ${b.orphanLoginIndex.length} · 가입 링크 ${b.orphanSignupLinks.length} · 사용자 문서 ${b.orphanUserDocs.length} · 동의 기록 ${b.orphanConsents.length}`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "점검에 실패했습니다.");
    } finally {
      setBusy(null);
    }
  }, []);

  const purgeable = report ? ROWS.some((r) => r.purge && detail(r.key, report).length > 0) : false;

  return (
    <section className="glass-card-soft p-5" data-testid="admin-orphan-panel">
      <h2 className="text-sm font-semibold text-foreground">남은 데이터 점검</h2>
      <p className="mt-1 text-xs text-neutral-500">
        지운 학원·계정에서 남은 문서를 찾습니다. [점검]은 읽기만 하고, [정리]는 ①③④⑤만 지운 뒤 다시 점검합니다.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void run("scan")}
          className="flex-1 rounded-2xl border border-neutral-300/70 bg-white/60 py-2.5 text-sm font-medium text-foreground disabled:opacity-50 dark:bg-white/[0.08]"
        >
          {busy === "scan" ? "점검 중…" : "점검"}
        </button>
        <button
          type="button"
          disabled={busy !== null || !purgeable}
          onClick={() => void run("purge")}
          className="flex-1 rounded-2xl bg-red-600 py-2.5 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy === "purge" ? "정리 중…" : "정리"}
        </button>
      </div>
      {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
      {purgedNote ? <p className="mt-3 text-xs text-neutral-600">{purgedNote}</p> : null}
      {report ? (
        <ul className="mt-3 space-y-2">
          {ROWS.map((r) => {
            const items = detail(r.key, report);
            return (
              <li key={`${r.key}-${r.label}`} className="rounded-xl bg-black/[0.03] px-3 py-2 dark:bg-white/[0.06]">
                <p className="text-xs font-medium text-foreground">
                  {r.label} · {items.length}건
                </p>
                {items.length > 0 ? (
                  <ul className="mt-1 space-y-0.5">
                    {items.slice(0, 20).map((it) => (
                      <li key={it} className="break-all font-mono text-[11px] text-neutral-600">
                        {it}
                      </li>
                    ))}
                    {items.length > 20 ? <li className="text-[11px] text-neutral-500">…외 {items.length - 20}건</li> : null}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

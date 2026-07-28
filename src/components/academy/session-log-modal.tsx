import {
  arrayRemove,
  collection,
  doc,
  getDocs,
  increment,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  where,
  writeBatch,
} from "firebase/firestore";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { academyStudentSessionLogsPath } from "@/lib/firebase/attn-schema";
import { getFirebaseAuth, getFirebaseDb } from "@/lib/firebase/client-app";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";

const PAGE_SIZE = 15;

type LogEntry = {
  id: string;
  recordedAt: Date;
  recordedByUid: string;
  wasExtra: boolean;
};

function nowKST(): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "numeric",
  }).formatToParts(new Date());
  return {
    year: Number(parts.find((p) => p.type === "year")?.value ?? new Date().getFullYear()),
    month: Number(parts.find((p) => p.type === "month")?.value ?? new Date().getMonth() + 1),
  };
}

function kstMonthBounds(year: number, month: number): { start: Timestamp; end: Timestamp } {
  const KST = 9 * 60 * 60 * 1000;
  return {
    start: Timestamp.fromMillis(Date.UTC(year, month - 1, 1) - KST),
    end: Timestamp.fromMillis(Date.UTC(year, month, 1) - KST),
  };
}

function fmtLogDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("month")}.${g("day")} (${g("weekday")}) ${g("hour")}:${g("minute")}`;
}

function dateStrKST(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

function buildPageNums(total: number, cur: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const show = new Set([
    1,
    total,
    ...([-1, 0, 1].map((d) => cur + d).filter((n) => n >= 1 && n <= total)),
  ]);
  const sorted = [...show].sort((a, b) => a - b);
  const result: (number | "…")[] = [];
  sorted.forEach((n, i) => {
    if (i > 0 && n - sorted[i - 1] > 1) result.push("…");
    result.push(n);
  });
  return result;
}

export function SessionLogModal({
  academyId,
  studentId,
  studentName,
  onClose,
  onCancelled,
}: {
  academyId: string;
  studentId: string;
  studentName: string;
  onClose: () => void;
  onCancelled: () => void;
}) {
  const [year, setYear] = useState(() => nowKST().year);
  const [month, setMonth] = useState(() => nowKST().month);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useBodyScrollLock(true);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy && !cancelBusy) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [busy, cancelBusy, onClose]);

  const fetchLogs = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const db = getFirebaseDb();
      const { start, end } = kstMonthBounds(year, month);
      const snap = await getDocs(
        query(
          collection(db, academyStudentSessionLogsPath(academyId, studentId)),
          where("recordedAt", ">=", start),
          where("recordedAt", "<", end),
          orderBy("recordedAt", "desc"),
        ),
      );
      setLogs(
        snap.docs.map((d) => {
          const data = d.data() as {
            recordedAt: Timestamp;
            recordedByUid: string;
            wasExtra: boolean;
          };
          return {
            id: d.id,
            recordedAt: data.recordedAt.toDate(),
            recordedByUid: String(data.recordedByUid ?? ""),
            wasExtra: Boolean(data.wasExtra),
          };
        }),
      );
      setPage(1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "기록을 불러오지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }, [academyId, studentId, year, month]);

  useEffect(() => {
    void fetchLogs();
  }, [fetchLogs]);

  const goMonth = useCallback(
    (delta: -1 | 1) => {
      const kst = nowKST();
      let newYear = year;
      let newMonth = month + delta;
      if (newMonth < 1) {
        newYear -= 1;
        newMonth = 12;
      } else if (newMonth > 12) {
        newYear += 1;
        newMonth = 1;
      }
      if (newYear > kst.year || (newYear === kst.year && newMonth > kst.month)) return;
      setYear(newYear);
      setMonth(newMonth);
    },
    [month, year],
  );

  const cancelLog = useCallback(
    async (log: LogEntry) => {
      setCancelBusy(true);
      try {
        const db = getFirebaseDb();
        if (!getFirebaseAuth().currentUser?.uid) throw new Error("로그인 상태를 확인해 주세요.");
        const batch = writeBatch(db);
        batch.delete(doc(db, academyStudentSessionLogsPath(academyId, studentId), log.id));
        const updates: Record<string, unknown> = {
          sessionBalance: increment(1),
          updatedAt: serverTimestamp(),
        };
        if (log.wasExtra) {
          updates.extraSessionDates = arrayRemove(dateStrKST(log.recordedAt));
        }
        batch.update(doc(db, "academies", academyId, "students", studentId), updates);
        await batch.commit();
        setConfirmId(null);
        setLogs((prev) => prev.filter((l) => l.id !== log.id));
        onCancelled();
      } catch (e) {
        setError(e instanceof Error ? e.message : "취소에 실패했습니다.");
      } finally {
        setCancelBusy(false);
      }
    },
    [academyId, studentId, onCancelled],
  );

  const totalPages = Math.max(1, Math.ceil(logs.length / PAGE_SIZE));
  const pageItems = logs.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const pageNums = buildPageNums(totalPages, page);
  const kst = nowKST();
  const isCurrentMonth = year === kst.year && month === kst.month;

  return createPortal(
    <div
      className="fixed inset-0 z-[210] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
      role="presentation"
      onClick={() => {
        if (!busy && !cancelBusy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="glass-card flex w-full max-w-lg flex-col shadow-2xl"
        style={{ maxHeight: "min(90dvh, 680px)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="flex items-center justify-between gap-4 border-b border-neutral-200/60 px-5 py-4 dark:border-white/10">
          <div>
            <h2 className="text-base font-semibold text-foreground">{studentName} · 차감 기록</h2>
            <p className="mt-0.5 text-[11px] text-neutral-500">
              {busy ? "불러오는 중…" : `${year}년 ${month}월 · 총 ${logs.length}건`}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-[18px] border border-neutral-300/80 bg-white/70 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-white/90"
          >
            닫기
          </button>
        </div>

        {/* 월 이동 */}
        <div className="flex items-center justify-center gap-3 border-b border-neutral-200/60 px-5 py-3 dark:border-white/10">
          <button
            type="button"
            onClick={() => goMonth(-1)}
            disabled={busy}
            className="rounded-[18px] border border-neutral-300/70 bg-white/55 px-3 py-1.5 text-xs font-medium hover:bg-white/90 disabled:opacity-40"
          >
            ‹ 이전
          </button>
          <span className="min-w-[90px] text-center text-sm font-semibold text-foreground">
            {year}년 {month}월
          </span>
          <button
            type="button"
            onClick={() => goMonth(1)}
            disabled={busy || isCurrentMonth}
            className="rounded-[18px] border border-neutral-300/70 bg-white/55 px-3 py-1.5 text-xs font-medium hover:bg-white/90 disabled:opacity-40"
          >
            다음 ›
          </button>
        </div>

        {/* 목록 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {error ? (
            <p className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
          ) : null}
          {busy ? (
            <p className="py-12 text-center text-sm text-neutral-400">불러오는 중…</p>
          ) : logs.length === 0 ? (
            <p className="py-12 text-center text-sm text-neutral-400">이 달의 차감 기록이 없습니다.</p>
          ) : (
            <ul className="space-y-1.5">
              {pageItems.map((log, idx) => {
                const num = (page - 1) * PAGE_SIZE + idx + 1;
                const confirming = confirmId === log.id;
                return (
                  <li
                    key={log.id}
                    className={`flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 ${
                      log.wasExtra
                        ? "bg-red-50/80 ring-1 ring-red-200/60 dark:bg-red-900/10"
                        : "bg-white/50 dark:bg-white/[0.06]"
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="w-5 shrink-0 text-right text-[10px] text-neutral-400">
                        {num}
                      </span>
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-foreground">
                          {fmtLogDate(log.recordedAt)}
                        </p>
                        {log.wasExtra ? (
                          <p className="text-[10px] font-medium text-red-600">초과 수업</p>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      {confirming ? (
                        <>
                          <button
                            type="button"
                            disabled={cancelBusy}
                            className="rounded-[18px] border border-neutral-300/70 bg-white/80 px-2.5 py-1 text-[11px] font-medium text-neutral-700 hover:bg-white disabled:opacity-50"
                            onClick={() => setConfirmId(null)}
                          >
                            아니요
                          </button>
                          <button
                            type="button"
                            disabled={cancelBusy}
                            className="rounded-[18px] border border-red-300 bg-red-500 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-red-600 disabled:opacity-50"
                            onClick={() => void cancelLog(log)}
                          >
                            {cancelBusy ? "취소 중…" : "확인"}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          disabled={cancelBusy}
                          className="rounded-[18px] border border-neutral-300/70 bg-white/70 px-2.5 py-1 text-[11px] font-medium text-neutral-700 hover:bg-white/90 disabled:opacity-40"
                          onClick={() => setConfirmId(log.id)}
                        >
                          차감 취소
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* 페이지네이션 */}
        {!busy && totalPages > 1 ? (
          <div className="flex items-center justify-center gap-1 border-t border-neutral-200/60 px-4 py-3 dark:border-white/10">
            <button
              type="button"
              disabled={page === 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded-[18px] border border-neutral-300/70 bg-white/55 px-2.5 py-1.5 text-[11px] font-medium hover:bg-white/90 disabled:opacity-40"
            >
              ← 이전
            </button>
            {pageNums.map((n, i) =>
              n === "…" ? (
                <span key={`e${i}`} className="px-0.5 text-xs text-neutral-400">
                  …
                </span>
              ) : (
                <button
                  key={n}
                  type="button"
                  onClick={() => setPage(n as number)}
                  className={`min-w-[28px] rounded-[18px] border px-2 py-1.5 text-[11px] font-medium ${
                    page === n
                      ? "border-violet-400 bg-violet-600 text-white"
                      : "border-neutral-300/70 bg-white/55 text-neutral-700 hover:bg-white/90"
                  }`}
                >
                  {n}
                </button>
              ),
            )}
            <button
              type="button"
              disabled={page === totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="rounded-[18px] border border-neutral-300/70 bg-white/55 px-2.5 py-1.5 text-[11px] font-medium hover:bg-white/90 disabled:opacity-40"
            >
              다음 →
            </button>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

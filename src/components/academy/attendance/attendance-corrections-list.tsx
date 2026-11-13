"use client";

import { useState } from "react";
import { reasonLabel } from "@/lib/academy/attendance-labels";
import { formatSeoulHHmm } from "@/lib/academy/attendance-rules";
import type { AttendanceCorrectionRow } from "@/lib/academy/use-day-attendance";

/** 이력의 전·후 상태 한 줄 — "미등원(질병)"·"등원 14:30"·"출석"·"결석(기타)"·"없음" */
function stateText(layer: "arrival" | "class", s: Record<string, unknown> | null): string {
  if (!s) return layer === "arrival" ? "없음" : "미처리";
  const status = s.status === "absent" ? "absent" : "present";
  const reason = reasonLabel(typeof s.reason === "string" ? s.reason : null);
  if (layer === "class") return status === "present" ? "출석" : reason ? `결석(${reason})` : "결석";
  if (status === "absent") return reason ? `미등원(${reason})` : "미등원";
  const at = s.arrivedAt as { toMillis?: () => number } | null | undefined;
  return at && typeof at.toMillis === "function" ? `등원 ${formatSeoulHHmm(new Date(at.toMillis()))}` : "등원";
}

function noteOf(layer: "arrival" | "class", s: Record<string, unknown> | null): string {
  const v = s?.[layer === "arrival" ? "note" : "comment"];
  return typeof v === "string" ? v : "";
}

/** 한 건의 설명 — 상태가 같고 메모만 바뀌었으면 메모·코멘트 문구 */
function describe(c: AttendanceCorrectionRow): string {
  const what = c.layer === "arrival" ? "등원 기록:" : `${c.className ?? "반"} 수업:`;
  const before = stateText(c.layer, c.before);
  const after = stateText(c.layer, c.after);
  if (before === after && noteOf(c.layer, c.before) !== noteOf(c.layer, c.after)) {
    const label = c.layer === "arrival" ? "메모" : "코멘트";
    const next = noteOf(c.layer, c.after);
    return `${what} ${label} ${next ? `"${next}"` : "지움"}`;
  }
  return `${what} ${before} → ${after}`;
}

/**
 * 그날 정정 기록(3-A A5) — 누가·언제·전→후. 출결 권한(원장 포함)만 읽는다(규칙).
 * 접힌 채로 시작, 최근 것부터.
 */
export function AttendanceCorrectionsList({ rows }: { rows: AttendanceCorrectionRow[] }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="glass-card px-4 py-3" aria-label="이 날 정정 기록">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between text-left text-sm font-semibold text-foreground"
      >
        <span>
          이 날 정정 기록 <span className="text-xs font-normal text-neutral-500">{rows.length}건</span>
        </span>
        <span aria-hidden className="text-neutral-400">
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open ? (
        <ul className="mt-2 space-y-1.5">
          {rows.map((c, i) => (
            <li key={`${c.atMs}-${i}`} className="break-keep text-[11px] leading-snug text-neutral-700">
              <span className="text-neutral-500">
                {new Date(c.atMs).toLocaleString("ko-KR", {
                  timeZone: "Asia/Seoul",
                  month: "numeric",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                  hourCycle: "h23",
                })}{" "}
                {c.byName}
              </span>{" "}
              · <b className="font-medium text-foreground">{c.studentName}</b> · {describe(c)}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

"use client";

import { httpsCallable } from "firebase/functions";
import { useMemo, useState } from "react";
import { useAttendanceNotifySettings } from "@/components/academy/attendance/attendance-settings-sheet";
import { attendanceActionErrorMessage, describeNotifyResult, type AttendanceNotifyResult } from "@/lib/academy/attendance-records";
import { isNotifyEnabled, seoulDateString } from "@/lib/academy/attendance-rules";
import { getFirebaseFunctions } from "@/lib/firebase/client-app";
import {
  attendanceKindLabel,
  useAttendanceNotificationLog,
  type AttendanceLogItem,
} from "@/lib/firebase/use-attendance-notification-log";

const glassCard = "glass-card";

function roleLabel(role: string): string {
  if (role === "teacher") return "선생님";
  if (role === "owner") return "오너";
  if (role === "academy") return "학원";
  if (role === "admin") return "관리자";
  if (role === "student_kiosk") return "키오스크";
  return role || "알 수 없음";
}

function fmt(ms: number | null): string {
  if (!ms) return "시간 정보 없음";
  return new Date(ms).toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function badgeClass(r: AttendanceLogItem): string {
  if (r.action === "cancel") return "bg-neutral-500/15 text-neutral-700";
  if (r.context === "departure") return "bg-sky-500/15 text-sky-900";
  if (r.context === "class") {
    if (r.kind === "late") return "bg-violet-500/15 text-violet-900";
    return r.kind === "absent" ? "bg-orange-500/15 text-orange-900" : "bg-sky-500/15 text-sky-900";
  }
  return r.kind === "absent" ? "bg-amber-500/20 text-amber-900" : "bg-emerald-500/15 text-emerald-900";
}

/** 다시 보내기 대상 — 알림 기록 날짜·보낸 날이 모두 서울 오늘(★10, 실제 판단은 서버) */
function isTodayItem(r: AttendanceLogItem, today: string): boolean {
  return r.date === today && r.createdAtMillis !== null && seoulDateString(new Date(r.createdAtMillis)) === today;
}

export function AcademyAttendanceLogPanel({
  academyId,
  includeAdminAll = false,
  title = "알림 전송 기록",
  storageScopeKey,
  canResend = false,
}: {
  academyId: string | null;
  includeAdminAll?: boolean;
  title?: string;
  storageScopeKey: string;
  /** 3-B 원장·출결 권한 — 오늘 알림 [다시 보내기](B9) */
  canResend?: boolean;
}) {
  const { items, error, busy, refresh } = useAttendanceNotificationLog({
    academyId,
    includeAdminAll,
    limit: 100,
    pollMs: 20_000,
    storageScopeKey,
  });
  // "꺼짐"은 지금 설정 기준(기획 참고) — 설정을 읽을 수 있는 권한(출결)일 때만 구독
  const settings = useAttendanceNotifySettings(academyId ?? "", Boolean(academyId) && canResend);
  const [resendBusy, setResendBusy] = useState<string | null>(null);
  const [resendNotice, setResendNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const today = seoulDateString();

  const rows = useMemo(() => items.slice(0, 100), [items]);

  const resend = async (r: AttendanceLogItem) => {
    if (!academyId) return;
    setResendBusy(r.id);
    setResendNotice(null);
    try {
      const res = await httpsCallable(getFirebaseFunctions(), "resendAttendanceNotification")({
        academyId,
        notificationId: r.id,
      });
      const data = res.data as { notification?: AttendanceNotifyResult };
      const tail = describeNotifyResult(data.notification ?? null).trim();
      setResendNotice({
        text: `${r.studentName || "학생"} ${attendanceKindLabel(r)} 알림을 다시 보냈습니다.${tail ? ` ${tail}` : ""}`,
        ok: true,
      });
      void refresh();
    } catch (e) {
      setResendNotice({ text: attendanceActionErrorMessage(e, "다시 보내지 못했습니다. 잠시 후 다시 시도해 주세요."), ok: false });
    } finally {
      setResendBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          className="rounded-[8px] border border-neutral-300/80 bg-white/70 px-3 py-2 text-[11px] font-medium text-neutral-800 hover:bg-white disabled:opacity-50"
        >
          새로고침
        </button>
      </div>
      {error ? (
        <p className="rounded-2xl bg-red-500/10 px-3 py-2 text-center text-xs text-red-800 ring-1 ring-red-500/15">
          {error}
        </p>
      ) : null}
      {resendNotice ? (
        <p
          role="status"
          className={`break-keep rounded-2xl px-3 py-2 text-center text-xs ring-1 ${
            resendNotice.ok ? "bg-[#eef7f1] text-emerald-900 ring-emerald-500/20" : "bg-[#fbeeee] text-red-800 ring-red-500/15"
          }`}
        >
          {resendNotice.text}
        </p>
      ) : null}

      {busy && rows.length === 0 ? (
        <p className={`py-10 text-center text-sm text-neutral-500 ${glassCard}`}>
          불러오는 중…
        </p>
      ) : rows.length === 0 ? (
        <p className={`py-10 text-center text-sm text-neutral-500 ${glassCard}`}>
          표시할 기록이 없습니다.
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => {
            // 설정을 못 읽으면 버튼을 열어 두고 서버가 판단(꺼짐이면 서버 문구).
            // 취소 알림은 원래 종류와 정정이 둘 다 켜져 있어야(3-B 후속 F2 — 서버와 같은 함수)
            const enabledNow = settings.notify
              ? isNotifyEnabled(settings.notify, { context: r.context ?? "arrival", kind: r.kind, action: r.action ?? "record" })
              : settings.error;
            const showResend = canResend && Boolean(academyId) && isTodayItem(r, today);
            return (
              <div key={r.id} className={`p-3 ${glassCard}`}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${badgeClass(r)}`}>
                    {attendanceKindLabel(r)}
                  </span>
                  {r.resend ? (
                    <span className="rounded-full bg-neutral-500/10 px-2 py-0.5 text-[10px] font-semibold text-neutral-700">
                      다시 알림
                    </span>
                  ) : null}
                  {r.muted ? (
                    <span className="rounded-full bg-neutral-800/10 px-2 py-0.5 text-[10px] font-semibold text-neutral-600">
                      알림 꺼짐
                    </span>
                  ) : null}
                  <span className="text-xs font-medium text-foreground">
                    {r.studentName || r.studentId || "학생"}
                  </span>
                  <span className="text-[11px] text-neutral-500">{fmt(r.createdAtMillis)}</span>
                </div>
                <div className="mt-1 flex items-end justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[11px] text-neutral-600">
                      발신 {r.senderDisplayName}
                      <span className="text-neutral-400"> ({roleLabel(r.senderRole)})</span>
                    </p>
                    <p className="mt-0.5 text-[11px] text-neutral-500">
                      {r.muted ? "출결 설정에서 꺼 둔 알림이라 보내지 않았습니다." : `학부모 ${r.parentDisplayName}`}
                    </p>
                  </div>
                  {showResend ? (
                    <button
                      type="button"
                      disabled={resendBusy !== null || !enabledNow}
                      title={!enabledNow && settings.notify ? "출결 설정에서 꺼 둔 알림입니다." : undefined}
                      onClick={() => void resend(r)}
                      className="shrink-0 rounded-[8px] border border-neutral-300/80 bg-white/70 px-2.5 py-1.5 text-[11px] font-medium text-neutral-800 hover:bg-white disabled:opacity-40"
                    >
                      {resendBusy === r.id ? "보내는 중…" : enabledNow || !settings.notify ? "다시 보내기" : "꺼져 있음"}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

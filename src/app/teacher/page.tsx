"use client";

import { FirebaseError } from "firebase/app";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, onSnapshot, Timestamp } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { docToStudentRow, type StudentRowVM } from "@/components/academy/academy-student-panel";
import { getFirebaseAuth, getFirebaseDb, getFirebaseFunctions } from "@/lib/firebase/client-app";

const glassCard = "glass-card";

function sortByName(a: StudentRowVM, b: StudentRowVM): number {
  return a.name.localeCompare(b.name, "ko");
}

type CallableStudentPayload = {
  id: string;
  parentUserId?: string;
  name?: string;
  age?: number;
  phone?: string;
  emergencyContact?: string;
  assignedTeacherUids?: string[];
  assignedTeacherUid?: string | null;
  createdAtMillis?: number | null;
};

function studentRowFromCallablePayload(s: CallableStudentPayload): StudentRowVM {
  const createdAt =
    typeof s.createdAtMillis === "number" ? Timestamp.fromMillis(s.createdAtMillis) : undefined;
  return docToStudentRow(s.id, {
    parentUserId: s.parentUserId ?? "",
    name: s.name ?? "",
    age: s.age ?? 0,
    phone: s.phone ?? "",
    emergencyContact: s.emergencyContact ?? "",
    assignedTeacherUids: s.assignedTeacherUids ?? [],
    ...(s.assignedTeacherUid ? { assignedTeacherUid: s.assignedTeacherUid } : {}),
    ...(createdAt ? { createdAt } : {}),
  });
}

export default function TeacherDashboardPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [academyId, setAcademyId] = useState<string | null>(null);
  const [academyName, setAcademyName] = useState<string | null>(null);
  const [students, setStudents] = useState<StudentRowVM[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [listRefreshBusy, setListRefreshBusy] = useState(false);
  const [notifyMessage, setNotifyMessage] = useState<string | null>(null);
  const [notifyBusyKey, setNotifyBusyKey] = useState<string | null>(null);

  const teacherListLoadedUidRef = useRef<string | null>(null);
  const teacherInitGenerationRef = useRef(0);

  useEffect(() => {
    const auth = getFirebaseAuth();
    let cancelled = false;

    const resetTeacherListSession = () => {
      teacherListLoadedUidRef.current = null;
    };

    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        resetTeacherListSession();
        teacherInitGenerationRef.current += 1;
        setStudents([]);
        setListError(null);
        setAcademyId(null);
        setReady(false);
        router.replace("/login?role=teacher");
        return;
      }

      const uid = user.uid;

      if (teacherListLoadedUidRef.current === uid) {
        return;
      }

      const gen = ++teacherInitGenerationRef.current;
      resetTeacherListSession();
      setStudents([]);
      setListError(null);

      let revealUi = false;
      try {
        await auth.authStateReady();
        if (cancelled || gen !== teacherInitGenerationRef.current || auth.currentUser?.uid !== uid) {
          return;
        }

        await user.getIdToken();
        if (cancelled || gen !== teacherInitGenerationRef.current || auth.currentUser?.uid !== uid) {
          return;
        }

        const fn = httpsCallable(getFirebaseFunctions(), "getTeacherActivationState");
        const res = await fn({});
        if (cancelled || gen !== teacherInitGenerationRef.current || auth.currentUser?.uid !== uid) {
          return;
        }

        const data = res.data as {
          anyActive?: boolean;
          primaryStatus?: string | null;
          primaryAcademyId?: string | null;
        };
        if (!data?.anyActive || !data.primaryAcademyId) {
          const q = new URLSearchParams();
          q.set("state", data?.primaryStatus ?? "unknown");
          if (data?.primaryAcademyId) q.set("academyId", data.primaryAcademyId);
          router.replace(`/teacher/session?${q.toString()}`);
          return;
        }

        const aid = data.primaryAcademyId;
        setAcademyId(aid);
        setInitError(null);
        revealUi = true;

        await user.getIdToken(true);
        if (cancelled || gen !== teacherInitGenerationRef.current || auth.currentUser?.uid !== uid) {
          return;
        }

        try {
          const listFn = httpsCallable(getFirebaseFunctions(), "listTeacherAssignedStudents");
          const listRes = await listFn({ academyId: aid });
          if (cancelled || gen !== teacherInitGenerationRef.current || auth.currentUser?.uid !== uid) {
            return;
          }

          const payload = listRes.data as { students?: CallableStudentPayload[] };
          const rawList = Array.isArray(payload?.students) ? payload.students : [];
          const list = rawList.map((s) => studentRowFromCallablePayload(s));
          list.sort(sortByName);
          setStudents(list);
          setListError(null);
          teacherListLoadedUidRef.current = uid;
        } catch {
          if (!cancelled && gen === teacherInitGenerationRef.current) {
            setStudents([]);
            setListError("전담 학생 목록을 불러오지 못했습니다. 잠시 후 새로고침해 주세요.");
          }
        }
      } catch {
        if (!cancelled && gen === teacherInitGenerationRef.current) {
          setInitError("선생님 정보를 불러오지 못했습니다.");
          revealUi = true;
        }
      }
      if (revealUi && !cancelled && gen === teacherInitGenerationRef.current) {
        setReady(true);
      }
    });

    return () => {
      cancelled = true;
      resetTeacherListSession();
      unsub();
    };
  }, [router]);

  const refreshAssignedStudents = useCallback(async () => {
    const auth = getFirebaseAuth();
    const user = auth.currentUser;
    const aid = academyId;
    if (!user?.uid || !aid) {
      return;
    }
    setListRefreshBusy(true);
    setListError(null);
    try {
      await user.getIdToken(true);
      const listFn = httpsCallable(getFirebaseFunctions(), "listTeacherAssignedStudents");
      const listRes = await listFn({ academyId: aid });
      const payload = listRes.data as { students?: CallableStudentPayload[] };
      const rawList = Array.isArray(payload?.students) ? payload.students : [];
      const list = rawList.map((s) => studentRowFromCallablePayload(s));
      list.sort(sortByName);
      setStudents(list);
      setListError(null);
    } catch {
      setListError("전담 학생 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setListRefreshBusy(false);
    }
  }, [academyId]);

  const sendAttendanceNotify = useCallback(
    async (studentId: string, kind: "present" | "absent") => {
      const aid = academyId;
      if (!aid) return;
      const key = `${studentId}-${kind}`;
      setNotifyBusyKey(key);
      setNotifyMessage(null);
      try {
        const fn = httpsCallable(getFirebaseFunctions(), "sendStudentAttendanceNotification");
        await fn({ academyId: aid, studentId, kind });
        setNotifyMessage(kind === "present" ? "출석 알림을 보냈습니다." : "결석 알림을 보냈습니다.");
      } catch (e) {
        if (e instanceof FirebaseError) {
          if (e.code === "functions/resource-exhausted") {
            setNotifyMessage("같은 학생에게 너무 자주 보낼 수 없습니다. 잠시 후 다시 시도해 주세요.");
            return;
          }
        }
        setNotifyMessage("알림을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.");
      } finally {
        setNotifyBusyKey(null);
      }
    },
    [academyId],
  );

  useEffect(() => {
    if (!academyId) return;
    const db = getFirebaseDb();
    const unsub = onSnapshot(
      doc(db, "academies", academyId),
      (snap) => {
        const n = snap.data()?.name;
        setAcademyName(typeof n === "string" ? n : null);
      },
      () => setAcademyName(null),
    );
    return () => unsub();
  }, [academyId]);

  const onLogout = useCallback(async () => {
    setLogoutBusy(true);
    try {
      teacherListLoadedUidRef.current = null;
      await signOut(getFirebaseAuth());
    } finally {
      setLogoutBusy(false);
      router.replace("/login?role=teacher");
    }
  }, [router]);

  if (!ready) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
        <p className="text-sm text-neutral-600">불러오는 중…</p>
      </div>
    );
  }

  if (initError) {
    return (
      <div className="min-h-[100dvh] bg-background px-4 py-10 flex flex-col items-center justify-center">
        <div className={`w-full max-w-[520px] p-8 ${glassCard}`}>
          <p className="text-center text-sm text-neutral-700">{initError}</p>
          <button
            type="button"
            onClick={() => void onLogout()}
            disabled={logoutBusy}
            className="mt-6 w-full rounded-2xl bg-[#222] dark:bg-neutral-100 py-3 text-sm font-medium text-white dark:text-neutral-950 disabled:opacity-60"
          >
            {logoutBusy ? "처리 중…" : "로그아웃"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-background px-4 pb-12 pt-8">
      <div className="mx-auto max-w-lg">
        <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">선생님 대시보드</h1>
            <p className="mt-1 text-xs text-neutral-600">
              {academyName ? (
                <span className="font-medium text-foreground">{academyName}</span>
              ) : (
                "학원"
              )}
              {academyId ? (
                <span className="ml-1 font-mono text-[10px] text-neutral-400">({academyId})</span>
              ) : null}
            </p>
            <p className="mt-2 text-[11px] leading-relaxed text-neutral-500">
              전담 학생 정보는 <span className="font-medium text-neutral-700">조회만</span> 가능합니다. 수정·삭제는
              학원 대시보드에서 진행됩니다.
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <button
              type="button"
              onClick={() => void onLogout()}
              disabled={logoutBusy}
              className="rounded-xl border border-neutral-300/80 bg-white/70 px-3 py-2 text-[11px] font-medium text-neutral-800 hover:bg-white disabled:opacity-60"
            >
              {logoutBusy ? "…" : "로그아웃"}
            </button>
            <Link
              href="/"
              className="text-[11px] font-medium text-sky-900 underline-offset-2 hover:underline"
            >
              홈으로
            </Link>
          </div>
        </header>

        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">전담 학생</h2>
          <button
            type="button"
            onClick={() => void refreshAssignedStudents()}
            disabled={listRefreshBusy || !academyId}
            className="rounded-xl border border-neutral-300/80 bg-white/70 px-3 py-2 text-[11px] font-medium text-neutral-800 hover:bg-white disabled:opacity-50"
          >
            {listRefreshBusy ? "불러오는 중…" : "목록 새로고침"}
          </button>
        </div>

        {listError ? (
          <p className="rounded-2xl bg-red-500/10 px-3 py-2 text-center text-xs text-red-800 ring-1 ring-red-500/15">
            {listError}
          </p>
        ) : null}

        {notifyMessage ? (
          <p className="mb-2 rounded-2xl bg-sky-500/10 px-3 py-2 text-center text-xs text-sky-900 ring-1 ring-sky-500/20">
            {notifyMessage}
          </p>
        ) : null}

        <div className="space-y-2">
          {students.length === 0 ? (
            <p className={`py-12 text-center text-sm text-neutral-500 ${glassCard}`}>
              전담으로 연결된 학생이 없습니다. 학원에서 배정이 되면 여기에 표시됩니다.
            </p>
          ) : (
            students.map((s) => (
              <div key={s.id} className={`p-4 ${glassCard}`}>
                <p className="font-medium text-foreground">
                  {s.name}
                  <span className="font-normal text-neutral-500"> · 만 {s.age}세</span>
                </p>
                <p className="mt-2 text-[11px] text-neutral-600">
                  연락 <span className="text-foreground">{s.phone || "—"}</span>
                </p>
                <p className="mt-0.5 text-[11px] text-neutral-600">
                  비상 연락 <span className="text-foreground">{s.emergencyContact || "—"}</span>
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={notifyBusyKey !== null}
                    onClick={() => void sendAttendanceNotify(s.id, "present")}
                    className="rounded-xl border border-emerald-400/60 bg-emerald-500/15 px-3 py-2 text-[11px] font-medium text-emerald-950 hover:bg-emerald-500/25 disabled:opacity-50"
                  >
                    {notifyBusyKey === `${s.id}-present` ? "전송 중…" : "출석 알림"}
                  </button>
                  <button
                    type="button"
                    disabled={notifyBusyKey !== null}
                    onClick={() => void sendAttendanceNotify(s.id, "absent")}
                    className="rounded-xl border border-amber-400/60 bg-amber-500/12 px-3 py-2 text-[11px] font-medium text-amber-950 hover:bg-amber-500/22 disabled:opacity-50"
                  >
                    {notifyBusyKey === `${s.id}-absent` ? "전송 중…" : "결석 알림"}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

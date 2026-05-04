"use client";

import {
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getFirebaseAuth, getFirebaseFunctions } from "@/lib/firebase/client-app";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import { GoogleMark } from "@/components/auth/google-mark";

type SeedCounts = {
  teachersCount: number;
  parentsCount: number;
  studentsPerParent: number;
  teachersPerStudent: number;
};

type SeedBatchListItem = {
  seedBatchId: string;
  label: string;
  academyId: string;
  counts: SeedCounts | null;
  createdAtMillis: number | null;
  deletedAt: boolean;
};

type CreatedCredentials = {
  owner: { email: string; password: string };
  teachers: Array<{ email: string; password: string }>;
  parents: Array<{ email: string; password: string }>;
};

type CreateSeedBatchResponse = {
  ok?: boolean;
  seedBatchId: string;
  academyId: string;
  credentials: CreatedCredentials;
  hint: {
    ownerLoginUrl: string;
    teacherLoginUrl: string;
    parentLoginUrl: string;
  };
};

type EnforceAdminLoginResponse = {
  ok: boolean;
  deleted?: boolean;
};

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "요청에 실패했습니다.";
}

export default function AdminSeedPage() {
  const configured = isFirebaseConfigured();
  const auth = getFirebaseAuth();
  const functions = getFirebaseFunctions();

  const [user, setUser] = useState<User | null>(auth.currentUser);
  const [adminOk, setAdminOk] = useState<boolean>(false);
  const [authBusy, setAuthBusy] = useState(false);

  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);

  const [batches, setBatches] = useState<
    SeedBatchListItem[]
  >([]);
  const [listBusy, setListBusy] = useState(false);

  const [label, setLabel] = useState("test-batch");
  const [academyId, setAcademyId] = useState<string>("");
  const [teachersCount, setTeachersCount] = useState(3);
  const [parentsCount, setParentsCount] = useState(3);
  const [studentsPerParent, setStudentsPerParent] = useState(3);
  const [teachersPerStudent, setTeachersPerStudent] = useState(2);

  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [lastCreated, setLastCreated] = useState<CreateSeedBatchResponse | null>(null);

  const [deleteSeedBatchId, setDeleteSeedBatchId] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    const unsub = auth.onAuthStateChanged(async (u) => {
      setUser(u);
      if (!u) {
        setAdminOk(false);
        return;
      }
      try {
        const tokenResult = await u.getIdTokenResult();
        setAdminOk(tokenResult?.claims?.admin === true);
      } catch {
        setAdminOk(false);
      }
    });
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshBatches = useCallback(async () => {
    if (!adminOk) return;
    setListBusy(true);
    try {
      const fn = httpsCallable(functions, "listSeedBatches");
      const res = await fn({ limit: 10 });
      const data = res.data as { ok?: boolean; batches?: unknown };
      setBatches(
        Array.isArray((data as { batches?: unknown }).batches)
          ? ((data.batches as SeedBatchListItem[]) ?? [])
          : [],
      );
    } catch {
      setBatches([]);
    } finally {
      setListBusy(false);
    }
  }, [adminOk, functions]);

  useEffect(() => {
    void refreshBatches();
  }, [refreshBatches]);

  const onLogin = useCallback(async () => {
    if (!configured) return;
    setAuthBusy(true);
    setLoginError(null);
    try {
      await signInWithEmailAndPassword(auth, loginEmail.trim(), loginPassword);
    } catch (err) {
      setLoginError(getErrorMessage(err));
    } finally {
      setAuthBusy(false);
    }
  }, [auth, configured, loginEmail, loginPassword]);

  const onGoogleLogin = useCallback(async () => {
    if (!configured) return;
    setAuthBusy(true);
    setLoginError(null);
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);

      const fn = httpsCallable(functions, "enforceAdminLogin");
      const res = await fn({});
      const data = res.data as EnforceAdminLoginResponse;

      if (!data.ok) {
        setLoginError(
          data.deleted
            ? "관리자 권한이 없는 계정은 로그인 시도 후 자동으로 삭제되었습니다."
            : "관리자 계정만 로그인 가능합니다.",
        );
        await signOut(auth);
        setAdminOk(false);
        return;
      }

      const u = auth.currentUser;
      if (u) {
        const tokenResult = await u.getIdTokenResult(true);
        setAdminOk(tokenResult.claims.admin === true);
      }
    } catch (err) {
      setLoginError(getErrorMessage(err));
      try {
        await signOut(auth);
      } catch {
        // ignore
      }
    } finally {
      setAuthBusy(false);
    }
  }, [auth, configured, functions]);

  const onLogout = useCallback(async () => {
    setAuthBusy(true);
    try {
      await signOut(auth);
    } finally {
      setAuthBusy(false);
    }
  }, [auth]);

  const canCreate = useMemo(() => {
    if (!configured) return false;
    if (!adminOk) return false;
    if (createBusy) return false;
    if (teachersCount < 1 || parentsCount < 1 || studentsPerParent < 1) return false;
    return true;
  }, [adminOk, configured, createBusy, parentsCount, studentsPerParent, teachersCount]);

  const onCreate = useCallback(async () => {
    setCreateBusy(true);
    setCreateError(null);
    setLastCreated(null);
    try {
      const ok = window.confirm(
        "운영 Firestore/Auth에 가상 계정과 데이터를 생성합니다. 계속 진행할까요?",
      );
      if (!ok) return;

      const fn = httpsCallable(functions, "createSeedBatch");
      const res = await fn({
        label: label.trim(),
        academyId: academyId.trim() ? academyId.trim() : undefined,
        teachersCount,
        parentsCount,
        studentsPerParent,
        teachersPerStudent,
      });
      const data = res.data as CreateSeedBatchResponse;
      setLastCreated(data);
      await refreshBatches();
    } catch (err) {
      setCreateError(getErrorMessage(err));
    } finally {
      setCreateBusy(false);
    }
  }, [
    academyId,
    functions,
    label,
    parentsCount,
    refreshBatches,
    studentsPerParent,
    teachersCount,
    teachersPerStudent,
  ]);

  const onDelete = useCallback(async () => {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const batchId = deleteSeedBatchId.trim();
      if (!batchId) {
        setDeleteError("seedBatchId를 입력해 주세요.");
        return;
      }
      const ok = window.confirm(
        "선택한 seed 배치를 삭제합니다. Auth 사용자 및 해당 학원 하위 데이터가 삭제됩니다. 계속 진행할까요?",
      );
      if (!ok) return;

      const fn = httpsCallable(functions, "deleteSeedBatch");
      await fn({ seedBatchId: batchId });
      setDeleteSeedBatchId("");
      await refreshBatches();
    } catch (err) {
      setDeleteError(getErrorMessage(err));
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteSeedBatchId, functions, refreshBatches]);

  if (!configured) {
    return (
      <div className="min-h-[100dvh] bg-background px-4 py-12 flex flex-col items-center justify-center">
        <div className="w-full max-w-lg text-center">
          <p className="text-sm text-neutral-600">Firebase 환경 변수를 먼저 설정해 주세요.</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-[100dvh] bg-background px-4 py-12 flex flex-col items-center justify-center">
        <div className="glass-card-soft w-full max-w-md p-8 text-center">
          <h1 className="text-lg font-semibold text-foreground">admin. seed 대시보드</h1>
          <p className="mt-2 text-xs text-neutral-500">
            Firebase Custom Claim <code className="font-mono">admin=true</code> 계정만 사용 가능합니다.
          </p>

          <div className="mt-6 space-y-4 text-left">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-neutral-600">이메일</span>
              <input
                value={loginEmail}
                onChange={(e) => setLoginEmail(e.target.value)}
                className="w-full rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-3 text-foreground outline-none focus:border-[#4a90e2]/50 dark:border-white/12 dark:bg-white/[0.08]"
                placeholder="admin@example.com"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-neutral-600">비밀번호</span>
              <input
                type="password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                className="w-full rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-3 text-foreground outline-none focus:border-[#4a90e2]/50 dark:border-white/12 dark:bg-white/[0.08]"
                placeholder="••••••••"
              />
            </label>

            {loginError ? (
              <p className="rounded-xl bg-red-500/10 px-3 py-2 text-center text-xs text-red-800 ring-1 ring-red-500/15">
                {loginError}
              </p>
            ) : null}

            <button
              type="button"
              disabled={authBusy || !loginEmail.trim() || !loginPassword}
              onClick={() => void onLogin()}
              className="w-full rounded-2xl bg-[#222] px-4 py-3 text-sm font-medium text-white transition hover:bg-[#333] disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-950 dark:hover:bg-white"
            >
              {authBusy ? "로그인 중…" : "관리자 로그인"}
            </button>

            <div className="my-7 flex items-center gap-3">
              <span className="h-px flex-1 bg-gradient-to-r from-transparent via-neutral-300 to-neutral-300" />
              <span className="shrink-0 text-[11px] text-neutral-500">
                또는
              </span>
              <span className="h-px flex-1 bg-gradient-to-l from-transparent via-neutral-300 to-neutral-300" />
            </div>

            <button
              type="button"
              disabled={authBusy || !configured}
              onClick={() => void onGoogleLogin()}
              className="flex w-full items-center justify-center gap-3 rounded-2xl border border-neutral-300/70 bg-white/60 py-3.5 text-[15px] font-medium text-foreground shadow-sm backdrop-blur-md transition hover:bg-white/85 active:scale-[0.99] disabled:opacity-50 dark:border-white/12 dark:bg-white/10"
            >
              <GoogleMark />
              Google로 관리자 로그인
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!adminOk) {
    return (
      <div className="min-h-[100dvh] bg-background px-4 py-12 flex flex-col items-center justify-center">
        <div className="glass-card-soft w-full max-w-md p-8 text-center">
          <h1 className="text-lg font-semibold text-foreground">권한이 없습니다</h1>
          <p className="mt-2 text-xs text-neutral-600">
            내 계정에 <code className="font-mono">admin=true</code> 커스텀 클레임이 설정돼 있는지 확인해 주세요.
          </p>
          <button
            type="button"
            disabled={authBusy}
            onClick={() => void onLogout()}
            className="mt-6 w-full rounded-2xl bg-[#222] px-4 py-3 text-sm font-medium text-white transition hover:bg-[#333] disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-950 dark:hover:bg-white"
          >
            로그아웃
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-background px-4 pb-28">
      <div className="mx-auto max-w-2xl pt-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-foreground">admin. 가상 계정/데이터 시드</h1>
            <p className="mt-2 text-sm text-neutral-600">
              운영 Firestore/Auth에 영향을 줍니다. 생성/삭제 전 항상 확인해 주세요.
            </p>
          </div>
          <div>
            <button
              type="button"
              disabled={authBusy}
              onClick={() => void onLogout()}
              className="rounded-2xl border border-neutral-300/70 bg-white/50 px-4 py-2 text-sm font-medium text-foreground hover:bg-white/70 disabled:opacity-50 dark:border-white/12 dark:bg-white/[0.08]"
            >
              로그아웃
            </button>
          </div>
        </div>

        <div className="mt-6 space-y-4">
          <section className="glass-card-soft p-5">
            <h2 className="text-sm font-semibold text-foreground">일괄 생성</h2>
            <p className="mt-1 text-xs text-neutral-500">
              owner/teacher/parent 이메일/비밀번호는 생성 직후 응답으로만 제공됩니다.
            </p>

            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-neutral-600">배치 라벨</span>
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  className="w-full rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-3 text-foreground outline-none focus:border-[#4a90e2]/50 dark:border-white/12 dark:bg-white/[0.08]"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-neutral-600">학원 ID(선택)</span>
                <input
                  value={academyId}
                  onChange={(e) => setAcademyId(e.target.value)}
                  className="w-full rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-3 text-foreground outline-none focus:border-[#4a90e2]/50 dark:border-white/12 dark:bg-white/[0.08]"
                  placeholder="attn_academy_01"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-neutral-600">선생님 수(1~10)</span>
                <input
                  type="number"
                  value={teachersCount}
                  onChange={(e) => setTeachersCount(Number(e.target.value))}
                  className="w-full rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-3 text-foreground outline-none focus:border-[#4a90e2]/50 dark:border-white/12 dark:bg-white/[0.08]"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-neutral-600">학부모 수(1~10)</span>
                <input
                  type="number"
                  value={parentsCount}
                  onChange={(e) => setParentsCount(Number(e.target.value))}
                  className="w-full rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-3 text-foreground outline-none focus:border-[#4a90e2]/50 dark:border-white/12 dark:bg-white/[0.08]"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-neutral-600">학부모당 학생 수(1~10)</span>
                <input
                  type="number"
                  value={studentsPerParent}
                  onChange={(e) => setStudentsPerParent(Number(e.target.value))}
                  className="w-full rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-3 text-foreground outline-none focus:border-[#4a90e2]/50 dark:border-white/12 dark:bg-white/[0.08]"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-neutral-600">학생당 선생님 수(1~5)</span>
                <input
                  type="number"
                  value={teachersPerStudent}
                  onChange={(e) => setTeachersPerStudent(Number(e.target.value))}
                  className="w-full rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-3 text-foreground outline-none focus:border-[#4a90e2]/50 dark:border-white/12 dark:bg-white/[0.08]"
                />
              </label>
            </div>

            {createError ? (
              <p className="mt-3 rounded-xl bg-red-500/10 px-3 py-2 text-center text-xs text-red-800 ring-1 ring-red-500/15">
                {createError}
              </p>
            ) : null}

            <button
              type="button"
              disabled={!canCreate}
              onClick={() => void onCreate()}
              className="mt-4 w-full rounded-2xl bg-[#222] px-4 py-3 text-sm font-medium text-white transition hover:bg-[#333] disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-950 dark:hover:bg-white"
            >
              {createBusy ? "생성 중…" : "가상 계정/데이터 생성"}
            </button>
          </section>

          {lastCreated ? (
            <section className="glass-card-soft p-5">
              <h2 className="text-sm font-semibold text-foreground">생성 결과</h2>
              <p className="mt-1 text-xs text-neutral-600">
                seedBatchId: <span className="font-mono">{lastCreated.seedBatchId}</span>
              </p>
              <p className="mt-1 text-xs text-neutral-600">
                academyId: <span className="font-mono">{lastCreated.academyId}</span>
              </p>

              <div className="mt-4 space-y-4">
                <div className="rounded-2xl border border-neutral-300/60 bg-white/50 p-4">
                  <h3 className="text-xs font-semibold text-neutral-700">오너</h3>
                  <p className="mt-1 text-xs text-neutral-600">
                    이메일: <span className="font-mono">{lastCreated.credentials?.owner?.email}</span>
                  </p>
                  <p className="mt-1 text-xs text-neutral-600">
                    비밀번호:{" "}
                    <span className="font-mono">{lastCreated.credentials?.owner?.password}</span>
                  </p>
                </div>

                <div className="rounded-2xl border border-neutral-300/60 bg-white/50 p-4">
                  <h3 className="text-xs font-semibold text-neutral-700">선생님</h3>
                  <div className="mt-2 space-y-2">
                    {Array.isArray(lastCreated.credentials.teachers) ? (
                      lastCreated.credentials.teachers.map((t, i) => (
                        <div key={t.email} className="text-xs text-neutral-700">
                          #{i + 1} 이메일{" "}
                          <span className="font-mono">{t.email}</span> / 비밀번호{" "}
                          <span className="font-mono">{t.password}</span>
                        </div>
                      ))
                    ) : (
                      <p className="text-xs text-neutral-500">없음</p>
                    )}
                  </div>
                </div>

                <div className="rounded-2xl border border-neutral-300/60 bg-white/50 p-4">
                  <h3 className="text-xs font-semibold text-neutral-700">학부모</h3>
                  <div className="mt-2 space-y-2">
                    {Array.isArray(lastCreated.credentials.parents) ? (
                      lastCreated.credentials.parents.map((p, i) => (
                        <div key={p.email} className="text-xs text-neutral-700">
                          #{i + 1} 이메일{" "}
                          <span className="font-mono">{p.email}</span> / 비밀번호{" "}
                          <span className="font-mono">{p.password}</span>
                        </div>
                      ))
                    ) : (
                      <p className="text-xs text-neutral-500">없음</p>
                    )}
                  </div>
                </div>
              </div>
            </section>
          ) : null}

          <section className="glass-card-soft p-5">
            <h2 className="text-sm font-semibold text-foreground">일괄 삭제</h2>
            <p className="mt-1 text-xs text-neutral-500">삭제는 해당 배치에 생성된 Auth 사용자와 학원 하위 데이터를 제거합니다.</p>

            <div className="mt-3 flex flex-col sm:flex-row gap-3">
              <input
                value={deleteSeedBatchId}
                onChange={(e) => setDeleteSeedBatchId(e.target.value)}
                className="flex-1 rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-3 text-foreground outline-none focus:border-[#4a90e2]/50 dark:border-white/12 dark:bg-white/[0.08]"
                placeholder="seedBatchId 입력"
              />
              <button
                type="button"
                disabled={deleteBusy || !deleteSeedBatchId.trim()}
                onClick={() => void onDelete()}
                className="rounded-2xl bg-red-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-red-700 disabled:opacity-50"
              >
                {deleteBusy ? "삭제 중…" : "삭제"}
              </button>
            </div>
            {deleteError ? (
              <p className="mt-3 rounded-xl bg-red-500/10 px-3 py-2 text-center text-xs text-red-800 ring-1 ring-red-500/15">
                {deleteError}
              </p>
            ) : null}

            <div className="mt-4">
              <h3 className="text-xs font-semibold text-neutral-700">최근 배치</h3>
              <div className="mt-2 space-y-2">
                {listBusy ? (
                  <p className="text-xs text-neutral-500">불러오는 중…</p>
                ) : batches.length === 0 ? (
                  <p className="text-xs text-neutral-500">최근 배치가 없습니다.</p>
                ) : (
                  batches.map((b) => (
                    <div key={b.seedBatchId} className="flex items-center justify-between gap-3 rounded-2xl border border-neutral-300/60 bg-white/50 px-3 py-2">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-neutral-800 truncate">
                          {b.label} ({b.academyId})
                        </p>
                        <p className="text-[11px] text-neutral-600 break-all">
                          {b.seedBatchId}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={b.deletedAt}
                        onClick={() => setDeleteSeedBatchId(b.seedBatchId)}
                        className="rounded-2xl border border-neutral-300/70 bg-white/60 px-3 py-2 text-[11px] font-medium text-foreground hover:bg-white/85 disabled:opacity-50"
                      >
                        {b.deletedAt ? "삭제됨" : "이 배치 삭제"}
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}


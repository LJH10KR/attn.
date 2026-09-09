"use client";

import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
  type Timestamp,
} from "firebase/firestore";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HomeTabIcon } from "@/components/dashboard/attn-tab-logo";
import { DashboardBottomScrim } from "@/components/dashboard/dashboard-bottom-scrim";
import { DashboardRoleHeader } from "@/components/dashboard/dashboard-role-header";
import { AcademyPanelRefreshButton } from "@/components/academy/academy-panel-refresh-button";
import { useRoleLogout } from "@/lib/auth/use-role-logout";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import { useAuthProfile } from "@/lib/firebase/use-auth-profile";
import {
  getFirebaseAuth,
  getFirebaseDb,
  getFirebaseFunctions,
} from "@/lib/firebase/client-app";
import { fetchIsOwner } from "@/lib/firebase/owner-profile";
import { COLLECTIONS, type Academy } from "@/lib/firebase/attn-schema";
import { useBodyScrollLock } from "@/lib/ui/use-body-scroll-lock";
import { useAcademyListPoll } from "@/lib/firebase/use-academy-list-poll";
import { setLastDashboardRoleHint } from "@/lib/auth/last-dashboard-role";
import { useBootOverlay } from "@/components/boot/boot-overlay";
import { AcademyRegistrationOverlay } from "@/components/owner/academy-registration-overlay";
import { attnIdSortKey, compareAttnIdAsc } from "@/lib/attn-id-sort";
import { buildDashboardHeaderProfile } from "@/lib/ui/dashboard-header-profile";

type AcademyRow = Academy & { id: string };

const glassCard = "glass-card";

const inputClass =
  "w-full rounded-2xl border border-neutral-300/60 bg-white/50 dark:border-white/12 dark:bg-white/[0.08] px-4 py-3 text-foreground shadow-inner outline-none focus:border-[#4a90e2]/50 focus:bg-white/70 focus:shadow-[0_0_0_3px_rgba(74,144,226,0.18)]";

function formatDate(ts: Timestamp | undefined): string {
  if (!ts?.toDate) {
    return "—";
  }
  return ts.toDate().toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function ownerFirebaseErrorMessage(err: FirebaseError): string {
  switch (err.code) {
    case "functions/already-exists":
      return "이미 사용 중인 학원 ID입니다.";
    case "functions/permission-denied":
    case "permission-denied":
      return "권한이 없습니다.";
    case "functions/not-found":
    case "not-found":
      return "학원을 찾을 수 없습니다.";
    case "functions/unauthenticated":
      return "로그인이 필요합니다.";
    case "functions/invalid-argument":
      return err.message || "입력값을 확인해 주세요.";
    default:
      return err.message || "요청에 실패했습니다.";
  }
}

export function OwnerDashboard() {
  const router = useRouter();
  const { hide: hideBootOverlay } = useBootOverlay();
  const { profile: authProfile } = useAuthProfile();
  const { logout: onLogout, logoutBusy, logoutModal } = useRoleLogout({
    redirectTo: "/login/owner",
    role: "owner",
  });
  const [gate, setGate] = useState<"loading" | "auth" | "forbidden" | "ok">(
    "loading",
  );
  const [academies, setAcademies] = useState<AcademyRow[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [modal, setModal] = useState<"create" | "edit" | "delete" | null>(null);
  const [editTarget, setEditTarget] = useState<AcademyRow | null>(null);
  const [formName, setFormName] = useState("");
  const [formStatus, setFormStatus] = useState<"active" | "archived">("active");
  const [editPortalPassword, setEditPortalPassword] = useState("");
  const [editPortalPassword2, setEditPortalPassword2] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<AcademyRow | null>(null);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [registrationVariant, setRegistrationVariant] = useState<"first" | "add">("add");
  /** 학원 목록 첫 조회 완료 전에는 true로 두지 않음(빈 배열 레이스 방지) */
  const [academiesListReady, setAcademiesListReady] = useState(false);
  const ownerInitGenerationRef = useRef(0);
  const ownerListLoadedUidRef = useRef<string | null>(null);
  const autoRegistrationPromptedRef = useRef(false);
  const [ownerUid, setOwnerUid] = useState<string | null>(null);
  const [ownerDisplayName, setOwnerDisplayName] = useState<string | null>(null);
  const [ownerPhone, setOwnerPhone] = useState<string | null>(null);

  useBodyScrollLock(modal !== null);

  // 콜드부팅 스플래시 — 이 페이지가 어떤 형태로든 결론(ok/auth/forbidden)에 도달하면 넘겨받는다.
  useEffect(() => {
    if (gate !== "loading") hideBootOverlay();
  }, [gate, hideBootOverlay]);

  const configured = isFirebaseConfigured();

  useEffect(() => {
    if (!configured) {
      setGate("auth");
      return;
    }
    const auth = getFirebaseAuth();

    const unsubAuth = auth.onAuthStateChanged(async (user) => {
      if (!user) {
        ownerInitGenerationRef.current += 1;
        ownerListLoadedUidRef.current = null;
        setGate("auth");
        setOwnerUid(null);
        setAcademies([]);
        setAcademiesListReady(false);
        setOwnerDisplayName(null);
        setOwnerPhone(null);
        autoRegistrationPromptedRef.current = false;
        return;
      }

      const uid = user.uid;
      if (ownerListLoadedUidRef.current === uid) {
        return;
      }

      const gen = ++ownerInitGenerationRef.current;
      setAcademiesListReady(false);
      setGate("loading");
      const isOwner = await fetchIsOwner(uid);
      if (gen !== ownerInitGenerationRef.current || auth.currentUser?.uid !== uid) {
        return;
      }
      if (!isOwner) {
        setGate("forbidden");
        setOwnerUid(null);
        setAcademies([]);
        setAcademiesListReady(false);
        return;
      }
      setGate("ok");
      setLastDashboardRoleHint("owner");
      ownerListLoadedUidRef.current = uid;
      setOwnerUid(uid);
    });

    return () => {
      ownerInitGenerationRef.current += 1;
      ownerListLoadedUidRef.current = null;
      autoRegistrationPromptedRef.current = false;
      unsubAuth();
    };
  }, [configured]);

  // 표시 전용(이 화면에서 편집하지 않음) — 실시간 구독 불필요, 마운트 시 1회 조회로 충분
  useEffect(() => {
    if (!ownerUid) {
      setOwnerDisplayName(null);
      setOwnerPhone(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const db = getFirebaseDb();
        const snap = await getDoc(doc(db, COLLECTIONS.users, ownerUid));
        if (cancelled) return;
        const d = snap.data();
        setOwnerDisplayName(
          typeof d?.displayName === "string" ? d.displayName : null,
        );
        const rawPhone = typeof d?.phone === "string" ? d.phone.trim() : "";
        setOwnerPhone(rawPhone || null);
      } catch {
        if (!cancelled) {
          setOwnerDisplayName(null);
          setOwnerPhone(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ownerUid]);

  const loadAcademies = useCallback(async () => {
    if (!ownerUid) {
      setAcademies([]);
      setAcademiesListReady(true);
      return;
    }
    try {
      const db = getFirebaseDb();
      const q = query(
        collection(db, COLLECTIONS.academies),
        where("ownerUid", "==", ownerUid),
      );
      const snap = await getDocs(q);
      setListError(null);
      const rows: AcademyRow[] = [];
      snap.forEach((d) => {
        rows.push({ id: d.id, ...(d.data() as Academy) });
      });
      rows.sort((a, b) => compareAttnIdAsc(attnIdSortKey(a), attnIdSortKey(b)));
      setAcademies(rows);
    } catch (err) {
      const code = err instanceof FirebaseError ? err.code : "";
      setListError(
        code === "permission-denied"
          ? "학원 목록을 불러올 권한이 없습니다."
          : "학원 목록을 불러오지 못했습니다.",
      );
    } finally {
      setAcademiesListReady(true);
    }
  }, [ownerUid]);

  const { refresh: refreshAcademies, busy: academiesRefreshing } = useAcademyListPoll(
    loadAcademies,
    [ownerUid],
  );

  const headerProfile = useMemo(
    () =>
      buildDashboardHeaderProfile(authProfile, {
        displayName: ownerDisplayName,
        phone: ownerPhone,
      }),
    [authProfile, ownerDisplayName, ownerPhone],
  );

  useEffect(() => {
    if (gate === "auth" && configured) {
      router.replace("/login/owner");
    }
  }, [configured, gate, router]);

  const openCreate = useCallback((variant: "first" | "add" = "add") => {
    setRegistrationVariant(variant);
    setRegistrationOpen(true);
  }, []);

  useEffect(() => {
    if (
      gate !== "ok" ||
      !academiesListReady ||
      academies.length > 0 ||
      registrationOpen ||
      autoRegistrationPromptedRef.current
    ) {
      return;
    }
    autoRegistrationPromptedRef.current = true;
    setRegistrationVariant("first");
    setRegistrationOpen(true);
  }, [gate, academiesListReady, academies.length, registrationOpen]);

  const openEdit = useCallback((row: AcademyRow) => {
    setFormError(null);
    setEditTarget(row);
    setFormName(row.name);
    setFormStatus(row.status === "archived" ? "archived" : "active");
    setEditPortalPassword("");
    setEditPortalPassword2("");
    setModal("edit");
  }, []);

  const openDelete = useCallback((row: AcademyRow) => {
    setDeleteTarget(row);
    setModal("delete");
  }, []);

  const closeModal = useCallback(() => {
    setModal(null);
    setEditTarget(null);
    setDeleteTarget(null);
    setFormError(null);
  }, []);

  const onUpdate = useCallback(async () => {
    if (!editTarget) {
      return;
    }
    const name = formName.trim();
    if (!name) {
      setFormError("학원 이름을 입력해 주세요.");
      return;
    }
    const wantsPwChange =
      editPortalPassword.length > 0 || editPortalPassword2.length > 0;
    if (wantsPwChange) {
      if (editPortalPassword.length < 6) {
        setFormError("새 포털 비밀번호는 6자 이상이어야 합니다.");
        return;
      }
      if (editPortalPassword !== editPortalPassword2) {
        setFormError("새 포털 비밀번호가 서로 일치하지 않습니다.");
        return;
      }
    }
    setBusy(true);
    setFormError(null);
    try {
      const db = getFirebaseDb();
      await updateDoc(doc(db, COLLECTIONS.academies, editTarget.id), {
        name,
        status: formStatus,
        updatedAt: serverTimestamp(),
      });
      if (wantsPwChange) {
        const pwFn = httpsCallable(
          getFirebaseFunctions(),
          "updateAcademyPortalPassword",
        );
        await pwFn({
          academyId: editTarget.id,
          portalPassword: editPortalPassword,
        });
      }
      refreshAcademies();
      closeModal();
    } catch (err) {
      if (err instanceof FirebaseError) {
        setFormError(ownerFirebaseErrorMessage(err));
      } else {
        setFormError("수정에 실패했습니다.");
      }
    } finally {
      setBusy(false);
    }
  }, [
    closeModal,
    editPortalPassword,
    editPortalPassword2,
    editTarget,
    formName,
    formStatus,
    refreshAcademies,
  ]);

  const onDelete = useCallback(async () => {
    if (!deleteTarget) {
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const delFn = httpsCallable(getFirebaseFunctions(), "deleteOwnerAcademy");
      await delFn({ academyId: deleteTarget.id });
      refreshAcademies();
      closeModal();
    } catch (err) {
      if (err instanceof FirebaseError) {
        setFormError(ownerFirebaseErrorMessage(err));
      } else {
        setFormError("삭제에 실패했습니다.");
      }
    } finally {
      setBusy(false);
    }
  }, [closeModal, deleteTarget, refreshAcademies]);

  if (!configured) {
    return (
      <div className="min-h-[100dvh] bg-background flex items-center justify-center px-4">
        <p className="text-sm text-neutral-600">Firebase 설정이 필요합니다.</p>
      </div>
    );
  }

  if (gate === "loading") {
    return (
      <div className="min-h-[100dvh] bg-background flex items-center justify-center">
        <p className="text-sm text-neutral-500">불러오는 중…</p>
      </div>
    );
  }

  if (gate === "auth") {
    return (
      <div className="min-h-[100dvh] bg-background flex items-center justify-center">
        <p className="text-sm text-neutral-500">로그인 페이지로 이동합니다…</p>
      </div>
    );
  }

  if (gate === "forbidden") {
    return (
      <div className="min-h-[100dvh] bg-background px-4 py-16 flex flex-col items-center justify-center">
        <div className={`w-full max-w-md p-8 text-center ${glassCard}`}>
          <h1 className="text-lg font-semibold text-foreground">
            오너 전용 페이지
          </h1>
          <p className="mt-3 text-sm text-neutral-600">
            오너로 등록된 계정만 이용할 수 있습니다. 학원 오너 회원가입을 진행해
            주세요.
          </p>
          <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
            <Link
              href="/signup"
              className="inline-flex justify-center rounded-2xl bg-[#222] dark:bg-neutral-100 px-6 py-3 text-sm font-medium text-white dark:text-neutral-950"
            >
              오너 회원가입
            </Link>
            <Link
              href="/login"
              className="inline-flex justify-center rounded-2xl border border-neutral-300/70 bg-white/50 px-6 py-3 text-sm font-medium text-foreground"
            >
              로그인
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-background pb-28">
      <DashboardRoleHeader
        title="오너 대시보드"
        affiliationLabel={
          academies.length === 0
            ? "등록된 학원 없음"
            : academies.length === 1
              ? academies[0].name
              : `${academies[0].name} 외 ${academies.length - 1}곳`
        }
        includeSettingsAction
        onSettingsAction={() => router.push("/owner/settings")}
        onHomeAction={() => router.push("/")}
        bottomTabs={[
          {
            id: "home",
            label: "홈",
            iconAction: (active: boolean) => <HomeTabIcon active={active} />,
            active: true,
            onSelectAction: () => router.push("/"),
          },
        ]}
        onLogoutAction={() => void onLogout()}
        logoutBusy={logoutBusy}
        profile={headerProfile}
      />

      <main className="mx-auto max-w-lg px-4 pt-[26px]">
        <div className="mb-5 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-foreground">내 학원</h2>
          <div className="flex shrink-0 items-center gap-2">
            <AcademyPanelRefreshButton
              busy={academiesRefreshing}
              onRefreshAction={refreshAcademies}
            />
            <button
              type="button"
              onClick={() => openCreate(academies.length === 0 ? "first" : "add")}
              className="rounded-[8px] bg-[#222] dark:bg-neutral-100 px-3 py-2 text-[11px] font-medium text-white dark:text-neutral-950 shadow-md hover:bg-[#333] dark:hover:bg-white"
            >
              + 학원 등록
            </button>
          </div>
        </div>

        {listError ? (
          <p className="mb-4 rounded-2xl bg-red-500/10 px-3 py-2.5 text-center text-sm text-red-800 ring-1 ring-red-500/15">
            {listError}
          </p>
        ) : null}

        {academies.length === 0 && !listError ? (
          <div className={`p-8 text-center ${glassCard}`}>
            <p className="text-sm text-neutral-600">등록된 학원이 없습니다.</p>
            <button
              type="button"
              onClick={() => openCreate(academies.length === 0 ? "first" : "add")}
              className="mt-4 rounded-2xl bg-[#222] dark:bg-neutral-100 px-6 py-3 text-sm font-medium text-white dark:text-neutral-950"
            >
              첫 학원 등록하기
            </button>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {academies.map((a) => (
              <li key={a.id} className={`p-4 ${glassCard}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-foreground">
                      {a.name}
                    </p>
                    <p className="mt-1 font-mono text-[10px] text-neutral-400">
                      로그인 번호 · {a.attnId ?? a.id}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                      <span
                        className={`rounded-full px-2 py-0.5 ring-1 ${
                          a.status === "archived"
                            ? "bg-neutral-200/50 text-neutral-600 ring-neutral-300/50"
                            : "bg-emerald-500/10 text-emerald-800 ring-emerald-500/20"
                        }`}
                      >
                        {a.status === "archived" ? "운영 종료" : "운영 중"}
                      </span>
                      <span>등록 {formatDate(a.createdAt)}</span>
                    </div>
                  </div>
                </div>
                <div className="mt-4 flex flex-col gap-2">
                  <Link
                    href={`/academy?id=${encodeURIComponent(a.id)}&from=owner`}
                    className="w-full rounded-[8px] bg-[#222] dark:bg-neutral-100 py-2.5 text-center text-xs font-medium text-white dark:text-neutral-950 shadow-sm hover:bg-[#333] dark:hover:bg-white"
                  >
                    학원 대시보드
                  </Link>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => openEdit(a)}
                      className="flex-1 rounded-[8px] border border-neutral-300/60 bg-white/40 py-2 text-xs font-medium text-foreground hover:bg-white/70"
                    >
                      수정
                    </button>
                    <button
                      type="button"
                      onClick={() => openDelete(a)}
                      className="flex-1 rounded-[8px] border border-red-200/60 bg-red-500/5 py-2 text-xs font-medium text-red-800 hover:bg-red-500/10"
                    >
                      삭제
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* <p className="mt-8 text-center text-xs text-neutral-500">
          <Link href="/" className="underline-offset-2 hover:underline">
            홈으로
          </Link>
        </p> */}
      </main>

      <DashboardBottomScrim />

      <AcademyRegistrationOverlay
        open={registrationOpen}
        variant={registrationVariant}
        onCloseAction={() => setRegistrationOpen(false)}
        onAcademyCreatedAction={refreshAcademies}
      />

      {modal === "edit" ? (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-black/25 p-4 py-8"
          role="dialog"
          aria-modal="true"
          aria-labelledby="academy-form-title"
        >
          <div
            className={`my-auto flex max-h-[min(85dvh,calc(100dvh-6rem))] w-full max-w-md flex-col p-6 ${glassCard}`}
            style={{ WebkitBackdropFilter: "blur(24px)" }}
          >
            <h3
              id="academy-form-title"
              className="shrink-0 text-lg font-semibold text-foreground"
            >
              학원 수정
            </h3>
            <div className="mt-4 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
              {editTarget ? (
                <div>
                  <p className="mb-1 text-xs font-medium text-neutral-600">
                    학원 로그인 번호
                  </p>
                  <p className="rounded-2xl border border-neutral-200/80 bg-white/40 px-4 py-3 font-mono text-sm text-foreground">
                    {editTarget.attnId ?? editTarget.id}
                  </p>
                  <p className="mt-1 text-[11px] text-neutral-500">
                    등록 후에는 번호를 바꿀 수 없습니다.
                  </p>
                </div>
              ) : null}
              <div>
                <label
                  className="mb-1 block text-xs font-medium text-neutral-600"
                  htmlFor="ac-name"
                >
                  학원 이름
                </label>
                <input
                  id="ac-name"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  className={inputClass}
                  placeholder="예: 햇살 수학학원"
                  maxLength={80}
                />
              </div>
              <>
                <p className="text-xs font-medium text-neutral-600">
                  포털 비밀번호 변경 (선택)
                </p>
                <input
                  type="password"
                  value={editPortalPassword}
                  onChange={(e) => setEditPortalPassword(e.target.value)}
                  className={inputClass}
                  placeholder="변경 시에만 입력 (6자 이상)"
                  autoComplete="new-password"
                />
                <input
                  type="password"
                  value={editPortalPassword2}
                  onChange={(e) => setEditPortalPassword2(e.target.value)}
                  className={inputClass}
                  placeholder="새 비밀번호 확인"
                  autoComplete="new-password"
                />
              </>
              <div>
                <label
                  className="mb-1 block text-xs font-medium text-neutral-600"
                  htmlFor="ac-status"
                >
                  상태
                </label>
                <select
                  id="ac-status"
                  value={formStatus}
                  onChange={(e) =>
                    setFormStatus(e.target.value as "active" | "archived")
                  }
                  className={inputClass}
                >
                  <option value="active">운영 중</option>
                  <option value="archived">운영 종료</option>
                </select>
              </div>
            </div>
            {formError ? (
              <p className="mt-3 shrink-0 text-sm text-red-700" role="alert">
                {formError}
              </p>
            ) : null}
            <div className="mt-6 flex shrink-0 gap-2">
              <button
                type="button"
                onClick={closeModal}
                className="flex-1 rounded-2xl border border-neutral-300/70 py-3 text-sm font-medium text-neutral-700"
              >
                취소
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void onUpdate()}
                className="flex-1 rounded-2xl bg-[#222] dark:bg-neutral-100 py-3 text-sm font-medium text-white dark:text-neutral-950 disabled:opacity-50"
              >
                {busy ? "처리 중…" : "저장"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {modal === "delete" && deleteTarget ? (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-black/25 p-4 py-8"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-title"
        >
          <div className={`my-auto w-full max-w-md p-6 ${glassCard}`}>
            <h3
              id="delete-title"
              className="text-lg font-semibold text-foreground"
            >
              학원 삭제
            </h3>
            <p className="mt-3 text-sm text-neutral-600">
              <span className="font-medium text-foreground">
                {deleteTarget.name}
              </span>{" "}
              정보를 삭제합니다. 하위 선생님·학부모 데이터는 자동으로 지워지지
              않을 수 있습니다.
            </p>
            {formError ? (
              <p className="mt-3 text-sm text-red-700" role="alert">
                {formError}
              </p>
            ) : null}
            <div className="mt-6 flex gap-2">
              <button
                type="button"
                onClick={closeModal}
                className="flex-1 rounded-2xl border border-neutral-300/70 py-3 text-sm font-medium text-neutral-700"
              >
                취소
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={onDelete}
                className="flex-1 rounded-2xl bg-red-600 py-3 text-sm font-medium text-white dark:text-neutral-950 disabled:opacity-50"
              >
                {busy ? "처리 중…" : "삭제"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {logoutModal}
    </div>
  );
}

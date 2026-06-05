"use client";

import { FirebaseError } from "firebase/app";
import {
  EmailAuthProvider,
  GoogleAuthProvider,
  linkWithPopup,
  onAuthStateChanged,
  reauthenticateWithCredential,
  type User,
} from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { useCallback, useEffect, useMemo, useState } from "react";
import { GoogleMark } from "@/components/auth/google-mark";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import { getFirebaseAuth, getFirebaseFunctions } from "@/lib/firebase/client-app";

const glassCard = "glass-card";

function hasProvider(user: User, providerId: string): boolean {
  return user.providerData.some((p) => p.providerId === providerId);
}

function googleProviderEmail(user: User): string | null {
  const p = user.providerData.find((x) => x.providerId === "google.com");
  return p?.email ?? null;
}

function linkGoogleErrorMessage(code: string): string {
  switch (code) {
    case "auth/credential-already-in-use":
      return "이 Google 계정은 다른 attn. 계정에 이미 연결되어 있습니다.";
    case "auth/email-already-in-use":
      return "이 Google 계정은 이미 다른 방식으로 사용 중입니다.";
    case "auth/provider-already-linked":
      return "이미 Google 계정이 연결되어 있습니다.";
    case "auth/popup-closed-by-user":
      return "연결 창이 닫혔습니다.";
    case "auth/network-request-failed":
      return "네트워크 오류입니다. 연결을 확인해 주세요.";
    case "auth/requires-recent-login":
      return "";
    default:
      return "Google 계정 연결에 실패했습니다. 잠시 후 다시 시도해 주세요.";
  }
}

export type TeacherGoogleLinkCardProps = {
  loginId?: string;
  googleLinked?: boolean;
  googleEmail?: string;
};

export function TeacherGoogleLinkCard({
  loginId,
  googleLinked,
  googleEmail: googleEmailStored,
}: TeacherGoogleLinkCardProps) {
  const [user, setUser] = useState<User | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkedEmail, setLinkedEmail] = useState<string | null>(null);
  const [needReauth, setNeedReauth] = useState(false);
  const [reauthPassword, setReauthPassword] = useState("");

  const configured = isFirebaseConfigured();

  useEffect(() => {
    if (!configured) return;
    const auth = getFirebaseAuth();
    return onAuthStateChanged(auth, setUser);
  }, [configured]);

  const firebaseState = useMemo(() => {
    if (!user) return { kind: "none" as const };
    const google = hasProvider(user, "google.com");
    const password = hasProvider(user, "password");
    if (google && password) return { kind: "both" as const };
    if (google && !password) return { kind: "googleOnly" as const };
    if (!google && password) return { kind: "passwordOnly" as const };
    return { kind: "other" as const };
  }, [user]);

  const runLinkWithPopup = useCallback(async (u: User) => {
    const provider = new GoogleAuthProvider();
    const hint = u.email;
    if (hint) {
      provider.setCustomParameters({ login_hint: hint });
    }
    await linkWithPopup(u, provider);
    await u.reload();
    const fn = httpsCallable(getFirebaseFunctions(), "syncTeacherGoogleLink");
    const res = await fn({});
    const data = res.data as { googleEmail?: string };
    setLinkedEmail(data.googleEmail ?? googleProviderEmail(u));
  }, []);

  const onLinkGoogle = useCallback(async () => {
    if (!configured) return;
    const u = getFirebaseAuth().currentUser;
    if (!u) {
      setError("로그인이 필요합니다.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await runLinkWithPopup(u);
      setNeedReauth(false);
      setReauthPassword("");
    } catch (err) {
      if (err instanceof FirebaseError) {
        if (err.code === "auth/requires-recent-login") {
          setNeedReauth(true);
          setError(
            "보안을 위해 로그인 비밀번호로 한 번 더 본인 확인이 필요합니다.",
          );
          return;
        }
        const msg = linkGoogleErrorMessage(err.code);
        setError(msg || err.message);
        return;
      }
      setError(
        err instanceof Error ? err.message : "Google 계정 연결에 실패했습니다.",
      );
    } finally {
      setBusy(false);
    }
  }, [configured, runLinkWithPopup]);

  const onReauthAndLink = useCallback(async () => {
    if (!configured) return;
    const u = getFirebaseAuth().currentUser;
    if (!u?.email || !reauthPassword) {
      setError("비밀번호를 입력해 주세요.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const cred = EmailAuthProvider.credential(u.email, reauthPassword);
      await reauthenticateWithCredential(u, cred);
      await runLinkWithPopup(u);
      setNeedReauth(false);
      setReauthPassword("");
    } catch (err) {
      if (err instanceof FirebaseError) {
        if (
          err.code === "auth/wrong-password" ||
          err.code === "auth/invalid-credential"
        ) {
          setError("비밀번호가 올바르지 않습니다.");
          return;
        }
        setError(linkGoogleErrorMessage(err.code) || err.message);
        return;
      }
      setError(
        err instanceof Error ? err.message : "본인 확인 또는 연결에 실패했습니다.",
      );
    } finally {
      setBusy(false);
    }
  }, [configured, reauthPassword, runLinkWithPopup]);

  if (!configured || !user) return null;

  const displayGoogleEmail =
    linkedEmail ?? googleProviderEmail(user) ?? googleEmailStored ?? null;

  const showLinked =
    firebaseState.kind === "both" ||
    (googleLinked || hasProvider(user, "google.com"));

  if (showLinked) {
    return (
      <section className={`rounded-2xl p-5 ${glassCard}`} aria-label="Google 계정 연결">
        <h3 className="text-sm font-semibold text-foreground">Google 계정 연결</h3>
        <p className="mt-2 text-xs leading-relaxed text-neutral-600">
          로그인 ID·비밀번호와 Google 로그인이 연결되어 있습니다. Google로도
          로그인할 수 있습니다.
        </p>
        {displayGoogleEmail ? (
          <p className="mt-2 text-[11px] text-neutral-500">
            연결된 Google:{" "}
            <span className="font-mono text-foreground">{displayGoogleEmail}</span>
          </p>
        ) : null}
      </section>
    );
  }

  if (firebaseState.kind === "googleOnly") {
    return (
      <section className={`rounded-2xl p-5 ${glassCard}`} aria-label="Google 계정 연결">
        <h3 className="text-sm font-semibold text-foreground">Google 계정 연결</h3>
        <p className="mt-2 text-xs leading-relaxed text-neutral-600">
          Google 계정으로 로그인 중입니다.
          {displayGoogleEmail ? (
            <>
              {" "}
              (<span className="font-mono">{displayGoogleEmail}</span>)
            </>
          ) : null}
        </p>
      </section>
    );
  }

  if (firebaseState.kind !== "passwordOnly") {
    return null;
  }

  return (
    <section className={`rounded-2xl p-5 ${glassCard}`} aria-label="Google 계정 연결">
      <h3 className="text-sm font-semibold text-foreground">Google 계정 연결</h3>
      <p className="mt-2 text-xs leading-relaxed text-neutral-600">
        Google 계정을 연결하면 로그인 ID(
        {loginId ? <span className="font-mono text-[11px]">{loginId}</span> : "—"})·비밀번호
        대신 Google로도 로그인할 수 있습니다. 연결 후에도 기존 로그인 방식은 그대로
        사용할 수 있습니다.
      </p>

      {needReauth ? (
        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-neutral-600">
              로그인 비밀번호 확인
            </span>
            <input
              type="password"
              autoComplete="current-password"
              value={reauthPassword}
              onChange={(e) => setReauthPassword(e.target.value)}
              className="w-full rounded-2xl border border-neutral-300/60 bg-white/50 px-4 py-3 text-sm text-foreground outline-none focus:border-[#4a90e2]/50 dark:border-white/12 dark:bg-white/[0.08]"
              placeholder="현재 비밀번호"
            />
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={() => void onReauthAndLink()}
            className="w-full rounded-2xl bg-[#222] px-4 py-3 text-sm font-medium text-white transition hover:bg-[#333] disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-950 dark:hover:bg-white"
          >
            {busy ? "처리 중…" : "본인 확인 후 Google 연결"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setNeedReauth(false);
              setReauthPassword("");
              setError(null);
            }}
            className="w-full text-center text-xs text-neutral-500 underline-offset-2 hover:underline"
          >
            취소
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => void onLinkGoogle()}
          className="mt-4 flex w-full items-center justify-center gap-3 rounded-2xl border border-neutral-300/70 bg-white/60 py-3.5 text-sm font-medium text-foreground shadow-sm transition hover:bg-white/85 disabled:opacity-50 dark:border-white/12 dark:bg-white/10"
        >
          <GoogleMark />
          Google 계정 연결
        </button>
      )}

      {error ? (
        <p
          className="mt-3 rounded-xl bg-red-500/10 px-3 py-2 text-center text-xs text-red-800 ring-1 ring-red-500/15"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </section>
  );
}

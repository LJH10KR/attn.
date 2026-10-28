"use client";

import { onAuthStateChanged, type User } from "firebase/auth";
import { collection, doc, getDoc, getDocs, query, where } from "firebase/firestore";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { academyPath } from "@/lib/academy/academy-routes";
import { activeKioskAcademyId } from "@/lib/academy/kiosk-student-rows";
import { readLastAcademy } from "@/lib/academy/last-academy";
import { normalizePermissionList } from "@/lib/academy/permissions";
import { attnIdSortKey, compareAttnIdAsc } from "@/lib/attn-id-sort";
import { COLLECTIONS } from "@/lib/firebase/attn-schema";
import { getFirebaseAuth, getFirebaseDb } from "@/lib/firebase/client-app";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import { fetchIsOwner } from "@/lib/firebase/owner-profile";

/**
 * `/academy`로만 들어왔을 때 갈 곳.
 * - 키오스크 중: 키오스크 학원 홈
 * - 원장: 마지막으로 보던 학원(지금도 소유한 경우) → 오너 대시보드와 같은 순서의 첫 학원 → 학원이 없으면 /owner
 * - 직원: 로그인 정보의 소속 학원(메뉴 권한이 없으면 1-F 전까지 /teacher)
 */
async function resolveAcademyEntry(user: User): Promise<string | null> {
  const kioskAcademyId = activeKioskAcademyId();
  if (kioskAcademyId) return academyPath(kioskAcademyId);

  const db = getFirebaseDb();
  const owned = await getDocs(
    query(collection(db, COLLECTIONS.academies), where("ownerUid", "==", user.uid)),
  );
  if (!owned.empty) {
    const ids = owned.docs
      .map((d) => ({ id: d.id, attnId: d.get("attnId") as string | undefined }))
      .sort((a, b) => compareAttnIdAsc(attnIdSortKey(a), attnIdSortKey(b)))
      .map((a) => a.id);
    const last = readLastAcademy(user.uid);
    return academyPath(last && ids.includes(last) ? last : ids[0]);
  }

  const { claims } = await user.getIdTokenResult();
  if (claims.role === "teacher" && typeof claims.academyId === "string" && claims.academyId) {
    const staff = await getDoc(doc(db, COLLECTIONS.academies, claims.academyId, "staff", user.uid)).catch(
      () => null,
    );
    const hasMenus =
      staff?.get("status") === "active" && normalizePermissionList(staff.get("permissions")).length > 0;
    return hasMenus ? academyPath(claims.academyId) : "/teacher";
  }

  if (await fetchIsOwner(user.uid)) return "/owner";
  return null;
}

export function AcademyEntry() {
  const router = useRouter();
  const [state, setState] = useState<"loading" | "forbidden">("loading");

  useEffect(() => {
    if (!isFirebaseConfigured()) {
      setState("forbidden");
      return;
    }
    let cancelled = false;
    const unsub = onAuthStateChanged(getFirebaseAuth(), (user) => {
      if (!user) {
        router.replace("/login");
        return;
      }
      void resolveAcademyEntry(user)
        .catch(() => null)
        .then((target) => {
          if (cancelled) return;
          if (target) router.replace(target);
          else setState("forbidden");
        });
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [router]);

  if (state === "loading") {
    return (
      <div className="min-h-[100dvh] bg-background flex items-center justify-center">
        <p className="text-sm text-neutral-500">불러오는 중…</p>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-background flex flex-col items-center justify-center gap-4 px-4">
      <p className="max-w-xs text-center text-sm text-neutral-600">
        이 계정으로 들어갈 수 있는 학원이 없습니다.
      </p>
      <Link href="/login" className="text-xs text-neutral-500 underline-offset-2 hover:underline">
        로그인
      </Link>
    </div>
  );
}

"use client";

import axios, {
  isAxiosError,
  type AxiosInstance,
  type InternalAxiosRequestConfig,
} from "axios";
import { getApiBaseUrl, isFirebaseConfigured } from "@/lib/firebase/config";
import { getFirebaseAuth } from "@/lib/firebase/client-app";
import { ApiClientError, normalizeAxiosError } from "./errors";

type RetryableConfig = InternalAxiosRequestConfig & { _attnRetry401?: boolean };

const defaultBaseURL = getApiBaseUrl();

/**
 * Cloud Functions `onRequest`(HTTP) 등 백엔드와 통신할 때 사용합니다.
 * Callable(`httpsCallable`)은 Firebase SDK를 그대로 쓰는 것이 일반적입니다.
 */
export const apiClient: AxiosInstance = axios.create({
  baseURL: defaultBaseURL || undefined,
  timeout: 30_000,
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
  },
  validateStatus: (status) => status >= 200 && status < 300,
});

apiClient.interceptors.request.use(
  async (config) => {
    if (typeof window === "undefined") {
      return config;
    }
    if (!isFirebaseConfigured()) {
      return config;
    }
    try {
      const auth = getFirebaseAuth();
      const user = auth.currentUser;
      if (user) {
        const token = await user.getIdToken();
        config.headers.Authorization = `Bearer ${token}`;
      }
    } catch {
      /* 로그인 전·미초기화 */
    }
    return config;
  },
  (error) => Promise.reject(error),
);

apiClient.interceptors.response.use(
  (response) => response,
  async (error: unknown) => {
    if (!isAxiosError(error) || !error.config) {
      const fallback =
        error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
      return Promise.reject(new ApiClientError(fallback, { cause: error }));
    }

    const original = error.config as RetryableConfig;
    const status = error.response?.status;

    if (
      typeof window !== "undefined" &&
      status === 401 &&
      !original._attnRetry401 &&
      isFirebaseConfigured()
    ) {
      original._attnRetry401 = true;
      try {
        const auth = getFirebaseAuth();
        const user = auth.currentUser;
        if (user) {
          await user.getIdToken(true);
          const token = await user.getIdToken();
          original.headers.Authorization = `Bearer ${token}`;
          return apiClient.request(original);
        }
      } catch {
        /* 재시도 실패 시 아래에서 정규화 */
      }
    }

    return Promise.reject(normalizeAxiosError(error));
  },
);

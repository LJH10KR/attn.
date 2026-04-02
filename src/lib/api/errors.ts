import type { AxiosError } from "axios";

export class ApiClientError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly data?: unknown;

  constructor(
    message: string,
    options?: { status?: number; code?: string; data?: unknown; cause?: unknown },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "ApiClientError";
    this.status = options?.status;
    this.code = options?.code;
    this.data = options?.data;
  }
}

export function isApiClientError(e: unknown): e is ApiClientError {
  return e instanceof ApiClientError;
}

export function normalizeAxiosError(error: AxiosError<unknown>): ApiClientError {
  const status = error.response?.status;
  const data = error.response?.data;

  let message = error.message || "요청에 실패했습니다.";

  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    if (typeof o.message === "string") {
      message = o.message;
    } else if (typeof o.error === "string") {
      message = o.error;
    }
  } else if (error.code === "ECONNABORTED") {
    message = "요청 시간이 초과되었습니다.";
  } else if (error.code === "ERR_NETWORK") {
    message = "네트워크 연결을 확인해 주세요.";
  } else if (typeof status === "number") {
    message = `요청 실패 (${status})`;
  }

  return new ApiClientError(message, {
    status,
    code: error.code,
    data,
    cause: error,
  });
}

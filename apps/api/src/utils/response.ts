// src/utils/response.ts
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  meta?: any;
  error?: string;
}

export function ok<T>(data: T, meta?: any): ApiResponse<T> {
  return { success: true, data, meta };
}

export function fail(error: string, meta?: any): ApiResponse<null> {
  return { success: false, error, meta };
}

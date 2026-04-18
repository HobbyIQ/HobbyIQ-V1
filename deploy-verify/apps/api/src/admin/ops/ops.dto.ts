// Ops DTOs
export interface OpsActionResult {
  action: string;
  status: 'ok' | 'error';
  message?: string;
  details?: any;
}

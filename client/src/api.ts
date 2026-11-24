export class ApiError extends Error {
  status: number;
  code: string;
  details?: Record<string, string[]>;
  constructor(status: number, code: string, message: string, details?: Record<string, string[]>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error ?? {};
    throw new ApiError(res.status, e.code ?? 'unknown', e.message ?? res.statusText, e.details);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

export type Role = 'owner' | 'admin' | 'manager' | 'employee';

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  canReviewReports: boolean;
  managerId: string | null;
  status: 'active' | 'deactivated';
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  timezone: string;
}

export interface Me {
  user: User;
  organization: Organization;
}

export interface ClockStatus {
  state: 'off' | 'working' | 'on_break';
  session: { id: string; clockInAt: string } | null;
  break: { id: string; startedAt: string; kind: 'paid' | 'unpaid' } | null;
  /** Open long enough that it was probably a forgotten clock-out. */
  stale: boolean;
}

export interface WorkSession {
  id: string;
  clockInAt: string;
  clockOutAt: string | null;
  source: 'clock' | 'correction' | 'manual';
  pendingExceptionId: string | null;
  breaks: { id: string; startedAt: string; endedAt: string | null; kind: 'paid' | 'unpaid' }[];
  workedSeconds: number;
  unpaidBreakSeconds: number;
  paidBreakSeconds: number;
}

const RANK: Record<Role, number> = { employee: 0, manager: 1, admin: 2, owner: 3 };
export const atLeast = (role: Role, min: Role) => RANK[role] >= RANK[min];

export type ExceptionKind = 'missed_shift' | 'missed_clock_in' | 'missed_clock_out' | 'missed_break' | 'wrong_time';
export type ExceptionStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface ShiftShape {
  clockInAt: string;
  clockOutAt: string | null;
  breaks: { startedAt: string; endedAt: string | null; kind: 'paid' | 'unpaid' }[];
}

export interface PersonRef {
  id: string;
  firstName: string;
  lastName: string;
}

export interface PunchException {
  id: string;
  kind: ExceptionKind;
  status: ExceptionStatus;
  reason: string;
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
  workSessionId: string | null;
  original: ShiftShape | null;
  requested: ShiftShape;
  user: PersonRef;
  reviewer: PersonRef | null;
}

export const EXCEPTION_KIND_LABELS: Record<ExceptionKind, string> = {
  missed_shift: 'Missed shift',
  missed_clock_in: 'Missed clock-in',
  missed_clock_out: 'Missed clock-out',
  missed_break: 'Missed break',
  wrong_time: 'Wrong time',
};

export interface OrgSettings {
  requireSwapApproval: boolean;
  maxWeeklyHours: number | null;
}

export interface Shift {
  id: string;
  startsAt: string;
  endsAt: string;
  position: string | null;
  location: string | null;
  notes: string | null;
  isDraft: boolean;
  user: PersonRef | null;
  activeSwap: { id: string; type: SwapType; status: SwapStatus } | null;
}

export type SwapType = 'swap' | 'cover' | 'open';
export type SwapStatus = 'pending_peer' | 'pending_manager' | 'approved' | 'declined' | 'rejected' | 'cancelled';

type ShiftRef = Pick<Shift, 'id' | 'startsAt' | 'endsAt' | 'position' | 'location'>;

export interface Swap {
  id: string;
  type: SwapType;
  status: SwapStatus;
  message: string | null;
  reviewNote: string | null;
  createdAt: string;
  reviewedAt: string | null;
  shift: ShiftRef;
  targetShift: ShiftRef | null;
  requester: PersonRef;
  targetUser: PersonRef | null;
  acceptedBy: PersonRef | null;
  reviewer: PersonRef | null;
}

export const SWAP_STATUS_LABELS: Record<SwapStatus, string> = {
  pending_peer: 'Waiting for coworker',
  pending_manager: 'Waiting for manager',
  approved: 'Approved',
  declined: 'Declined',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

export const SWAP_TYPE_LABELS: Record<SwapType, string> = {
  swap: 'Shift swap',
  cover: 'Cover request',
  open: 'Open offer',
};

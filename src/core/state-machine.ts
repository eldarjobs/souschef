import { TERMINAL_STATUSES, type TaskStatus } from '../types.js';

const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  CREATED: ['QUEUED', 'CANCELLED', 'FAILED'],
  QUEUED: ['RUNNING', 'CANCELLED', 'FAILED'],
  RUNNING: ['VALIDATING', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'NEEDS_REVIEW'],
  VALIDATING: ['COMPLETED', 'NEEDS_REVIEW', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'RUNNING'],
  COMPLETED: [],
  NEEDS_REVIEW: [],
  FAILED: [],
  CANCELLED: [],
  TIMED_OUT: []
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: TaskStatus,
    readonly to: TaskStatus
  ) {
    super(`Invalid task transition ${from} -> ${to}`);
  }
}

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

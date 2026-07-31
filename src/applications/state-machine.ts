import type { ApplicationStatus } from "../db/schema";
import { AppError } from "../shared/errors";

const VALID_TRANSITIONS: Record<ApplicationStatus, readonly ApplicationStatus[]> = {
  preparing: ["prepared", "preparation_failed"],
  prepared: ["awaiting_review", "preparation_failed"],
  awaiting_review: ["approved", "preparation_failed"],
  approved: ["submitting"],
  submitting: ["submitted", "submission_failed", "submission_blocked"],
  submitted: [],
  preparation_failed: ["preparing"],
  submission_failed: ["submitting"],
  submission_blocked: [],
};

export function transitionApplication(current: ApplicationStatus, next: ApplicationStatus): void {
  const allowed = VALID_TRANSITIONS[current];
  if (!allowed.includes(next)) {
    throw new AppError(
      "invalid_transition",
      `Cannot transition application from "${current}" to "${next}".`,
    );
  }
}

export function isTerminalStatus(status: ApplicationStatus): boolean {
  return VALID_TRANSITIONS[status].length === 0;
}

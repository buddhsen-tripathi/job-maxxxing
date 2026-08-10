import type { CandidateProfile } from "../candidate/profile";
import type { JobRow } from "../db/schema";

export interface ScoreJobRequest {
  job: JobRow;
  profile: CandidateProfile;
  promptVersion: string;
  thresholds?: { strongMatch: number; review: number };
  preferUsBased?: boolean;
}

export interface AnswerQuestionRequest {
  question: string;
  job: JobRow;
  profile: CandidateProfile;
  promptVersion: string;
}

export interface LlmClient {
  readonly model: string;
  scoreJob(request: ScoreJobRequest): Promise<unknown>;
  answerQuestion?(request: AnswerQuestionRequest): Promise<unknown>;
}

export class LlmOutputInvalidError extends Error {
  constructor(
    message: string,
    public readonly rawOutput: unknown,
  ) {
    super(message);
    this.name = "LlmOutputInvalidError";
  }
}

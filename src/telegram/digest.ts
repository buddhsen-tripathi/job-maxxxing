import type { ScoredJob } from "../jobs/scoring";
import { formatNyDate } from "../shared/time";
import type { InlineButton } from "./client";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface DigestSummaryInput {
  date: Date;
  sourcesChecked: number;
  discoveredCount: number;
  newCount: number;
  eligibleCount: number;
  matchCount: number;
}

export function renderDigestSummary(input: DigestSummaryInput): string {
  return [
    `<b>Daily Job Search — ${formatNyDate(input.date)}</b>`,
    "",
    `Sources checked: ${input.sourcesChecked}`,
    `Jobs discovered: ${input.discoveredCount}`,
    `New jobs: ${input.newCount}`,
    `Eligible after filters: ${input.eligibleCount}`,
    `Strong matches: ${input.matchCount}`,
  ].join("\n");
}

export function renderNoMatches(input: Omit<DigestSummaryInput, "matchCount">): string {
  return [
    `<b>Daily Job Search — ${formatNyDate(input.date)}</b>`,
    "",
    `Sources checked: ${input.sourcesChecked}`,
    `Jobs discovered: ${input.discoveredCount}`,
    `New jobs: ${input.newCount}`,
    "",
    "No strong matches today.",
  ].join("\n");
}

export function renderJobCard(
  index: number,
  scored: ScoredJob,
): {
  text: string;
  buttons: InlineButton[][];
} {
  const { job, score } = scored;
  const lines = [
    `<b>${index}. ${escapeHtml(job.title)} — ${escapeHtml(job.company)}</b>`,
    `Match: ${score.totalScore}`,
    `Location: ${escapeHtml(job.location ?? "unknown")}${job.workplace_type && job.workplace_type !== "unknown" ? ` / ${job.workplace_type}` : ""}`,
    "",
  ];
  if (score.reasons.length > 0) {
    lines.push("Why it matches:");
    for (const reason of score.reasons.slice(0, 3)) {
      lines.push(`• ${escapeHtml(reason)}`);
    }
  }
  if (score.risks.length > 0) {
    lines.push("", "Risk:");
    for (const risk of score.risks.slice(0, 2)) {
      lines.push(`• ${escapeHtml(risk)}`);
    }
  }
  const buttons: InlineButton[][] = [
    [
      { text: "Review", callbackData: `job:review:${job.id}` },
      { text: "Shortlist", callbackData: `job:shortlist:${job.id}` },
      { text: "Skip", callbackData: `job:skip:${job.id}` },
    ],
    [
      { text: "Block company", callbackData: `job:block:${job.id}` },
      { text: "Open listing", url: job.apply_url },
    ],
  ];
  return { text: lines.join("\n"), buttons };
}

export function renderReviewCard(scored: ScoredJob): {
  text: string;
  buttons: InlineButton[][];
} {
  const { job, score } = scored;
  const lines = [
    `<b>${escapeHtml(job.title)} — ${escapeHtml(job.company)}</b>`,
    `Match: ${score.totalScore} (${score.recommendation})`,
    `Location: ${escapeHtml(job.location ?? "unknown")}`,
    "",
  ];
  if (score.evidence.length > 0) {
    lines.push("Requirements vs evidence:");
    for (const entry of score.evidence.slice(0, 5)) {
      const mark = entry.assessment === "match" ? "✓" : entry.assessment === "partial" ? "~" : "✗";
      lines.push(`${mark} ${escapeHtml(entry.jobRequirement)}`);
    }
    lines.push("");
  }
  if (score.risks.length > 0) {
    lines.push("Risks:");
    for (const risk of score.risks.slice(0, 3)) {
      lines.push(`• ${escapeHtml(risk)}`);
    }
    lines.push("");
  }
  lines.push(escapeHtml(job.apply_url));
  const buttons: InlineButton[][] = [
    [
      { text: "Shortlist", callbackData: `job:shortlist:${job.id}` },
      { text: "Skip", callbackData: `job:skip:${job.id}` },
    ],
    [
      { text: "Block company", callbackData: `job:block:${job.id}` },
      { text: "Back", callbackData: `job:back:${job.id}` },
    ],
  ];
  return { text: lines.join("\n"), buttons };
}

export function renderBlockConfirmation(
  jobId: string,
  company: string,
): {
  text: string;
  buttons: InlineButton[][];
} {
  return {
    text: `Block <b>${escapeHtml(company)}</b>? Future runs will filter out all roles from this company.`,
    buttons: [
      [
        { text: "Confirm block", callbackData: `job:blockconfirm:${jobId}` },
        { text: "Cancel", callbackData: `job:back:${jobId}` },
      ],
    ],
  };
}

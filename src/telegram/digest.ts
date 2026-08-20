import type { JobRow } from "../db/schema";
import type { ScoredJob } from "../jobs/scoring";
import { formatNyDate } from "../shared/time";
import type { InlineButton } from "./client";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderHelp(): string {
  return [
    "<b>job-maxxing</b>",
    "",
    "Open the bot, send a public resume URL (or PDF), set preferences, then get digests ~every 3 hours.",
    "",
    "/start — begin onboarding (or resume if paused)",
    "/saved — list saved jobs with apply links",
    "/skipped — list skipped jobs with apply links",
    "/status — onboarding / digest status",
    "/pause — halt job digests (profile is kept)",
    "/resume — turn digests back on",
    "/restart — rebuild profile from a new resume",
    "/help — show this message",
    "",
    "Save bookmarks a role. Prepare drafts answers — nothing is auto-submitted.",
  ].join("\n");
}

export function renderJobListSummary(status: "shortlisted" | "skipped", count: number): string {
  const label = status === "shortlisted" ? "Saved" : "Skipped";
  if (count === 0) return `<b>${label}</b>\n\nNone yet.`;
  return `<b>${label}</b> — ${count} job${count === 1 ? "" : "s"}`;
}

/** Compact one-message list of jobs with clickable apply links. */
export function renderJobLinkList(
  status: "shortlisted" | "skipped",
  jobs: ReadonlyArray<Pick<JobRow, "title" | "company" | "apply_url" | "location">>,
): string {
  const header = renderJobListSummary(status, jobs.length);
  if (jobs.length === 0) return header;
  const lines = [header, ""];
  for (const [index, job] of jobs.entries()) {
    const loc = job.location ? ` — ${escapeHtml(job.location)}` : "";
    lines.push(
      `${index + 1}. <a href="${escapeHtml(job.apply_url)}">${escapeHtml(job.title)}</a> @ ${escapeHtml(job.company)}${loc}`,
    );
  }
  return lines.join("\n").slice(0, 4000);
}

export function renderJobListItem(
  index: number,
  job: JobRow,
  score: number | null,
): {
  text: string;
  buttons: InlineButton[][];
} {
  const scoreLine = score === null ? "Match: n/a" : `Match: ${score}`;
  const text = [
    `<b>${index}. ${escapeHtml(job.title)} — ${escapeHtml(job.company)}</b>`,
    scoreLine,
    `Location: ${escapeHtml(job.location ?? "unknown")}`,
  ].join("\n");
  const buttons: InlineButton[][] = [
    [
      { text: "Review", callbackData: `job:review:${job.id}` },
      { text: "Prepare", callbackData: `job:prepare:${job.id}` },
      { text: "Open", url: job.apply_url },
    ],
  ];
  if (job.status === "shortlisted") {
    buttons.push([{ text: "Skip", callbackData: `job:skip:${job.id}` }]);
  } else if (job.status === "skipped") {
    buttons.push([{ text: "Save", callbackData: `job:shortlist:${job.id}` }]);
  }
  return { text, buttons };
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
    `<b>Job Search — ${formatNyDate(input.date)}</b>`,
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
    `<b>Job Search — ${formatNyDate(input.date)}</b>`,
    "",
    `Sources checked: ${input.sourcesChecked}`,
    `Jobs discovered: ${input.discoveredCount}`,
    `New jobs: ${input.newCount}`,
    "",
    "No strong matches this run.",
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
      { text: "Save", callbackData: `job:shortlist:${job.id}` },
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
    [{ text: "Prepare application", callbackData: `job:prepare:${job.id}` }],
    [
      { text: "Save", callbackData: `job:shortlist:${job.id}` },
      { text: "Skip", callbackData: `job:skip:${job.id}` },
    ],
    [
      { text: "Block company", callbackData: `job:block:${job.id}` },
      { text: "Back", callbackData: `job:back:${job.id}` },
    ],
  ];
  return { text: lines.join("\n"), buttons };
}

export function renderPreparationSummary(prepared: {
  jobTitle: string;
  company: string;
  jobId: string;
  applyUrl: string;
  resumeVariant: string;
  verifiedCount: number;
  reviewCount: number;
  unknownCount: number;
}): { text: string; buttons: InlineButton[][] } {
  const text = [
    `<b>Application prepared</b> — ${escapeHtml(prepared.jobTitle)} @ ${escapeHtml(prepared.company)}`,
    "",
    `Verified answers: ${prepared.verifiedCount}`,
    `Needs review: ${prepared.reviewCount}`,
    `Unanswered: ${prepared.unknownCount}`,
    `Resume variant: ${prepared.resumeVariant}`,
  ].join("\n");
  return {
    text,
    buttons: [
      [{ text: "Review answers", callbackData: `job:answers:${prepared.jobId}` }],
      [{ text: "Open application", url: prepared.applyUrl }],
      [{ text: "Cancel", callbackData: `job:back:${prepared.jobId}` }],
    ],
  };
}

export function renderAnswersReview(prepared: {
  jobId: string;
  answers: Array<{
    question: string;
    answer?: string;
    confidence: "verified" | "derived" | "unknown";
    requiresApproval: boolean;
  }>;
}): { text: string; buttons: InlineButton[][] } {
  const lines = ["<b>Prepared answers</b>", ""];
  for (const answer of prepared.answers) {
    const label =
      answer.confidence === "verified"
        ? "verified"
        : answer.confidence === "derived"
          ? "derived — review before use"
          : "unanswered";
    lines.push(`<b>${escapeHtml(answer.question)}</b>`);
    lines.push(`${label}${answer.requiresApproval ? " (approval required)" : ""}`);
    if (answer.answer) lines.push(escapeHtml(answer.answer));
    lines.push("");
  }
  return {
    text: lines.join("\n").slice(0, 4000),
    buttons: [[{ text: "Back", callbackData: `job:back:${prepared.jobId}` }]],
  };
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

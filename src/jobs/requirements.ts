/** Hard cap after extraction — requirements should never need a full posting. */
export const MAX_REQUIREMENTS_CHARS = 4_000;
const FALLBACK_CHARS = 2_000;
const SHORT_POSTING_CHARS = 1_500;

const KEEP_HEADING =
  /^(minimum |basic |preferred |required |key )?((qualifications|requirements|skills)|(must[- ]haves?|nice[- ]to[- ]haves?|bonus points)|what (we'?re|you.?re) looking for|who you are|about you|you (have|are|bring)|what you bring|the ideal candidate|who we'?re looking for|you'?ll need|we (need|require|ask)|candidate profile|what we need|your background|technical (skills|requirements)|must possess|experience required|education)\b/i;

const DROP_HEADING =
  /^(about (us|the (company|team|job|role|position))|who we are|what we do|what you'?ll do|responsibilities|the role|the (company|team|position)|benefits|perks|compensation|pay|our (values|mission|culture|benefits|team)|equal opportunity|eeo|diversity|inclusion|how to apply|interview process|life at|why (join|you'?ll love)|what we offer|company overview|about \w+|what you'?ll get|our story)\b/i;

const CONSTRAINT =
  /\b(\d{1,2}\s*\+?\s*(years?|yrs)|visa|sponsor|citizenship|citizen|clearance|work authorization|authorized to work|position has been filled|no longer (available|accepting)|job is closed|bachelor|master'?s|ph\.?d|degree required|must have|required to)\b/i;

const REQUIREMENT_LIKE =
  /\b(required|must|years?|yrs|experience|proficien|familiar|skill|degree|bachelor|master|python|typescript|javascript|golang|rust|java|kotlin|react|node\.?js|kubernetes|aws|gcp|azure|sql|visa|sponsor|citizen|clearance|authorization)\b/i;

const BOILERPLATE =
  /\b(equal opportunity|affirmative action|reasonable accommodation|we celebrate diversity|don'?t meet every|don't meet 100|401\s*\(?k\)?|unlimited pto|parental leave|stock options|life at \w+|we are an equal)\b/i;

const HEADING_SPLIT =
  /\b(Minimum Qualifications|Basic Qualifications|Preferred Qualifications|Preferred Skills|Must[- ]Haves?|Nice[- ]to[- ]Haves?|Requirements|Qualifications|Responsibilities|About Us|About the Company|About the Role|About the Team|Benefits|Perks|Compensation|Equal Opportunity|What You['’]?ll Do|What We['’]?re Looking For|Who You Are|Who We Are)\b/gi;

function classifyHeading(line: string): "keep" | "drop" | null {
  const trimmed = line.replace(/[:.\s]+$/g, "").trim();
  if (trimmed.length === 0 || trimmed.length > 80) return null;
  if (/[.!?]$/.test(line.trim()) && trimmed.length > 40) return null;
  if (KEEP_HEADING.test(trimmed)) return "keep";
  if (DROP_HEADING.test(trimmed)) return "drop";
  return null;
}

function injectSectionBreaks(text: string): string {
  const newlineCount = (text.match(/\n/g) ?? []).length;
  if (newlineCount >= 4) return text;
  return text.replace(HEADING_SPLIT, "\n$1\n");
}

function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  const sliced = text.slice(0, max);
  const lastBreak = Math.max(sliced.lastIndexOf("\n"), sliced.lastIndexOf(". "));
  return (lastBreak > max * 0.6 ? sliced.slice(0, lastBreak + 1) : sliced).trim();
}

/**
 * Keep the parts of a posting that filters and scoring actually use:
 * qualifications, skills, years, visa/citizenship, and similar constraints.
 * Drop company marketing, benefits, and EEO legal.
 */
export function extractJobRequirements(raw: string): string {
  const text = injectSectionBreaks(raw.replace(/\r\n/g, "\n").trim());
  if (!text) return "";

  const lines = text
    .split("\n")
    .map((line) => line.replace(/^[•*\-–—]\s+/, "- ").trim())
    .filter(Boolean);

  const kept: string[] = [];
  const fallback: string[] = [];
  let mode: "keep" | "drop" | "neutral" = "neutral";
  let sawKeepSection = false;

  for (const line of lines) {
    const heading = classifyHeading(line);
    if (heading) {
      mode = heading;
      if (heading === "keep") {
        sawKeepSection = true;
        kept.push(line.replace(/:$/, ""));
      }
      continue;
    }

    if (CONSTRAINT.test(line) && !BOILERPLATE.test(line)) {
      kept.push(line);
      continue;
    }

    if (mode === "keep") {
      if (!BOILERPLATE.test(line)) kept.push(line);
      continue;
    }
    if (mode === "drop") continue;

    if (BOILERPLATE.test(line)) continue;
    fallback.push(line);
  }

  if (sawKeepSection) {
    const unique = [...new Set(kept)];
    return cap(unique.join("\n"), MAX_REQUIREMENTS_CHARS);
  }

  const requirementish = fallback.filter(
    (line) =>
      line.startsWith("- ") ||
      /^\d+[.)]\s/.test(line) ||
      REQUIREMENT_LIKE.test(line) ||
      CONSTRAINT.test(line),
  );
  const body =
    requirementish.length > 0
      ? requirementish
      : text.length <= SHORT_POSTING_CHARS
        ? fallback
        : fallback.slice(0, 8);

  const merged = [...new Set([...kept, ...body])];
  if (merged.length === 0) return cap(text, FALLBACK_CHARS);
  return cap(merged.join("\n"), FALLBACK_CHARS);
}

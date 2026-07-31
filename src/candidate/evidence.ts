import type { CandidateProfile } from "./profile";

export interface MissingEvidenceReference {
  answerKey: string;
  evidenceId: string;
}

export function findMissingEvidenceReferences(
  profile: CandidateProfile,
): MissingEvidenceReference[] {
  const knownIds = new Set(profile.experience.evidence.map((entry) => entry.id));
  const missing: MissingEvidenceReference[] = [];
  for (const [answerKey, answer] of Object.entries(profile.answers)) {
    for (const evidenceId of answer.evidenceIds) {
      if (!knownIds.has(evidenceId)) {
        missing.push({ answerKey, evidenceId });
      }
    }
  }
  return missing;
}

export function getEvidenceById(profile: CandidateProfile, id: string) {
  return profile.experience.evidence.find((entry) => entry.id === id) ?? null;
}

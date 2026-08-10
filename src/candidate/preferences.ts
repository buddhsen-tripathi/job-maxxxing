import { z } from "zod";

export const SearchPreferencesSchema = z.object({
  titles: z.array(z.string()),
  excludedTitles: z.array(z.string()).default([]),
  locations: z.array(z.string()),
  remote: z.boolean(),
  hybrid: z.boolean(),
  onsite: z.boolean(),
  employmentTypes: z.array(z.enum(["full_time", "part_time", "contract", "internship"])),
  minimumSalary: z.number().optional(),
  excludedCompanies: z.array(z.string()).default([]),
  requiredKeywords: z.array(z.string()).default([]),
  excludedKeywords: z.array(z.string()).default([]),
  preferUsBased: z.boolean().default(true),
});

export type SearchPreferences = z.infer<typeof SearchPreferencesSchema>;

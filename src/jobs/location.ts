const US_PATTERN = /(united states|u\.s\.a?\.?\b|\busa\b|\bus\b)/i;

const US_STATE_PATTERN =
  /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/;

const NON_US_MARKERS = [
  "united kingdom",
  "london",
  "england",
  "uk",
  "germany",
  "berlin",
  "munich",
  "france",
  "paris",
  "india",
  "bangalore",
  "bengaluru",
  "hyderabad",
  "mumbai",
  "canada",
  "toronto",
  "vancouver",
  "montreal",
  "ontario",
  "australia",
  "sydney",
  "melbourne",
  "singapore",
  "japan",
  "tokyo",
  "netherlands",
  "amsterdam",
  "ireland",
  "dublin",
  "spain",
  "madrid",
  "barcelona",
  "poland",
  "warsaw",
  "brazil",
  "mexico",
  "israel",
  "tel aviv",
  "sweden",
  "stockholm",
  "switzerland",
  "zurich",
  "austria",
  "vienna",
  "emea",
  "apac",
  "europe",
];

export function isLikelyUsJob(input: {
  location?: string | null;
  workplaceType?: string | null;
}): boolean {
  const location = (input.location ?? "").trim().toLowerCase();
  if (!location) return true;
  if (US_PATTERN.test(location)) return true;
  if (US_STATE_PATTERN.test(location.toUpperCase())) return true;
  if (NON_US_MARKERS.some((marker) => location.includes(marker))) return false;
  return true;
}

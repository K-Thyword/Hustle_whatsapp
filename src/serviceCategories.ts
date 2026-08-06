// Maps a customer's freeform service-type text (e.g. "catering", "house
// cleaning", "movers") to a small config describing how to collect job
// details for that trade — instead of the same generic "describe the job"
// prompt for everything. Matching is a simple keyword lookup; unmatched
// service types fall back to the generic description prompt untouched, so
// this only ever adds detail, never removes the default path.
//
// Deletion test: if this file went away, every booking would collapse back
// to one generic description question — that's a real loss of collected
// detail for the trades listed here, so this earns its keep as its own
// module rather than being inlined into server.ts.

export interface ServiceCategoryConfig {
  // Human label, only used in comments/logs.
  label: string;
  // Keywords matched case-insensitively as substrings of what the customer
  // typed for "what kind of service do you need?".
  keywords: string[];
  // Asked one at a time, in order, in place of the generic description
  // question. Leave empty to skip straight past this (e.g. a category that
  // only needs the recurring/budget questions).
  followUpQuestions: string[];
  // Whether it's common for this kind of job to be a recurring need rather
  // than one-off — if true, we ask "one-time or regular?" before anything else.
  asksRecurring: boolean;
  // Whether this kind of job is normally priced with a quote (agent sources
  // an artisan, gets a price) rather than a fixed/known rate — if true, we
  // ask the customer for a rough budget so agents have a target to work with.
  likelyNeedsQuote: boolean;
}

// Keep this list modest and easy to extend — add a new entry any time a
// trade would clearly benefit from its own questions. Order matters only in
// that the first keyword match wins.
export const SERVICE_CATEGORIES: ServiceCategoryConfig[] = [
  {
    label: "Catering",
    keywords: ["cater", "chef", "cook for", "event food", "party food"],
    followUpQuestions: [
      "About how many people is this catering for?",
      "What kind of event is it (wedding, birthday, corporate, funeral, other)?",
    ],
    asksRecurring: false,
    likelyNeedsQuote: true,
  },
  {
    label: "Cleaning",
    keywords: ["clean", "cleaner", "housekeep", "housekeeping"],
    followUpQuestions: [
      "Roughly what size is the place (e.g. single room, 2-bedroom, whole office)?",
    ],
    asksRecurring: true,
    likelyNeedsQuote: false,
  },
  {
    label: "Moving",
    keywords: ["mov", "relocat", "haul"], // "mov" catches move/moving/movers
    followUpQuestions: [
      "What's the pickup location and the drop-off location?",
      "Roughly how much are we moving (e.g. a few boxes, a single room, a full house)?",
    ],
    asksRecurring: false,
    likelyNeedsQuote: true,
  },
  {
    label: "Gardening / landscaping",
    keywords: ["garden", "landscap", "lawn"],
    followUpQuestions: ["Roughly how big is the outdoor space we're working with?"],
    asksRecurring: true,
    likelyNeedsQuote: false,
  },
  {
    label: "Painting",
    keywords: ["paint"],
    followUpQuestions: ["Roughly how many rooms or what size is the area to be painted?"],
    asksRecurring: false,
    likelyNeedsQuote: true,
  },
  {
    label: "Tiling / flooring",
    keywords: ["til", "floor"],
    followUpQuestions: ["Roughly what area (in square feet or by room) needs tiling/flooring?"],
    asksRecurring: false,
    likelyNeedsQuote: true,
  },
  {
    label: "Renovation / construction",
    keywords: ["renovat", "construct", "mason", "build a", "extension", "fenc", "roof"],
    followUpQuestions: ["Can you describe the scope of the work — what's being built, fixed, or changed?"],
    asksRecurring: false,
    likelyNeedsQuote: true,
  },
  {
    label: "Event planning",
    keywords: ["event plan", "event decor", "party plan"],
    followUpQuestions: [
      "About how many guests are you expecting?",
      "What kind of event is it?",
    ],
    asksRecurring: false,
    likelyNeedsQuote: true,
  },
];

export function matchServiceCategory(serviceTypeText: string): ServiceCategoryConfig | undefined {
  const lower = serviceTypeText.toLowerCase();
  return SERVICE_CATEGORIES.find((category) => category.keywords.some((k) => lower.includes(k)));
}

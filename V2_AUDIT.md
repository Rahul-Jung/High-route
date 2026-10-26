# Redesign v2 — requirement audit

Every section of the v2 brief (the "Master Execution Prompt"), checked against
the code and against tests run in a real browser. Last run: 2026-10-26.

**Status key:** ✅ Complete · 🟡 Partly complete · ⛔ Blocked (needs something only
High Route can supply) · ↩ Deliberate deviation (owner's decision)

**Tests referred to below** — all in the session scratchpad, all run against the
real servers and database, all cleaning up after themselves:

| Suite | What it covers |
|---|---|
| **Part A** `uat-pages.js` | Every page × 375 / 390 / 768 / 1024 / 1440 px: loads, one `<h1>`, header/footer, no JS errors, no broken images, no dead links, labels, alt text, canonical, no horizontal overflow |
| **Part B** `uat-journeys.js` | What a visitor and a rider actually do: filters, finder, forms, checkout, dashboard, gallery, itinerary |
| **Part C** `uat-journeys.js` | Every admin tab, enquiries, CRM, bookings, the guide sign-in |
| `test-admin-ui.js`, `test-admin-dest.js`, `test-universal.js`, `regress.js` | Earlier suites, re-run |

---

## What this pass found missing, and fixed

| # | Brief § | Was | Now |
|---|---|---|---|
| 1 | 13, 25 | **Simulated payments.** Any well-formed card was "approved", and full card number + CVV were sent to our own server | Both pay endpoints refuse (503) before reading the body; no card form is rendered; customers are told how to pay. Demo switch: `ALLOW_SIMULATED_PAYMENTS=1`, off by default. See `backend/lib/payments.js` |
| 2 | 13 | Checkout said **"Booking confirmed / You're booked!"** above "no payment has been taken" | Says **"Place held"** — the booking's real status is *pending* |
| 3 | 13, 19 | **No enquiry form.** The only way to ask anything was Private Trips, which needs an account | Contact page form, no account needed: adventure, departure, travellers, phone, requirements, message. Stored, never auto-emailed. New admin **Enquiries** tab |
| 4 | 8.5 | Itinerary days had nowhere to put **description, accommodation, meals, notes** | Four optional fields, end to end: DB, API, admin day editor, trip page |
| 5 | 8.14 | Adventure page **had no final booking CTA** | Added: Check dates · Ask a question · Run it privately |
| 6 | 15 | **Region filter** supported by the API but never shown — one trip unreachable by any filter | "Other regions" filter group |
| 7 | 17 | When to Visit had **no activity or destination selection** | Both selectors, kept in the URL, carried into the listing |
| 8 | 10 | Destination pages **didn't connect to filtering** | "Filter Mustang adventures by…" hands over to the listing |
| 9 | 18 | Difficulty Guide named trips per level but **no filtered listing link** | "Compare all level-N adventures" |
| 10 | 22 | **Canonical URL** only on JS-rendered pages, and it kept every query parameter | On every page, keeping only parameters that change what the page is |

## Found by testing, and fixed

| Defect | Cause |
|---|---|
| **Rider dashboard never loaded** — no bookings, requests or profile | `shell.js` gave the first content block the id `main`, **overwriting** `#dash-gate`, so `main.js` got `null` and threw. Same on `#trip-gate` and `#detail-signin-gate`. Fixed in `shell.js`, and all 7 affected pages now have a real `<main>` |
| Adventure page **overflowed 339px on phones** and pushed the booking card **92px off-screen at 1024px** | `.detail-layout` used `1fr`, which cannot shrink below its content; the ten day-tabs forced it wide. Now `minmax(0, 1fr)` |
| **Private Trips could never be sent by a signed-in rider** | `riderToken()` read `highroute_token` / `hr_token`; the session is stored as `hr_rider_token`. The form always thought you were signed out |
| Contact form's adventure list **never loaded** | Requested `limit=200`; the API maximum is 100 |
| **`guide.html` shipped the demo guide's email and password pre-filled** on the live backend | Removed; fields labelled |
| **32 form fields with a label that wasn't tied to them** — the dashboard profile/password forms and the sign-in, pay and review modals | `<label for>` added. The dashboard ones only surfaced once the dashboard actually loaded |
| Departure picker and promo-code box **had no label** | Labels added |
| An unwritten destination page had **no `<h1>`** | Proper page header |
| Search results had a **one-line meta description** | Real description |

## Final test results

| Suite | Result |
|---|---|
| Part A — 27 pages (35 cases) × 5 widths = 175 renders | **35 / 35 clean** |
| Parts B + C — visitor, rider and admin journeys | **266 / 266** |
| `render.js` (pages render) | 26 / 26 |
| `check-design.js` (design pass) | 82 / 82 |
| `contrast-new.js` (colour contrast) | 50 / 50 |
| `test-universal.js` (adventure model) | 101 / 101 |
| `regress.js` (earlier regression) | 51 / 51 |
| `test-admin-ui.js` (admin panel) | 34 / 34 |
| `test-admin-dest.js` (destination editor) | 37 / 37 |

Real data verified unchanged after every run (7 tours, 44 itinerary days, 23
departures, 17 bookings, 8 custom requests, 8 proposals, 8 destinations) and
zero test rows left behind.

## Pages removed (pre-v2 leftovers)

Moved to `_archive/removed-pre-v2-pages-2026-10-26/` — out of the site, still
recoverable. What each one uniquely did was carried over first; details in that
folder's README.

| Removed | Replaced by |
|---|---|
| `build-adventure.html` | `private-trips.html` (now takes `?tour=` so requests stay "based on" a trip) |
| `cancellation-policy.html` | `booking-conditions.html#cancel-you` |
| `safety-policy.html` | `safety.html` — and its unverified guide-credential claims were **not** carried over |
| `tours.html` | `adventures.html` |

Dead JavaScript for those pages (≈ 270 lines) and dead CSS were removed too.

---

## Requirement by requirement

### 2. Brand and visual design

| Requirement | Where | Status | Verification |
|---|---|---|---|
| Colours #1F3A32 / #F5F1E8 / #D86432 / #222522 | `style.css` tokens | ✅ | Token check; contrast suites (70 pairs) |
| 70 / 20 / 10 balance, orange for actions only | `style.css` | ✅ | Visual review |
| No per-activity rainbow palette | `style.css` | ✅ | Activities differ by label and photo only |
| Design tokens (colour, type, spacing, radius, shadow) | `:root` in `style.css` | ✅ | — |
| **Max two font families** | `--f-display` DM Sans, `--f-body` Inter, `--f-mono` IBM Plex Mono | ↩ | Three families at the owner's request (the mono label face was asked back) |
| Readable type on mobile | `style.css` | ✅ | Part A at 375/390 |
| No unrelated stock photography; no fake guides or customers | images | 🟡 | Images are licensed stock attributed to the trip/region they show; no guide or customer photos are invented. Real High Route photography would be better |

### 3. Information architecture

| Requirement | Where | Status | Verification |
|---|---|---|---|
| Nav: Adventures · Destinations · Plan Your Trip · About · Find an Adventure | `shell.js` | ✅ | Part B *navDesktop* |
| No difficulty/duration/style/season in nav | `shell.js` | ✅ | Part B *navDesktop* |
| Adventures: All, MTB, Trekking, Multi-Activity, more later | `adventures.html?activity=` | ✅ | Part A |
| Destinations: Mustang, Annapurna, Everest, Pokhara, Kathmandu | `destination.html?d=` | ✅ | Part A |
| Plan Your Trip: Finder, Private Trips, When to Visit, Difficulty Guide, FAQs | pages exist | ✅ | Part A |
| About: Story, Guides, Safety, Impact, Responsible Travel | pages exist | ✅ | Part A |
| Contact, Search, Booking Conditions, Privacy, Cookies, Accessibility | pages exist | ✅ | Part A |
| No links to empty or placeholder pages | all pages | ✅ | Part A: every internal link resolves; zero `href="#"` |

### 4. Universal adventure data model

| Requirement | Where | Status | Verification |
|---|---|---|---|
| One model for every activity | `tours` + `lib/adventures.js` | ✅ | `test-universal.js` |
| All universal fields | migration 001 | ✅ | `test-universal.js` |
| MTB / trekking / rafting specific fields | `ACTIVITY_FIELDS` | ✅ | `test-universal.js`, `test-admin-ui.js` |
| New activities without re-architecting | `activity_types` table | ✅ | Rafting, trail running defined and switchable |
| No bike fields on trekking pages | conditional rendering | ✅ | `test-admin-ui.js` |

### 5. Homepage

| Requirement | Status | Verification |
|---|---|---|
| Hero with both paths | ✅ | Part B *home* |
| Compact four-question finder | ✅ | Part B *home* (options match the brief exactly) |
| Featured adventures, linked | ✅ | Part B *home* |
| Why High Route (four points) | ✅ | Part B *home* |
| Explore by destination, linked | ✅ | Part B *home* |
| Adventure that gives back (three themes) | ✅ | Part B *home* |
| Traveller stories — real only, empty state otherwise | ✅ | Reviews come from the database only |
| Final planning CTA | ✅ | Part A |

### 6. Adventure Finder

| Requirement | Status | Verification |
|---|---|---|
| Four questions with the brief's options | ✅ | Part B *home*, *finder* |
| Anonymous; no email needed | ✅ | Part B *finder* |
| Answers become real filters; results shown | ✅ | Part B *finder* |
| Modify, clear, empty states, survives Back | ✅ | Part B *finder* |
| Optional save by email — no fake sending | ✅ | Part B *finder* (says it is stored, not sent) |

### 7. Difficulty framework

| Requirement | Status | Verification |
|---|---|---|
| Five universal levels | ✅ | Part B *difficulty* |
| Reusable component: level, meaning, requirements | ✅ | Part B *detail* |
| MTB fitness / technical / altitude | ✅ | `test-universal.js` |
| Trekking dimensions | 🟡 | Fitness / terrain / altitude. The brief lists walking hours and daily ascent "such as"; those are recorded as trekking fields and shown at a glance, not as scored dimensions |
| Rafting rapid grade / swimming / physical | ✅ | Defined; rafting is switched off until trips exist |

### 8. Adventure detail page

| Section | Status | Verification |
|---|---|---|
| 8.1 Hero | ✅ | Part A |
| 8.2 At a glance (only relevant fields) | ✅ | Part B *detail* |
| 8.3 Why you'll love it | ✅ | Part A |
| 8.4 Is this trip for me? | ✅ | Part A |
| 8.5 Day-by-day itinerary with all listed fields | ✅ | Part B *detail*, *detailDayExtras* (new fields end to end) |
| 8.6 Route map and elevation profile | 🟡 | Elevation profile ✅. The route **map** was taken off at the owner's request in an earlier session; route data is still recorded |
| 8.7 Accommodation — no invented names | ✅ | Part A |
| 8.8 Included / excluded / mandatory / optional | ✅ | Part B *detail* |
| 8.9 Before you book | ✅ | Part B *detail* |
| 8.10 Dates, availability, price, deposit | ✅ | Real data only; deposit is a flagged 20% placeholder ⛔ |
| 8.11 Guides — no invented credentials | ✅ | Part A |
| 8.12 Reviews — real or empty state | ✅ | Part A |
| 8.13 FAQs (expandable) | ✅ | Part B *detail*, *faqs* |
| 8.14 Final booking CTA | ✅ | Part B *detail* (added this pass) |

### 9. Adventure card

| Requirement | Status | Verification |
|---|---|---|
| Name, activity, destination, duration, difficulty, season, price | ✅ | Part B *home* |
| Relevant extras; spaces only from real data | ✅ | Part A |
| Consistent size across activities | ✅ | Part B *home* (image heights equal) |

### 10. Destination pages

| Requirement | Status | Verification |
|---|---|---|
| Reusable template, five destinations | ✅ | Part A |
| Hero, intro, activities, featured trips, best time, practical, related, FAQs, CTA | ✅ | Part B *destination* |
| Uses the universal model | ✅ | Trips come from `/api/destinations/:slug` |
| Works with the filtering system | ✅ | Part B *destination* (added this pass) |
| No invented facts | ✅ | Permit fees, prices and named lodges deliberately absent |

### 11. Sustainability and impact

| Requirement | Status | Verification |
|---|---|---|
| Impact on every adventure | ✅ | Part A |
| Our Impact page, all sections | ✅ | Part A |
| Annual progress, evidenced figures only | ✅ | API refuses an evidenced metric without a value |
| Operational measurement fields (incl. plastic) | ✅ | `impact_records` |
| Real figures | ⛔ | None supplied yet — shown as gaps, not invented |

### 12. Trust and safety

| Requirement | Status | Verification |
|---|---|---|
| Safety page and reusable safety components | ✅ | Part B *safety* |
| Clear booking conditions | ✅ | Part B *bookingConditions* |
| Nothing invented (certifications, insurance, evacuation, guarantees) | ✅ | Part B *safety*; the old safety-policy page's claims were removed |
| Insurance, emergency contact, evacuation, registration | ⛔ | Structure exists; content must come from High Route |

### 13. Booking and enquiry

| Requirement | Status | Verification |
|---|---|---|
| Browse → filter → open → review → departures → price → submit | ✅ | Part B *adventures*, *detail*, *checkout* |
| Enquiry form with the listed fields | ✅ | Part B *contactEmpty*, *contactSend* (added this pass) |
| Validation, loading/success/error, no duplicates | ✅ | Part B *contactSend*, *checkout* |
| No fake confirmations | ✅ | Part B *checkout*, *trip* ("Place held") |
| Payments: interface + boundary, no simulation | ⛔ | Boundary ✅ (Part B *dashboard*, *customCheckout*, API 503). A real provider is needed to take money |

### 14. Private trips

| Requirement | Status | Verification |
|---|---|---|
| Dedicated page, all listed fields, validated | ✅ | Part B *privateAnon*, *privateTour* |
| Honest when sign-in is needed | ✅ | Part B *privateAnon* |
| Based-on-a-trip requests | ✅ | Part B *privateTour*, Part C *crmBookings* |

### 15. Search and filtering

| Requirement | Status | Verification |
|---|---|---|
| Activity, destination, region, duration, difficulty, season, format, accommodation, price | ✅ | Part B *adventures* (region added this pass) |
| Sort: featured, price, duration, difficulty | ✅ | Part B *adventures* |
| Clear, chips, counts, empty states, URL state, mobile | ✅ | Part B *adventures*, *adventuresMobile* |

### 16–19. Guides, When to Visit, Difficulty Guide, FAQs, Contact, legal

| Requirement | Status | Verification |
|---|---|---|
| Guides page; real information only | ✅ | Part A |
| When to Visit: months, activities, destinations, recommendations | ✅ | Part B *whenToVisit* (selectors added this pass) |
| Difficulty Guide with links to matching adventures | ✅ | Part B *difficulty* |
| FAQs | ✅ | Part B *faqs* |
| Contact with methods **and** an enquiry form | ✅ | Part B *contactSend* (form added this pass) |
| Legal pages flagged as not professionally reviewed | ✅ | Part A |
| No fake cookie consent | ✅ | No banner, because nothing non-essential is stored |

### 20. Principles

| Requirement | Status | Verification |
|---|---|---|
| Mobile-first; 375 → 1440 | ✅ | Part A, all pages × 5 widths |
| Performance: lazy images, hero not lazy, no dependencies | 🟡 | ✅ for images and JS. Fonts load from Google, not self-hosted |
| One primary CTA per section | ✅ | — |
| Progressive disclosure | ✅ | Itinerary tabs, accordions |
| Reusable components | ✅ | One card, one destination card, one difficulty block, one accordion |
| Accessibility (WCAG 2.2 AA aim) | ✅ | Part A: labels, alt, landmarks, one h1; 70 contrast pairs measured |
| Single source of truth | ✅ | Prices, dates and facts come only from the API |
| Honest data | ✅ | Payments fixed this pass |

### 21–22. Code quality and SEO

| Requirement | Status | Verification |
|---|---|---|
| No dead code, broken routes, fake responses | ✅ | 4 pages, ~270 lines of dead JS and dead CSS removed this pass |
| Build / type-check / lint | — | No build step exists (plain HTML/JS/CSS by design); every file is syntax-checked |
| Titles, descriptions, canonical, Open Graph, structured data (real only) | ✅ | Part A (canonical added everywhere this pass) |

### 23. Priorities

| Priority | Status |
|---|---|
| P0 — model, homepage, nav, template, difficulty, pricing, inclusions, pre-booking | ✅ |
| P1 — finder, impact, measurement, guides, safety, real proof | ✅ (content ⛔ where it needs business data) |
| P2 — route maps, elevation, saved recommendations, trekking, more activities | 🟡 Route map removed at owner's request; the rest ✅ |

---

## What still needs High Route (not code)

1. **A payment provider** (e.g. Stripe) to take money online. Until then, payments are recorded by an admin when they arrive.
2. **Business facts:** company registration and address, 24-hour emergency contact, evacuation procedure per region, guide medical qualifications, liability insurance, confirmed deposit amounts.
3. **Real impact figures** for the Our Impact page.
4. **Outbound email**, so enquiries, finder saves and newsletter signups can be answered automatically.
5. **Corrections to five trips' own figures** (listed in PROJECT_GUIDE.md).

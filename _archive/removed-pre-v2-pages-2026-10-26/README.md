# Removed pre-v2 pages

Moved out of `frontend/` on 2026-10-26. They are no longer served, linked or
loaded by anything. Kept here only because the project is not under git, so
this folder is the only way to get one back.

| Page | Replaced by | What was carried over first |
|---|---|---|
| `build-adventure.html` | `private-trips.html` | The one thing only it did: sending a `tourId` so a request made from a full or request-only departure lands in the CRM "based on" that tour. Private Trips now takes `?tour=<slug>`. Its JS block was removed from `main.js`. |
| `cancellation-policy.html` | `booking-conditions.html#cancel-you` | The 72-hour payment hold, refunds staying *pending* until money is actually sent, self-cancel from the dashboard, paying the balance, and trip-specific non-refundable costs. |
| `safety-policy.html` | `safety.html` | Only the honest caveats: route maps are approximate, the GPS tracker is a demo, and how equipment lists work. **Not** carried over: its claims that every departure has "a wilderness-trained lead guide" and "a satellite communicator", and that guides are "trained to coordinate evacuation". None of that has been verified, the brief forbids stating it, and `safety.html` lists those exact items under "What is not documented yet". |
| `tours.html` | `adventures.html` | It was already only a redirect. Every link to it was repointed. Its JS block (`#tour-grid`) was removed from `main.js`. |

Safe to delete this folder once you are sure none of these are wanted back.

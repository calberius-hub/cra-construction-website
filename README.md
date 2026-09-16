# CRA Construction Website

Project workspace for designing and building the public CRA Construction website.

## Working project name

**CRA Construction Website**

Suggested repo/site slug:

`cra-construction-website`

## Purpose

Create a polished, credible, high-converting website for CRA Construction that supports the business across:

- custom homes
- spec homes
- residential developments
- light commercial construction
- site work / infrastructure improvements
- long-term real estate development credibility

## Primary goal

Turn visitors into qualified conversations with CRA by making the company feel:

- trusted
- capable
- established
- premium but practical
- local to Arkansas
- experienced across construction and development

## Design workflow

We will run this as a design-first project:

1. Define brand/audience/CTA.
2. Create three visual directions.
3. Review and pick a direction.
4. Build a high-fidelity website prototype.
5. Implement the production website.
6. Deploy through GitHub/Netlify when ready.

## Primary reference

Cole wants the site modeled after https://pikeproperties.com as a luxury builder reference.

Important scope exclusions:

- No blog
- No foundation section
- No house plans / home plans section

## Default visual directions

### 1. Trusted Arkansas Builder

Clean, local, credible, easy to navigate, strong contact CTA.

### 2. Premium Custom Homes + Development

More refined, architectural, higher-end, strong photography and typography.

### 3. Construction Operator / Infrastructure Capability

Bold, capable, execution-focused, useful for commercial/sitework/development credibility.

## Initial page map

- Home
- About CRA
- Custom Homes
- Developments / Communities
- Light Commercial / Site Work
- Portfolio
- Contact / Start a Project

## Notes

This folder is intentionally a clean project workspace. We should not create production code until the design direction is chosen.

---

## Bid Board (`/bids`)

Getting a plan set out to everybody who needs to bid it, and then knowing where
each trade stands, without a spreadsheet or twenty hand-written emails.

### The flow

1. **New project** — name, address, job type, bid due date, walk-through, scope notes.
2. **Drop the plan PDF on the page.** The text is pulled out of it *in the browser*
   (pdf.js), so a 200 MB set never has to move. Only the text goes to the server.
   Scanned plans with no text layer still work — the read falls back to what the
   job type needs. You can also paste the sheet index by hand.
3. **Read the plans** — the sheet index and notes are matched against CRA's bid
   packages, and each suggestion says why it's there ("Plans mention *panel
   schedule*" vs. "Standard package for this job type"). With `ANTHROPIC_API_KEY`
   set, Claude reads the set instead and writes the scope line for each package;
   if that call fails or runs long, the keyword read takes over and the dashboard
   says so.
4. **Check the packages**, set how each one is priced, and fix any scope line.
   That line is what the sub sees.
5. **Who gets it** — the sub library fills itself in per package, best-rated
   first, anyone marked *do-not-use* left out.
6. **Review the blast** — the exact recipient list and the exact email, then send.
   Nothing goes out on one click. Optional SMS goes only to subs who checked the
   consent box on the `/bid` intake form.
7. **The board** — coverage per package (`nobody on it` → `waiting` → `one bid
   only` → `covered`), who opened, who's bidding, who passed, every number in,
   and the low bid. Record a number that came in by phone, nudge the quiet ones,
   award the package.

### How a package is priced

Every package carries a basis — lump sum, per sf, per roofing square, per lf, per
cy, per each, per hour — and, when it isn't lump sum, the takeoff quantity off the
plans. Both ride in the invitation ("Per square foot · 2,850 sf on the plans"), so
the numbers come back on the same basis instead of four subs each pricing it their
own way, and the board shows a $/unit next to every bid. Each package starts on the
basis that trade is normally bid on around here; change it per job.

Leave the quantity blank when you don't have the takeoff yet — a rate is only shown
where there's a real number behind it, and the plan read is told to return nothing
rather than guess one. That's also what makes bids comparable **across** jobs, which
is the foundation of any estimating history worth keeping.

Each sub gets their own link (`/bid-invite?t=…`) with one-tap **bidding / send my
number / pass**. Bids and passes fire a Telegram alert. Opens are tracked with a
pixel, which is the difference between "he's ignoring me" and "it went to spam".

### Plans live on a link, not an upload

Netlify functions cap out at 6 MB a request, which a real plan set blows past on
sheet three. So the set stays in Dropbox / Drive / Box and the board emails that
share link. Make sure the link is open to anyone with it before you blast.

### Environment variables

| Variable | Needed for |
|---|---|
| `NETLIFY_SITE_ID`, `NETLIFY_API_TOKEN` | required — Blobs storage |
| `BIDS_DASHBOARD_KEY` | the `/bids` password; falls back to `SUBS_DASHBOARD_KEY`, then `LEADS_DASHBOARD_KEY` |
| `RESEND_API_KEY`, `RESEND_FROM` | sending invitations. Without it the board runs but can't send |
| `SITE_URL` | the domain the subs' links point at (defaults to `https://cra-construction.com`) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | optional SMS nudge |
| `ANTHROPIC_API_KEY` | optional — Claude reads the plans and writes the scope lines |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | optional — alert when a bid lands |

### Checking it without a deploy

```
node scripts/bid-board-test.js
```

Runs the whole flow against an in-memory blob store with Resend and the Claude
SDK mocked — no key needed, and no real subcontractor gets a real email.

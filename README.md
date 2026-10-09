# EventPass

Tickets that can't be screenshotted.

Rolling Smart Passes. Live capacity locks. Pricing that reads demand.

## Run locally

Requires Node.js 22 or newer (uses built-in SQLite).

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). The first start creates and seeds `data/eventpass.db`.
Existing databases are upgraded automatically; to start clean run `npm run seed`, then start again.

The QR generator and camera scanner load from a CDN (`qrcode`, `html5-qrcode`). For a venue with unreliable wifi,
download both files into `public/vendor/` and point the two `<script>` tags in `public/index.html` at them.
The camera needs HTTPS or `localhost`.

## Demo accounts

Password for all seeded accounts: `EventPass@2026`

| Role | Email |
| --- | --- |
| Customer | `ananya.sharma@eventpass.in` |
| Organizer | `priya.mehta@eventpass.in` (pick the **Organizer** tab when signing in) |

## The features

### 1. Rolling Smart Pass (anti-screenshot)

* Every confirmed ticket gets a QR that is re-issued every **15 seconds**. A screenshot is useless once its window passes.
* The QR carries the **buyer's name, ticket ID, booking ID, event and tier**, signed with a per-ticket secret (HMAC-SHA256).
  Changing any field invalidates the signature. Email and phone are *not* in the QR; the organizer's scanner shows them
  after the server has verified the pass.
* The scanner tells apart a **forged** QR ("Invalid QR") from a **genuine but stale** one ("Expired pass: likely a screenshot").
  Re-using a live QR in the same window gives "Already used". A 2-second grace covers a scan that straddles a refresh
  (`EVENTPASS_QR_GRACE_MS`, set `0` to be strict).
* **Download pass** produces a PNG with the buyer's details and a *static verification QR*. It proves who bought the ticket
  but is never accepted for entry; the scanner answers "Identity confirmed, not valid for entry".
* Organizer event page shows **entry attempts blocked** at the door.

Test the token logic offline: `npm run test:qr`.

### 2. Live capacity locks

* Choosing tickets reserves them for **5 minutes** (`EVENTPASS_LOCK_MS` to change). A live countdown shows on the event page,
  checkout, and as a banner on every other page.
* Reservation and payment run inside `BEGIN IMMEDIATE` transactions, and inventory is checked against sold + live holds.
  The price is frozen when the seats are held.
* Unpaid holds expire and return to the pool automatically.

Prove it with a stampede (server must be running):

```bash
npm run stress                      # 1,000 users, 10 tickets
EVENTPASS_LOCK_MS=8000 npm start    # (other terminal) short locks, also shows expiry returning seats
```

### 3. Smart Pricing and demand heatmap (organizer dashboard)

* Per tier: pace over the last 6h/24h vs. time to the event gives a named suggestion
  (**Surge pricing**, Demand-led increase, Small step-up, **Close Early Bird**, Flash promo, Last-minute promo, or Hold).
  Thin data or a far-off event produces "Hold" with the reason, not a guess.
* Revenue projection chart: actual, "if prices hold", and "with suggestions". The elasticity assumption is stated in the UI.
* Heatmap of tickets per hour by tier for the last 24 hours, with the peak booking hour.
* **Apply** a suggestion (or all) with one tap. Changes are bounded (+25% / -15% per step), logged, and cool down for 24h.
  They affect future reservations only.
* This is a transparent statistical model on your own booking data. It does not call an external AI service.

Make the dashboard react live during a demo:

```bash
npm run demo:traffic -- --event TechFest --tier "General Admission" --tickets 40
```

## Judge flow (about 90 seconds)

1. Sign in as Priya (Organizer tab). The dashboard opens on the hottest event with a Surge suggestion, projection and heatmap.
2. Sign out, sign in as Ananya. Open **Stand-Up Comedy Night**, pick tickets. The lock countdown starts. Pay.
3. Open **Smart Pass**: live QR, "New code in Xs". **Download pass** to see the verification copy.
4. Organizer, **Check-in**: paste the live payload. Buyer details appear. Scan again: Already used.
5. Take a payload, wait 15s, scan it: **Expired pass**. That is the screenshot failing.

## Stack

* Express API, httpOnly session cookie
* SQLite (`node:sqlite`) with `BEGIN IMMEDIATE` for locks, checkout and check-in
* HMAC time-window QR tokens, verified only on the server
* Plain JS front end (`public/js`: `app.js`, `pass.js`, `organizer.js`, `scanner.js`)

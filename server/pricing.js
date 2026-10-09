/**
 * Smart Pricing: a transparent demand model that runs on this platform's own
 * booking data. It is statistics, not a hosted AI model, and the UI says so.
 *
 * Per tier it asks one question: "at the pace this tier is selling right now,
 * when does it run out, compared with how long is left?"
 *
 *   coverage = (hours until the tier sells out) / (hours until the event)
 *
 *   coverage < 1   sells out before the event  -> raise price
 *   coverage > 1   inventory outlasts the event -> hold, or discount if far off
 *
 * Revenue projections include a price-elasticity assumption (below) so the
 * "apply suggestions" scenario is not assumed to sell as many tickets as the
 * "hold" scenario. The assumption is shown to the organizer, not hidden.
 */

const HOUR = 3_600_000;
const ELASTICITY = 0.8;          // 10% price rise -> ~8% fewer future sales
const MAX_UP = 0.25;
const MAX_DOWN = 0.15;
const COOLDOWN_HOURS = 24;       // don't re-recommend right after a price change
const HISTORY_HOURS = 72;
const HEAT_HOURS = 24;
const IST_OFFSET = 5.5 * HOUR;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const utc = (sqlTs) => new Date(String(sqlTs).replace(' ', 'T') + 'Z').getTime();
const rupees = (paise) => '₹' + Math.round(paise / 100).toLocaleString('en-IN');

function demandBand(score) {
  if (score >= 0.65) return { key: 'very_high', label: 'Very high' };
  if (score >= 0.45) return { key: 'high', label: 'High' };
  if (score >= 0.25) return { key: 'normal', label: 'Normal' };
  return { key: 'low', label: 'Low' };
}

function roundRupees(rupeeValue) {
  return Math.round(rupeeValue / 10) * 10;
}

function eventStartMs(event) {
  return new Date(`${event.date}T${event.time}:00+05:30`).getTime();
}

function confidenceFor(samples) {
  if (samples >= 10) return 'high';
  if (samples >= 3) return 'medium';
  return 'low';
}

/**
 * @param event   events row
 * @param types   ticket_types rows (id, name, price_paise, capacity, sold)
 * @param sales   [{ created_at, ticket_type_id, quantity, unit_price_paise }] for confirmed bookings
 * @param opts    { now, lastChangeByType: { [ticketTypeId]: epochMs } }
 */
function insightsForEvent(event, types, sales, opts = {}) {
  const now = opts.now ?? Date.now();
  const lastChange = opts.lastChangeByType || {};
  const startMs = eventStartMs(event);
  const ended = startMs <= now;
  const hoursLeft = Math.max((startMs - now) / HOUR, 0.5);

  const rows = sales.map((s) => ({ ...s, at: utc(s.created_at) }));
  const qtyWithin = (list, ms) => list.reduce((n, s) => (now - s.at <= ms ? n + s.quantity : n), 0);

  const capacity = types.reduce((n, t) => n + t.capacity, 0);
  const sold = types.reduce((n, t) => n + t.sold, 0);
  const remaining = Math.max(capacity - sold, 0);
  const utilization = capacity ? sold / capacity : 0;
  const currentRevenue = rows.reduce((n, s) => n + s.quantity * s.unit_price_paise, 0);

  // ---- per-tier recommendations ------------------------------------------
  const tiers = types.map((t) => {
    const mine = rows.filter((s) => s.ticket_type_id === t.id);
    const q6 = qtyWithin(mine, 6 * HOUR);
    const q24 = qtyWithin(mine, 24 * HOUR);
    const rate = 0.6 * (q6 / 6) + 0.4 * (q24 / 24);                  // tickets / hour
    const left = Math.max(t.capacity - t.sold, 0);
    const util = t.capacity ? t.sold / t.capacity : 0;
    const eta = rate > 0 ? left / rate : Infinity;                   // hours to sell out
    const coverage = left === 0 ? 0 : eta / hoursLeft;
    const current = Math.round(t.price_paise / 100);
    const early = /early/i.test(t.name);

    const projectedFill = t.capacity ? clamp((t.sold + rate * hoursLeft) / t.capacity, 0, 1) : 0;
    const enoughData = q24 >= 3;

    let action = 'hold';
    let strategy = 'Hold price';
    let pct = 0;
    let headline = enoughData ? 'On track' : 'Not enough data yet';
    let reason = enoughData
      ? `On the current pace about ${Math.round(projectedFill * 100)}% of this tier will be sold by the event.`
      : (q24 === 0 ? 'No sales in the last 24 hours, so there is no trend to read yet.' : `Only ${q24} ticket${q24 === 1 ? '' : 's'} sold in the last 24 hours, too few to read a trend.`);

    const changedAgo = lastChange[t.id] ? (now - lastChange[t.id]) / HOUR : Infinity;

    if (ended) {
      headline = 'Event has started'; reason = 'Pricing is no longer actionable.';
    } else if (left === 0) {
      action = 'sold_out'; strategy = 'Sold out'; headline = 'Sold out';
      reason = 'No inventory left in this tier.';
    } else if (changedAgo < COOLDOWN_HOURS) {
      strategy = 'Cooling down'; headline = 'Price changed recently';
      reason = `Changed ${changedAgo < 1 ? 'less than an hour' : Math.round(changedAgo) + 'h'} ago. Give demand ${COOLDOWN_HOURS}h to respond before changing again.`;
    } else if (early && util >= 0.75) {
      action = 'close_early_bird'; strategy = 'Close Early Bird'; headline = 'Early Bird is nearly gone';
      reason = `${Math.round(util * 100)}% sold. Retire this tier so General Admission carries the next wave at its normal price.`;
    } else if (enoughData && coverage < 0.25 && util >= 0.3) {
      action = 'raise'; strategy = 'Surge pricing'; pct = 0.20; headline = 'Selling out fast';
      reason = `At the current pace this tier sells out in about ${fmtHours(eta)}, with ${fmtHours(hoursLeft)} to go.`;
    } else if (enoughData && coverage < 0.6) {
      action = 'raise'; strategy = 'Demand-led increase'; pct = 0.12; headline = 'Demand is ahead of schedule';
      reason = `Projected to sell out in ${fmtHours(eta)} versus ${fmtHours(hoursLeft)} until the event.`;
    } else if (enoughData && coverage < 1) {
      action = 'raise'; strategy = 'Small step-up'; pct = 0.06; headline = 'Slightly ahead of pace';
      reason = 'Likely to sell out just before the event. A small increase captures the late rush.';
    } else if (hoursLeft < 72 && coverage > 1.5 && util < 0.7) {
      action = 'lower'; strategy = 'Last-minute promo'; pct = -0.10; headline = 'Unsold seats, little time left';
      reason = `${left} seats remain with under ${fmtHours(hoursLeft)} to go. A short promo is better than empty seats.`;
    } else if (hoursLeft > 72 && hoursLeft <= 14 * 24 && projectedFill < 0.25 && !early) {
      action = 'lower'; strategy = 'Flash promo'; pct = -0.10; headline = 'On pace to leave seats empty';
      reason = `Only about ${Math.round(projectedFill * 100)}% of this tier is on track to sell with ${fmtHours(hoursLeft)} left. A time-boxed promo can restart momentum.`;
    } else if (!early && hoursLeft > 14 * 24 && projectedFill < 0.25 && enoughData) {
      headline = 'Early days';
      reason = `${fmtHours(hoursLeft)} to go. Sales usually pick up close to the date, so a discount now would likely give margin away.`;
    }

    let suggested = current;
    if (pct !== 0 && current > 0) {
      suggested = roundRupees(current * (1 + clamp(pct, -MAX_DOWN, MAX_UP)));
      if (suggested === current || suggested < 1) suggested = current;
    }
    if (suggested === current && (action === 'raise' || action === 'lower')) action = 'hold';

    const factor = current > 0 ? clamp(1 - ELASTICITY * (suggested / current - 1), 0.4, 1.4) : 1;
    const demandUnits = rate * hoursLeft;                 // buyers expected at the current price
    const holdUnits = Math.min(left, demandUnits);
    const sugUnits = Math.min(left, demandUnits * factor); // fewer buyers at the new price, still capped by stock

    return {
      ticketTypeId: t.id,
      name: t.name,
      action, strategy, headline, reason,
      confidence: confidenceFor(q24),
      currentPaise: t.price_paise,
      currentLabel: rupees(t.price_paise),
      suggestedPaise: suggested * 100,
      suggestedLabel: rupees(suggested * 100),
      changePct: current ? Math.round((suggested / current - 1) * 100) : 0,
      sold: t.sold, capacity: t.capacity, remaining: left,
      utilization: util,
      ratePerHour: Number(rate.toFixed(3)),
      sellOutEtaHours: Number.isFinite(eta) ? Number(eta.toFixed(1)) : null,
      soldLast24h: q24,
      _holdUnits: holdUnits, _sugUnits: sugUnits, _rate: rate, _factor: factor, _left: left,
    };
  });

  // ---- event-level pace & demand -----------------------------------------
  const q6All = qtyWithin(rows, 6 * HOUR);
  const q24All = qtyWithin(rows, 24 * HOUR);
  const rateAll = 0.6 * (q6All / 6) + 0.4 * (q24All / 24);
  const etaAll = rateAll > 0 ? remaining / rateAll : Infinity;
  const coverageAll = remaining === 0 ? 0 : etaAll / hoursLeft;
  const paceScore = remaining === 0 ? 1 : Number.isFinite(coverageAll) ? 1 / (1 + coverageAll) : 0;
  const demandScore = ended ? 0 : clamp(0.6 * paceScore + 0.4 * clamp(utilization * 1.2, 0, 1), 0, 1);
  const demand = demandBand(demandScore);

  // ---- revenue forecast ---------------------------------------------------
  const holdAdd = tiers.reduce((n, t) => n + t._holdUnits * t.currentPaise, 0);
  const sugAdd = tiers.reduce((n, t) => n + t._sugUnits * t.suggestedPaise, 0);
  const projectedHold = Math.round(currentRevenue + holdAdd);
  const projectedSuggested = Math.round(currentRevenue + sugAdd);

  // history (actual cumulative revenue, hourly) then projection to the event
  const winStart = now - HISTORY_HOURS * HOUR;
  const before = rows.filter((s) => s.at < winStart).reduce((n, s) => n + s.quantity * s.unit_price_paise, 0);
  const history = [];
  let run = before;
  for (let h = -HISTORY_HOURS + 1; h <= 0; h += 1) {
    const hi = now + h * HOUR;
    const lo = hi - HOUR;
    run += rows.filter((s) => s.at > lo && s.at <= hi).reduce((n, s) => n + s.quantity * s.unit_price_paise, 0);
    history.push({ h, v: run });
  }
  history[history.length - 1].v = currentRevenue; // anchor exactly to actual
  const horizon = ended ? 0 : Math.min(hoursLeft, 14 * 24);
  const steps = horizon ? Math.min(28, Math.max(4, Math.round(horizon / 6))) : 0;
  const hold = [];
  const suggestedLine = [];
  for (let i = 0; i <= steps; i += 1) {
    const h = steps ? (horizon * i) / steps : 0;
    const add = (key, price) => tiers.reduce((n, t) => n + Math.min(t._left, t._rate * h * (key === 'sug' ? t._factor : 1)) * price(t), 0);
    hold.push({ h: Number(h.toFixed(1)), v: Math.round(currentRevenue + add('hold', (t) => t.currentPaise)) });
    suggestedLine.push({ h: Number(h.toFixed(1)), v: Math.round(currentRevenue + add('sug', (t) => t.suggestedPaise)) });
  }

  // ---- demand heatmap: tier x last 24 hours ------------------------------
  const cols = Array.from({ length: HEAT_HOURS }, (_, i) => {
    const end = now - (HEAT_HOURS - 1 - i) * HOUR;
    const hourIst = new Date(end - HOUR + IST_OFFSET).getUTCHours();
    return { start: end - HOUR, end, hourIst };
  });
  const gridRows = [{ id: 0, name: 'All tiers', cells: [] }, ...types.map((t) => ({ id: t.id, name: t.name, cells: [] }))];
  for (const row of gridRows) {
    const pool = row.id === 0 ? rows : rows.filter((s) => s.ticket_type_id === row.id);
    row.cells = cols.map((c) => pool.reduce((n, s) => (s.at > c.start && s.at <= c.end ? n + s.quantity : n), 0));
    row.total = row.cells.reduce((a, b) => a + b, 0);
  }
  const maxCell = Math.max(0, ...gridRows.flatMap((r) => r.cells));
  gridRows.forEach((r) => { r.levels = r.cells.map((q) => (q === 0 || maxCell === 0 ? 0 : clamp(Math.ceil((q / maxCell) * 4), 1, 4))); });

  const byHourIst = Array(24).fill(0);
  rows.forEach((s) => { byHourIst[new Date(s.at + IST_OFFSET).getUTCHours()] += s.quantity; });
  const peak = Math.max(...byHourIst);
  const peakHourIst = peak > 0 ? byHourIst.indexOf(peak) : null;

  const publicTiers = tiers.map(({ _holdUnits, _sugUnits, _rate, _factor, _left, ...rest }) => rest);
  return {
    algorithm: 'local-demand-model-v2',
    disclaimer: 'Smart Pricing uses this platform’s own booking data and a transparent pace model. No external AI service is called.',
    ended,
    capacity, sold, remaining, utilization,
    hoursUntil: Number(hoursLeft.toFixed(1)),
    daysUntil: Number((hoursLeft / 24).toFixed(2)),
    ticketsLast6h: q6All,
    ticketsLast24h: q24All,
    ratePerHour: Number(rateAll.toFixed(3)),
    sellOutEtaHours: Number.isFinite(etaAll) ? Number(etaAll.toFixed(1)) : null,
    demandScore: Number(demandScore.toFixed(2)),
    demand,
    recommendations: publicTiers,
    forecast: {
      currentRevenuePaise: currentRevenue,
      projectedHoldPaise: projectedHold,
      projectedSuggestedPaise: projectedSuggested,
      upliftPaise: projectedSuggested - projectedHold,
      assumptions: [
        'Sales continue at each tier’s recent pace until the event.',
        `Price elasticity of ${ELASTICITY}: a 10% increase is assumed to cost about ${Math.round(ELASTICITY * 10)}% of future sales.`,
        'Booking fees are excluded.',
      ],
    },
    chart: { historyHours: HISTORY_HOURS, horizonHours: Number(horizon.toFixed(1)), history, hold, suggested: suggestedLine },
    heatmap: {
      hours: cols.map((c) => c.hourIst),
      rows: gridRows,
      peakHourIst,
    },
  };
}

function fmtHours(h) {
  if (!Number.isFinite(h)) return 'a long time';
  if (h < 1) return 'under an hour';
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)} days`;
}

module.exports = { insightsForEvent, demandBand, MAX_UP, MAX_DOWN, COOLDOWN_HOURS };

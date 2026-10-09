/* Organizer: dashboard, event detail, and the Smart Pricing panel. */

function compactRupee(paise) {
  const r = (paise || 0) / 100;
  const trim = (n) => String(n).replace(/\.0$/, '');
  if (r >= 1e7) return '₹' + trim((r / 1e7).toFixed(r >= 1e8 ? 0 : 1)) + 'Cr';
  if (r >= 1e5) return '₹' + trim((r / 1e5).toFixed(r >= 1e6 ? 0 : 1)) + 'L';
  if (r >= 1e3) return '₹' + trim((r / 1e3).toFixed(r >= 1e4 ? 0 : 1)) + 'k';
  return '₹' + Math.round(r);
}

function durationLabel(hours) {
  if (hours < 1) return '<1h';
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/* ---------- revenue projection chart (inline SVG) ---------- */

function revenueChart(ins) {
  const ch = ins.chart;
  const W = 640, H = 240, L = 54, R = 18, T = 16, B = 34;
  const innerW = W - L - R, innerH = H - T - B;
  const hasProjection = ch.horizonHours > 0;
  const histW = hasProjection ? innerW * 0.34 : innerW;
  const projW = innerW - histW;
  const maxV = Math.max(1, ...ch.history.map((p) => p.v), ...ch.hold.map((p) => p.v), ...ch.suggested.map((p) => p.v)) * 1.08;
  const x = (h) => (h <= 0
    ? L + ((h + ch.historyHours) / ch.historyHours) * histW
    : L + histW + (h / ch.horizonHours) * projW);
  const y = (v) => T + (1 - v / maxV) * innerH;
  const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.h).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');
  const gridVals = [0, maxV / 2, maxV];
  const nowX = x(0);
  const endLabel = ch.horizonHours >= ins.hoursUntil - 0.5 ? 'Event' : `+${durationLabel(ch.horizonHours)}`;
  const last = (arr) => arr[arr.length - 1];
  const aria = `Revenue so far ${compactRupee(ins.forecast.currentRevenuePaise)}. Projected by the event: ${compactRupee(ins.forecast.projectedHoldPaise)} if prices hold, ${compactRupee(ins.forecast.projectedSuggestedPaise)} with the suggested prices.`;
  return `<svg class="rev-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}" preserveAspectRatio="xMidYMid meet">
    ${gridVals.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="rc-grid"/><text x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" class="rc-axis">${compactRupee(v)}</text>`).join('')}
    ${hasProjection ? `<line x1="${nowX.toFixed(1)}" x2="${nowX.toFixed(1)}" y1="${T}" y2="${H - B}" class="rc-now"/>` : ''}
    ${hasProjection ? `<path d="${path(ch.hold)}" class="rc-hold" fill="none"/><path d="${path(ch.suggested)}" class="rc-sug" fill="none"/>` : ''}
    <path d="${path(ch.history)}" class="rc-actual" fill="none"/>
    ${hasProjection ? `<circle cx="${nowX.toFixed(1)}" cy="${y(ins.forecast.currentRevenuePaise).toFixed(1)}" r="4.5" class="rc-dot"/>
      <circle cx="${x(last(ch.suggested).h).toFixed(1)}" cy="${y(last(ch.suggested).v).toFixed(1)}" r="4" class="rc-dot-sug"/>
      <circle cx="${x(last(ch.hold).h).toFixed(1)}" cy="${y(last(ch.hold).v).toFixed(1)}" r="4" class="rc-dot-hold"/>` : ''}
    <text x="${L}" y="${H - 10}" class="rc-axis">-${ch.historyHours}h</text>
    ${hasProjection ? `<text x="${nowX.toFixed(1)}" y="${H - 10}" text-anchor="middle" class="rc-axis rc-axis-now">Now</text>
    <text x="${W - R}" y="${H - 10}" text-anchor="end" class="rc-axis">${endLabel}</text>` : ''}
  </svg>`;
}

/* ---------- demand heatmap: tier x last 24h ---------- */

function demandHeatmap(ins) {
  const hm = ins.heatmap;
  const hourLabel = (h) => String(h).padStart(2, '0');
  return `<div class="hm-scroll"><div class="hm" style="--cols:${hm.hours.length}" role="table" aria-label="Tickets sold per hour, by tier, last 24 hours">
    <div class="hm-corner" role="columnheader"></div>
    ${hm.hours.map((h, i) => `<div class="hm-hour ${i % 3 === 0 ? 'show' : ''}" role="columnheader">${i % 3 === 0 ? hourLabel(h) : ''}</div>`).join('')}
    ${hm.rows.map((row) => `
      <div class="hm-label ${row.id === 0 ? 'all' : ''}" role="rowheader"><span>${esc(row.name)}</span><small>${row.total}</small></div>
      ${row.cells.map((q, i) => `<div class="hm-cell l${row.levels[i]}" role="cell" title="${q} ticket${q === 1 ? '' : 's'} · ${hourLabel(hm.hours[i])}:00 IST" aria-label="${q} tickets at ${hourLabel(hm.hours[i])}:00"></div>`).join('')}
    `).join('')}
  </div></div>
  <div class="hm-legend"><span>Fewer</span>${[0, 1, 2, 3, 4].map((l) => `<i class="hm-cell l${l}"></i>`).join('')}<span>More</span>
    <span class="hm-peak">${hm.peakHourIst == null ? 'No bookings yet' : `Bookings peak around <b>${hourLabel(hm.peakHourIst)}:00 IST</b>. Time promotions for then.`}</span></div>`;
}

/* ---------- pricing panel ---------- */

const STRATEGY_CLASS = { raise: 'up', lower: 'down', close_early_bird: 'info', sold_out: 'off', hold: 'flat' };

function tierCard(r) {
  const moves = r.suggestedPaise !== r.currentPaise;
  const delta = r.changePct > 0 ? `+${r.changePct}%` : `${r.changePct}%`;
  return `<article class="tier" data-tt="${r.ticketTypeId}">
    <div class="row"><b>${esc(r.name)}</b><span class="strat ${STRATEGY_CLASS[r.action] || 'flat'}">${esc(r.strategy)}</span></div>
    <div class="tier-price">${moves
      ? `<s>${r.currentLabel}</s><span aria-hidden="true">→</span><b>${r.suggestedLabel}</b><span class="delta ${r.changePct > 0 ? 'up' : 'down'}">${delta}</span>`
      : `<b>${r.currentLabel}</b><span class="muted">${r.action === 'hold' ? 'no change suggested' : ''}</span>`}</div>
    <p class="tier-why"><b>${esc(r.headline)}.</b> ${esc(r.reason)}</p>
    <div class="bar ${r.utilization > 0.8 ? 'hot' : ''}"><i style="--w:${Math.round(r.utilization * 100)}%"></i></div>
    <div class="row tier-foot">
      <span class="muted">${r.sold}/${r.capacity} sold · ${r.remaining} left · <span class="conf ${r.confidence}">${r.confidence} confidence</span></span>
      ${moves ? `<button class="bt apply" data-price="${r.suggestedPaise}" data-name="${esc(r.name)}" data-from="${esc(r.currentLabel)}" data-to="${esc(r.suggestedLabel)}">Apply ${r.suggestedLabel}</button>` : ''}
    </div>
  </article>`;
}

function pricingPanel(ins, opts = {}) {
  const f = ins.forecast;
  const movers = ins.recommendations.filter((r) => r.suggestedPaise !== r.currentPaise);
  const uplift = f.upliftPaise;
  const history = opts.history || [];
  return `<section class="pp" aria-label="Smart Pricing">
    <div class="pp-head">
      <div>
        <h3>Smart Pricing${opts.eventName ? ` <span class="muted pp-for">for ${esc(opts.eventName)}</span>` : ''}</h3>
        <p class="muted">Reads booking pace tier by tier and suggests where to move price. Suggestions only apply when you press apply.</p>
      </div>
      ${opts.selector || ''}
    </div>

    <div class="pp-kpis">
      <div class="kpi"><span class="kpi-l">Demand</span><b class="dband ${ins.demand.key}">${ins.demand.label}</b><span class="muted">score ${Math.round(ins.demandScore * 100)}/100</span></div>
      <div class="kpi"><span class="kpi-l">Booking pace</span><b>${ins.ticketsLast24h}</b><span class="muted">tickets in 24h · ${ins.ratePerHour}/h</span></div>
      <div class="kpi"><span class="kpi-l">At this pace</span><b>${ins.sellOutEtaHours == null ? 'No sell-out' : 'Sells out in ' + durationLabel(ins.sellOutEtaHours)}</b><span class="muted">${ins.ended ? 'event started' : durationLabel(ins.hoursUntil) + ' until the event'}</span></div>
    </div>

    <div class="tiers">${ins.recommendations.map(tierCard).join('')}</div>
    ${movers.length > 1 ? `<div class="pp-all"><button class="bt o" id="apply-all">Apply all ${movers.length} suggestions</button></div>` : ''}

    <div class="pp-block">
      <h4>Revenue projection</h4>
      <div class="pp-rev">
        <div class="kpi"><span class="kpi-l">Revenue so far</span><b>${rupee(f.currentRevenuePaise)}</b></div>
        <div class="kpi"><span class="kpi-l"><i class="sw-hold"></i> If prices hold</span><b>${rupee(f.projectedHoldPaise)}</b></div>
        <div class="kpi"><span class="kpi-l"><i class="sw-sug"></i> With suggestions</span><b>${rupee(f.projectedSuggestedPaise)}</b>
          <span class="delta ${uplift > 0 ? 'up' : uplift < 0 ? 'down' : ''}">${uplift === 0 ? 'same as holding' : (uplift > 0 ? '+' : '−') + rupee(Math.abs(uplift))}</span></div>
      </div>
      ${revenueChart(ins)}
      <div class="rc-legend"><span><i class="sw-act"></i>Actual</span><span><i class="sw-hold"></i>Prices hold</span><span><i class="sw-sug"></i>Suggested prices</span></div>
    </div>

    <div class="pp-block">
      <h4>Demand heatmap <span class="muted">tickets per hour, last 24h (IST)</span></h4>
      ${demandHeatmap(ins)}
    </div>

    ${history.length ? `<div class="pp-block"><h4>Price changes</h4><ul class="plist">${history.map((h) => `<li><b>${esc(h.ticket_type)}</b> ${rupee(h.old_price_paise)} → ${rupee(h.new_price_paise)} <span class="muted">· ${esc(h.source === 'manual' ? 'manual' : 'Smart Pricing')} · ${esc(h.changed_by)} · ${new Date(h.created_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span></li>`).join('')}</ul></div>` : ''}

    <details class="pp-assume"><summary>How this works</summary>
      <p class="muted">${esc(ins.disclaimer)}</p>
      <ul>${f.assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
      <p class="muted">A new price affects future reservations only. Seats someone is already holding, and past bookings, keep the price they were given.</p>
    </details>
  </section>`;
}

function bindPricingPanel(root, eventId, onUpdate) {
  const send = async (changes, summary) => {
    try {
      const out = await api(`/api/organizer/events/${eventId}/pricing/apply`, { method: 'POST', body: { changes } });
      toast(summary);
      onUpdate(out);
    } catch (e) { toast(e.message); }
  };
  root.querySelectorAll('.apply').forEach((btn) => {
    btn.onclick = () => {
      const id = Number(btn.closest('.tier').dataset.tt);
      if (!confirm(`Change ${btn.dataset.name} from ${btn.dataset.from} to ${btn.dataset.to}?\n\nThe new price applies to future reservations only.`)) return;
      send([{ ticketTypeId: id, pricePaise: Number(btn.dataset.price) }], `${btn.dataset.name} is now ${btn.dataset.to}`);
    };
  });
  const all = $('#apply-all', root);
  if (all) all.onclick = () => {
    const changes = [...root.querySelectorAll('.apply')].map((b) => ({ ticketTypeId: Number(b.closest('.tier').dataset.tt), pricePaise: Number(b.dataset.price) }));
    if (!confirm(`Apply ${changes.length} price changes? They affect future reservations only.`)) return;
    send(changes, `${changes.length} prices updated`);
  };
}

/* ---------- dashboard ---------- */

function dashStats(s) {
  return `<div class="g3" style="margin:12px 0">
    <div class="cd"><span class="muted">Events</span><b class="price">${s.events}</b></div>
    <div class="cd"><span class="muted">Bookings</span><b class="price">${s.bookings}</b></div>
    <div class="cd"><span class="muted">Tickets sold</span><b class="price">${s.ticketsSold}</b></div>
    <div class="cd"><span class="muted">Tickets remaining</span><b class="price">${s.ticketsRemaining}</b></div>
    <div class="cd"><span class="muted">Current revenue</span><b class="price">${rupee(s.revenuePaise)}</b></div>
    <div class="cd"><span class="muted">Check-ins</span><b class="price">${s.checkins}</b></div>
  </div>`;
}

async function viewOrgDash() {
  if (!me || (me.role !== 'organizer' && me.role !== 'admin')) { navigate('/login'); return; }
  app.innerHTML = `<main class="w page"><div class="skel" style="height:160px"></div></main>`;

  const fetchDash = () => api('/api/organizer/dashboard' + (window.__insightEvent ? `?event=${window.__insightEvent}` : ''));
  let d = await fetchDash();
  window.__insightEvent = d.featuredEventId;

  const selector = () => d.insightEvents.length > 1
    ? `<label class="field pp-select"><span class="muted">Event</span><select id="ins-event" aria-label="Choose event for Smart Pricing">${d.insightEvents.map((e) =>
        `<option value="${e.id}" ${e.id === d.featuredEventId ? 'selected' : ''}>${esc(e.name)} · ${e.demand.label} demand</option>`).join('')}</select></label>`
    : '';
  const featuredName = () => (d.insightEvents.find((e) => e.id === d.featuredEventId) || {}).name;

  const paintPricing = () => {
    const root = $('#pricing-root');
    if (!root) return;
    if (!d.insights) { root.innerHTML = `<div class="empty">Smart Pricing appears once you have an upcoming published event.</div>`; return; }
    root.innerHTML = pricingPanel(d.insights, { selector: selector(), eventName: featuredName(), history: d.pricingHistory });
    const sel = $('#ins-event', root);
    if (sel) sel.onchange = async () => { window.__insightEvent = Number(sel.value); d = await fetchDash(); paintPricing(); };
    bindPricingPanel(root, d.featuredEventId, (out) => { d.insights = out.insights; d.pricingHistory = out.pricingHistory; paintPricing(); });
  };

  app.innerHTML = `<main class="w page">
    <div class="wf">
    <div class="top">Dashboard <a class="bt" href="#/organizer/events/new" style="min-height:36px">+ New event</a></div>
    <p class="muted">Live capacity, demand, and door activity for your shows. <span class="live-dot"></span>Updates every 10 seconds.</p>
    <div id="stats">${dashStats(d.stats)}</div>
    <div id="pricing-root"></div>
    <h3 style="margin:22px 0 8px">Your events</h3>
    <div id="events-list"></div>
    <h3 style="margin:18px 0 8px">Recent bookings</h3>
    <div style="overflow-x:auto"><table class="table"><thead><tr><th>Buyer</th><th>Event</th><th>Amount</th><th>ID</th></tr></thead><tbody id="recent"></tbody></table></div>
    </div>
  </main>`;

  const paintLists = () => {
    $('#stats').innerHTML = dashStats(d.stats);
    $('#events-list').innerHTML = d.events.map((e) => `<div style="margin-bottom:10px"><div class="row"><a href="#/organizer/events/${e.id}"><b>${esc(e.name)}</b></a><span>${e.sold} / ${e.capacity}</span></div>
      <div class="bar ${e.utilization > 0.9 ? 'hot' : ''}"><i style="--w:${Math.round(e.utilization * 100)}%"></i></div></div>`).join('') || '<div class="empty">No events yet</div>';
    $('#recent').innerHTML = d.recentBookings.map((b) => `<tr><td>${esc(b.buyer)}</td><td>${esc(b.event_name)}</td><td>${rupee(b.amount_paise)}</td><td>${esc(b.public_id)}</td></tr>`).join('') || '<tr><td colspan="4">None yet</td></tr>';
  };
  paintLists();
  paintPricing();

  // "Real-time": refresh in place so an open dropdown or scroll position isn't lost on every tick.
  pollTimer = setInterval(async () => {
    if (path() !== '/organizer' || document.hidden) return;
    try {
      d = await fetchDash();
      paintLists();
      const root = $('#pricing-root');
      if (root && !root.contains(document.activeElement)) paintPricing();
    } catch { /* keep the last good view */ }
  }, 10000);
}

/* ---------- events list & detail ---------- */

async function viewOrgEvents() {
  const { events } = await api('/api/organizer/events');
  app.innerHTML = `<main class="w page"><div class="wf"><div class="top">Your events <a class="bt" href="#/organizer/events/new" style="min-height:36px">+ New event</a></div>
    <div class="event-grid">${events.map((e) => `<a class="cd" href="#/organizer/events/${e.id}"><div class="banner ${esc(e.image_key)}" style="height:72px"></div><b>${esc(e.name)}</b><span class="muted">${esc(e.city)} · ${e.ticketsSold}/${e.totalCapacity}</span></a>`).join('')}</div></div></main>`;
}

async function viewOrgEvent(id) {
  let d = await api(`/api/organizer/events/${id}`);
  const paint = () => {
    const e = d.event;
    const scan = d.scan;
    app.innerHTML = `<main class="w page">
      <a href="#/organizer/events" class="muted">‹ Events</a>
      <div class="row" style="flex-wrap:wrap"><h2>${esc(e.name)}</h2><div class="actions"><a class="bt o" href="#/organizer/scanner?event=${e.id}">Open scanner</a><a class="bt o" href="#/organizer/events/${e.id}/edit">Edit</a></div></div>
      <p class="muted">${esc(fmtDate(e.date, e.time))} · ${esc(e.venue)}</p>
      <div class="g3">
        <div class="cd"><span class="muted">Sold</span><b class="price">${e.ticketsSold}</b></div>
        <div class="cd"><span class="muted">Remaining</span><b class="price">${e.ticketsRemaining}</b></div>
        <div class="cd"><span class="muted">Checked in</span><b class="price">${scan.checkedIn} <small class="muted">/ ${scan.total}</small></b></div>
      </div>
      <div class="cd blocked-card" style="margin-top:8px"><span class="muted">Entry attempts blocked at the door</span><b class="price">${scan.blocked}</b><span class="muted">Expired screenshots, copied or forged QR codes, and repeat scans.</span></div>
      ${e.ticketTypes.map((t) => `<div class="row" style="margin-top:8px"><b>${esc(t.name)}</b><span>${t.sold} sold · ${t.available} left · ${rupee(t.price_paise)}</span></div>`).join('')}
      <div id="pricing-root" style="margin-top:16px"></div>
      <h3 style="margin-top:18px">Bookings</h3>
      <div style="overflow-x:auto"><table class="table"><thead><tr><th>Buyer</th><th>Qty</th><th>Amount</th><th>Status</th><th>ID</th></tr></thead>
      <tbody>${d.bookings.map((b) => `<tr><td>${esc(b.buyer)}</td><td>${b.quantity}</td><td>${rupee(b.amount_paise)}</td><td>${esc(b.status)}</td><td>${esc(b.public_id)}</td></tr>`).join('')}</tbody></table></div>
    </main>`;
    const root = $('#pricing-root');
    root.innerHTML = pricingPanel(d.insights, { history: d.pricingHistory });
    bindPricingPanel(root, e.id, (out) => { d.insights = out.insights; d.pricingHistory = out.pricingHistory; d.event = out.event; paint(); });
  };
  paint();
}

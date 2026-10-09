const $ = (sel, el = document) => el.querySelector(sel);
// Everything user-controlled (names, venues, descriptions) goes through this before it touches innerHTML.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');
let me = null;
let toastTimer = 0;
let pollTimer = 0;
let qrTimer = 0;
let lockTicker = 0;
let bannerTimer = 0;
let scanner = null;

const rupee = (paise) => '₹' + Math.round((paise || 0) / 100).toLocaleString('en-IN');
const fmtDate = (d, t) => {
  const dt = new Date(`${d}T${t || '00:00'}:00`);
  return dt.toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: t ? 'numeric' : undefined, minute: t ? '2-digit' : undefined });
};

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function path() {
  const h = location.hash.replace(/^#/, '') || '/';
  return h.startsWith('/') ? h : '/' + h;
}

function navigate(to) {
  location.hash = to.startsWith('#') ? to : '#' + to;
}

function stopTimers() {
  clearInterval(pollTimer);
  clearInterval(qrTimer);
  clearInterval(lockTicker);
  pollTimer = qrTimer = lockTicker = 0;
  if (scanner) {
    scanner.stop().catch(() => {});
    scanner = null;
  }
}

function chip(status) {
  const map = { confirmed: ['c', 'Confirmed'], cancelled: ['x', 'Cancelled'], used: ['u', 'Used'], open: ['c', 'Open'], low: ['w', 'Low stock'], sold_out: ['x', 'Sold out'] };
  const [k, label] = map[status] || ['u', status];
  return `<span class="chip ${k}">${label}</span>`;
}

function nav() {
  const attendee = !me || me.role === 'customer' || me.role === 'admin';
  const org = me && (me.role === 'organizer' || me.role === 'admin');
  const p = path().split('?')[0];
  const link = (href, label) => `<a href="#${href}" class="${p === href || (href !== '/organizer' && href !== '/' && p.startsWith(href + '/')) ? 'on' : ''}">${label}</a>`;
  let links = '';
  if (org && p.startsWith('/organizer')) {
    links = link('/organizer', 'Dashboard') + link('/organizer/events', 'Events') + link('/organizer/scanner', 'Check-in');
  } else {
    links = link('/', 'Events') + (me ? link('/bookings', 'My bookings') : '') + (me ? link('/account', 'Account') : '');
  }
  $('#nav-links').innerHTML = links;
  $('#nav-right').innerHTML = me
    ? `<span class="muted">${esc(me.name.split(' ')[0])}</span>${org && !p.startsWith('/organizer') ? '<a class="bt o" href="#/organizer" style="min-height:36px">Organizer</a>' : ''}${attendee && p.startsWith('/organizer') ? '<a class="bt o" href="#/" style="min-height:36px">Browse events</a>' : ''}<button class="bt o" style="min-height:36px" id="logout">Log out</button>`
    : `<a class="bt" href="#/login" style="min-height:36px">Sign in</a>`;
  const lo = $('#logout');
  if (lo) lo.onclick = async () => { await api('/api/auth/logout', { method: 'POST', body: {} }); me = null; navigate('/'); render(); };
  const tabs = org && p.startsWith('/organizer')
    ? `<a href="#/organizer" class="${p === '/organizer' ? 'on' : ''}">Dashboard</a><a href="#/organizer/events" class="${p.startsWith('/organizer/events') ? 'on' : ''}">Events</a><a href="#/organizer/scanner" class="${p.startsWith('/organizer/scanner') ? 'on' : ''}">Check-in</a>`
    : `<a href="#/" class="${p === '/' ? 'on' : ''}">Events</a><a href="#/bookings" class="${p.startsWith('/bookings') || p.startsWith('/pass') ? 'on' : ''}">Bookings</a><a href="#/account" class="${p.startsWith('/account') || p.startsWith('/login') ? 'on' : ''}">Account</a>`;
  $('#mobile-tabs').innerHTML = tabs;
}

function skelCards() {
  return `<div class="event-grid">${[1, 2, 3, 4].map(() => `<div class="cd"><div class="skel" style="height:84px"></div><div class="skel"></div><div class="skel" style="width:40%"></div></div>`).join('')}</div>`;
}

async function viewHome() {
  app.innerHTML = `
    <div class="band"><i class="sun"></i><i class="blob b1"></i><i class="blob b2"></i>
    <header class="w hero">
      <div>
        <h1>Tickets that can't be screenshotted.</h1>
        <p>Dynamic passes. Live capacity protection. Smarter event pricing. A booking experience built around the ticket itself.</p>
        <div class="actions" style="margin-top:16px">
          <a class="bt" href="#/events">Browse events</a>
          <a class="bt o" href="#/login">Organizer sign in</a>
        </div>
      </div>
      <div class="tk" aria-label="Sample ticket"><div class="m"><b style="font-family:var(--d);font-size:20px">Mumbai Music Night</b><div style="color:var(--mu);font-size:14px">Sat 14 Nov, 7:30 pm<br>NCPA, Mumbai</div><span class="chip c" style="margin-top:8px">Confirmed</span></div><div class="s"><div class="qr"></div>EP-4821</div></div>
    </header></div>
    <div class="wave" aria-hidden="true"></div>
    <main class="w page" id="browse">${skelCards()}</main>
    <footer class="w">EventPass · tickets that can't be screenshotted.</footer>`;
  await viewBrowse($('#browse'), true);
}

async function viewBrowse(mount, embedded) {
  const wrap = mount || app;
  if (!embedded) wrap.innerHTML = `<main class="w page"><div class="wf"><div class="top">Events <input class="in" id="q-pre" placeholder="Search events" style="font:400 14px var(--b);max-width:220px"></div><div id="browse-list">${skelCards()}</div></div></main>`;
  const target = embedded ? wrap : $('#browse-list');
  try {
    const { events } = await api('/api/events');
    window.__events = events;
    renderEventList(target, events, embedded);
  } catch (e) {
    target.innerHTML = `<div class="empty">${e.message}</div>`;
  }
}

function renderEventList(target, events, embedded) {
  const sold = events.reduce((sum, event) => sum + event.ticketsSold, 0);
  const remaining = events.reduce((sum, event) => sum + event.ticketsRemaining, 0);
  const lowStock = events.filter((event) => event.availability === 'low').length;
  target.innerHTML = `
    ${embedded ? `<section class="home-intro">
      <div class="home-heading">
        <span class="eyebrow">EVENTPASS · LIVE EVENTS</span>
        <h2>Make room for a night worth remembering.</h2>
        <p>Find your next show, reserve your seats, and carry a Smart Pass that keeps changing while you do.</p>
        <div class="actions"><a class="bt" href="#/events">Explore events</a><span class="muted">${events.length} events across India</span></div>
      </div>
      <div class="home-feature-tile">
        <div class="row"><span class="eyebrow">YOUR EVENTPASS</span><span class="tile-mark">EP</span></div>
        <div class="tile-rule"></div>
        <b>One pass. A safer way in.</b>
        <p>Every confirmed ticket gets a live QR that refreshes every 15 seconds.</p>
        <div class="tile-footer"><span>SMART PASS</span><span>LIVE · 00:15</span></div>
      </div>
    </section>
    <div class="home-widgets" aria-label="EventPass at a glance">
      <article class="home-widget"><span class="widget-label">EVENTS TO EXPLORE</span><b>${events.length}</b><span>Music, comedy, culture and more</span></article>
      <article class="home-widget"><span class="widget-label">TICKETS BOOKED</span><b>${sold.toLocaleString('en-IN')}</b><span>Across currently listed events</span></article>
      <article class="home-widget"><span class="widget-label">SEATS AVAILABLE</span><b>${remaining.toLocaleString('en-IN')}</b><span>${lowStock ? `${lowStock} event${lowStock === 1 ? '' : 's'} running low` : 'Live availability, updated as you browse'}</span></article>
    </div>
    <section class="home-discovery">
      <div class="discovery-copy"><span class="eyebrow">FIND YOUR NEXT PLAN</span><h2>Upcoming events</h2><p class="lead">Search by event or venue, then filter by the kind of day you want.</p></div>
      <input class="in home-search" id="q" placeholder="Search events, venues, cities" aria-label="Search events, venues, or cities">
    </section>` : ''}
    <div class="row" style="margin-bottom:12px;gap:8px;flex-wrap:wrap">
      ${embedded ? '' : '<h2>Upcoming events</h2>'}
      <div class="pills" id="filters">
        ${['All', 'Music', 'Comedy', 'Workshops', 'This weekend'].map((x, i) => `<button data-f="${x}" class="${i === 0 ? 'on' : ''}">${x}</button>`).join('')}
      </div>
    </div>
    <div class="event-grid" id="grid">${eventCards(events)}</div>
    ${embedded ? `<section class="home-usp"><div><span class="eyebrow">BUILT AROUND YOUR TICKET</span><h2>Good plans. Better entry.</h2><p class="lead">EventPass protects the booking at every step, from holding your seats to scanning your pass at the door.</p></div>
      <div class="usp-grid">
        <article class="usp-item"><span class="usp-index">01</span><div><b>Smart Pass</b><p>Your QR rotates every 15 seconds to make copied screenshots go stale.</p></div></article>
        <article class="usp-item"><span class="usp-index">02</span><div><b>Live capacity locks</b><p>Selected seats are held for five minutes while you finish checkout.</p></div></article>
        <article class="usp-item"><span class="usp-index">03</span><div><b>Smarter event pricing</b><p>Organizers see booking pace and useful recommendations based on real demand.</p></div></article>
      </div>
    </section>` : ''}`;
  const qEl = $('#q', target) || $('#q-pre');
  const apply = () => {
    const q = (qEl ? qEl.value : '').toLowerCase();
    const f = $('#filters .on', target).dataset.f;
    let list = window.__events || [];
    if (q) list = list.filter((e) => `${e.name} ${e.venue} ${e.city}`.toLowerCase().includes(q));
    if (f === 'This weekend') list = list.filter((e) => [0, 6].includes(new Date(e.date + 'T12:00:00').getDay()));
    else if (f !== 'All') list = list.filter((e) => e.category === f);
    $('#grid', target).innerHTML = eventCards(list);
  };
  if (qEl) qEl.oninput = apply;
  target.querySelectorAll('#filters button').forEach((b) => {
    b.onclick = () => {
      target.querySelectorAll('#filters button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      apply();
    };
  });
}

function eventCards(events) {
  if (!events.length) return `<div class="empty">No events match. Clear filters.</div>`;
  return events.map((e) => `
    <a class="cd" href="#/event/${e.id}">
      <div class="banner ${esc(e.image_key)}" style="height:84px;font-size:16px">${esc(e.city)}</div>
      <b>${esc(e.name)}</b>
      <span class="muted">${fmtDate(e.date).replace(/,.+$/, '')} · ${esc(e.venue.split(',')[0])}</span>
      <div class="row"><b>From ${rupee(e.fromPricePaise)}</b>${chip(e.availability === 'low' ? 'low' : e.availability === 'sold_out' ? 'sold_out' : 'open')}</div>
    </a>`).join('');
}

async function viewEvent(id) {
  app.innerHTML = `<main class="w page"><div class="skel" style="height:180px"></div></main>`;
  try {
    const data = await api(`/api/events/${id}`);
    drawEvent(data);
    pollTimer = setInterval(async () => {
      try {
        const fresh = await api(`/api/events/${id}`);
        const lock = path() === `/event/${id}` || path() === `/checkout`;
        if (path() === `/event/${id}`) drawEvent(fresh, true);
        if (!lock) return;
      } catch { /* ignore */ }
    }, 4000);
  } catch (e) {
    app.innerHTML = `<main class="w page"><div class="empty">${e.message}</div></main>`;
  }
}

function drawEvent(data, keepQty) {
  const { event, organizer, lock } = data;
  const prev = keepQty ? window.__qty : {};
  window.__qty = {};
  event.ticketTypes.forEach((t) => {
    window.__qty[t.id] = Math.min(prev?.[t.id] || 0, t.available, MAX_FROM_TYPE(t));
  });
  const qtyTotal = () => Object.values(window.__qty).reduce((s, n) => s + n, 0);
  const money = () => event.ticketTypes.reduce((s, t) => s + (window.__qty[t.id] || 0) * t.price_paise, 0);
  app.innerHTML = `<main class="w page">
    <div class="two" style="margin-top:4px">
      <div>
        <div class="wf" style="margin-bottom:12px">
          <div class="top">‹ <a href="#/" style="text-decoration:none;color:inherit">${esc(event.name)}</a></div>
          <div class="banner ${esc(event.image_key)}">${esc(event.city)}</div>
          <p class="muted" style="margin:0">${fmtDate(event.date, event.time)} · ${esc(event.venue)}</p>
          <p style="margin:0">${esc(event.address)}, ${esc(event.city)}</p>
          <p style="margin:0">${esc(event.description)}</p>
          <p class="muted" style="margin:0">Organizer: ${esc(organizer.name)}</p>
          <p class="muted" style="margin:0">${event.ticketsRemaining} of ${event.totalCapacity} tickets remaining</p>
          <div class="bar ${event.ticketsRemaining < event.totalCapacity * 0.1 ? 'hot' : ''}"><i style="--w:${Math.round((event.ticketsSold / event.totalCapacity) * 100)}%"></i></div>
        </div>
      </div>
      <div class="wf" id="ticket-box">
        <div class="top">Select tickets</div>
        ${event.ticketTypes.map((t) => rowType(t)).join('')}
        <div class="muted" id="tmsg">Up to 6 tickets per booking. Availability is locked at checkout.</div>
        ${lock && lock.status === 'active' ? `<div class="lockbar"><div><b>Tickets reserved for you</b><div class="muted">Complete payment within <span id="cd">${clock(lock.remainingMs)}</span></div><div class="lock-prog"><i id="cdbar"></i></div></div><a class="bt" href="#/checkout">Continue</a></div>` : ''}
        <button class="bt" id="book" ${qtyTotal() ? '' : 'disabled'}>Book tickets · ${rupee(money())}</button>
      </div>
    </div>
  </main>`;
  bindSteppers(event);
  if (lock && lock.status === 'active') startLockTicker(lock.remainingMs, data.lockMs || 300000, () => viewEvent(event.id));
  else clearInterval(lockTicker);
  $('#book').onclick = async function () {
    if (!me) { navigate('/login?next=/event/' + event.id); return; }
    if (me.role === 'organizer') { toast('Use an attendee account to book.'); return; }
    this.classList.add('load'); this.disabled = true;
    try {
      const items = event.ticketTypes.filter((t) => window.__qty[t.id] > 0).map((t) => ({ ticketTypeId: t.id, quantity: window.__qty[t.id] }));
      await api('/api/locks', { method: 'POST', body: { eventId: event.id, items } });
      toast('Tickets reserved for you');
      navigate('/checkout');
    } catch (e) {
      toast(e.message);
      viewEvent(event.id);
    }
  };
}

function MAX_FROM_TYPE(t) { return Math.min(6, t.available); }

function rowType(t) {
  const left = t.available;
  const warn = left > 0 && left <= 8;
  return `<div class="row" data-tt="${t.id}">
    <div><b>${esc(t.name)}</b> · ${rupee(t.price_paise)}<br>
      <span class="${warn ? '' : 'muted'}" style="${warn ? 'color:var(--warn);font-weight:700' : ''}">${left <= 0 ? 'Sold out' : left + ' left'} · ${t.capacity} capacity</span>
    </div>
    <div class="step">
      <button data-d="-1" aria-label="Fewer" ${window.__qty[t.id] ? '' : 'disabled'}>−</button>
      <output>${window.__qty[t.id] || 0}</output>
      <button data-d="1" aria-label="More" ${window.__qty[t.id] >= MAX_FROM_TYPE(t) || left <= 0 ? 'disabled' : ''}>+</button>
    </div>
  </div>`;
}

function bindSteppers(event) {
  app.querySelectorAll('[data-tt]').forEach((row) => {
    const id = Number(row.dataset.tt);
    const t = event.ticketTypes.find((x) => x.id === id);
    row.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        const d = Number(b.dataset.d);
        const others = Object.entries(window.__qty).reduce((s, [k, v]) => s + (Number(k) === id ? 0 : v), 0);
        window.__qty[id] = Math.max(0, Math.min(MAX_FROM_TYPE(t), 6 - others, (window.__qty[id] || 0) + d));
        const out = row.querySelector('output');
        out.textContent = window.__qty[id];
        out.classList.remove('bump'); void out.offsetWidth; out.classList.add('bump');
        const total = Object.values(window.__qty).reduce((s, n) => s + n, 0);
        const money = event.ticketTypes.reduce((s, x) => s + (window.__qty[x.id] || 0) * x.price_paise, 0);
        const book = $('#book');
        book.disabled = total === 0;
        book.textContent = 'Book tickets · ' + rupee(money);
        row.querySelector('[data-d="-1"]').disabled = window.__qty[id] === 0;
        row.querySelector('[data-d="1"]').disabled = window.__qty[id] >= Math.min(MAX_FROM_TYPE(t), 6 - (total - window.__qty[id]));
      };
    });
  });
}

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// Counts down to a server-decided deadline. Uses the monotonic clock so a wrong
// device clock can't make a hold look longer (or shorter) than it really is.
function startLockTicker(remainingMs, totalMs, onExpire) {
  clearInterval(lockTicker);
  const deadline = performance.now() + remainingMs;
  const tick = () => {
    const left = deadline - performance.now();
    const cd = $('#cd');
    const bar = $('#cdbar');
    if (cd) cd.textContent = clock(left);
    if (bar) {
      bar.style.width = `${Math.max(0, Math.min(100, (left / totalMs) * 100))}%`;
      bar.classList.toggle('low', left < 60000);
    }
    if (left <= 0) { clearInterval(lockTicker); onExpire(); }
  };
  tick();
  lockTicker = setInterval(tick, 250);
}

async function lockBanner() {
  clearInterval(bannerTimer);
  const el = $('#lock-banner');
  if (!el) return;
  el.hidden = true;
  const p = path().split('?')[0];
  if (!me || me.role === 'organizer' || p === '/checkout') return;
  let res;
  try { res = await api('/api/locks/active'); } catch { return; }
  const lock = res.lock;
  if (!lock || p === `/event/${lock.event_id}`) return;
  const deadline = performance.now() + lock.remainingMs;
  const paint = () => {
    const left = deadline - performance.now();
    if (left <= 0) { el.hidden = true; clearInterval(bannerTimer); return; }
    el.innerHTML = `<span><b>${esc(lock.event.name)}</b> · ${lock.quantity} ticket${lock.quantity === 1 ? '' : 's'} held for <b class="lb-time">${clock(left)}</b></span><a class="bt" href="#/checkout">Complete payment</a>`;
    el.hidden = false;
  };
  paint();
  bannerTimer = setInterval(paint, 1000);
}

async function viewCheckout() {
  if (!me) { navigate('/login?next=/checkout'); return; }
  app.innerHTML = `<main class="w page"><div class="skel" style="height:200px"></div></main>`;
  try {
    const lockInfo = await api('/api/locks/active');
    const lock = lockInfo.lock;
    if (!lock) {
      app.innerHTML = `<main class="w page"><div class="empty">No active reservation. Pick tickets on an event page first.</div></main>`;
      return;
    }
    const fee = Math.round(lock.subtotal_paise * 0.025);
    const total = lock.subtotal_paise + fee;
    const deadline = performance.now() + lock.remainingMs;
    const totalMs = lockInfo.lockMs || 300000;
    const paint = () => {
      const left = deadline - performance.now();
      if (left <= 0) {
        app.innerHTML = `<main class="w page"><div class="empty">Your 5-minute lock expired. Tickets were released back to the pool.</div><p><a class="bt" href="#/event/${lock.event_id}">Return to event</a></p></main>`;
        return false;
      }
      const cd = $('#pay-cd');
      if (cd) cd.textContent = clock(left);
      const bar = $('#cdbar');
      if (bar) { bar.style.width = `${Math.max(0, Math.min(100, (left / totalMs) * 100))}%`; bar.classList.toggle('low', left < 60000); }
      return true;
    };
    app.innerHTML = `<main class="w page" style="max-width:520px">
      <div class="wf">
      <div class="top">Checkout</div>
      <div class="lockbar"><div><b>Tickets reserved for you</b><div class="muted">Complete payment within <span id="pay-cd">${clock(lock.remainingMs)}</span></div><div class="lock-prog"><i id="cdbar"></i></div></div></div>
      <div class="muted">${esc(lock.event.name)}</div>
        ${lock.items.map((i) => `<div class="row"><span>${i.quantity} × ${esc(i.name)}</span><b>${rupee(i.quantity * i.price_paise)}</b></div>`).join('')}
        <div class="row"><span>Fees</span><b>${rupee(fee)}</b></div>
        <div class="row"><b>Total</b><b>${rupee(total)}</b></div>
        <div class="pills" id="paym"><button class="on" data-m="card">Card</button><button data-m="upi">UPI</button></div>
        <div id="payfields"></div>
        <button class="bt" id="pay">Pay ${rupee(total)}</button>
        <button class="bt o" id="release">Release tickets</button>
      </div>
    </main>`;
    const fields = () => {
      const m = $('#paym .on').dataset.m;
      $('#payfields').innerHTML = m === 'card'
        ? `<div class="field"><label>Name on card</label><input value="${esc(me.name)}"></div><div class="g2"><div class="field"><label>Card number</label><input inputmode="numeric" placeholder="4242 4242 4242 4242" maxlength="19"></div><div class="field"><label>Expiry / CVV</label><input placeholder="12/28 · 123"></div></div><p class="muted">Demo payment — no charge is sent to a processor.</p>`
        : `<div class="field"><label>UPI ID</label><input placeholder="ananya@okhdfcbank" value="ananya@okhdfcbank"></div><p class="muted">Demo UPI collect. Confirm to capture the booking.</p>`;
    };
    fields();
    $('#paym').onclick = (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      $('#paym').querySelectorAll('button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on'); fields();
    };
    paint();
    pollTimer = setInterval(paint, 250);
    $('#release').onclick = async () => {
      await api('/api/locks/' + lock.id, { method: 'DELETE' });
      toast('Tickets released');
      navigate('/event/' + lock.event_id);
    };
    $('#pay').onclick = async function () {
      this.classList.add('load'); this.disabled = true;
      try {
        const method = $('#paym .on').dataset.m;
        const { booking } = await api('/api/checkout', { method: 'POST', body: { lockId: lock.id, method } });
        navigate('/confirmed/' + booking.id);
      } catch (e) {
        toast(e.message);
        this.classList.remove('load'); this.disabled = false;
      }
    };
  } catch (e) {
    app.innerHTML = `<main class="w page"><div class="empty">${e.message}</div></main>`;
  }
}

function viewConfirm(booking) {
  app.innerHTML = `<main class="w page confirm" style="max-width:520px">
    <div class="wf play" id="w4">
      <div class="top"><span>Booking confirmed</span>
        <svg class="ck" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="var(--ok)" stroke-width="2"/><path d="M7 12.5l3.5 3.5L17 9" fill="none" stroke="var(--ok)" stroke-width="2.5" stroke-linecap="round"/></svg>
      </div>
      ${booking.items.map((i) => `<div class="row"><span>${i.quantity} × ${esc(i.name)}</span><b>${rupee(i.quantity * i.unit_price_paise)}</b></div>`).join('')}
      <div class="row"><span>Fees</span><b>${rupee(booking.fee_paise)}</b></div>
      <div class="row"><b>Total</b><b>${rupee(booking.amount_paise)}</b></div>
      <p class="okmsg">Smart Pass ready · ${booking.public_id}</p>
      <div class="tk" style="margin-top:6px">
        <div class="m"><b>${esc(booking.event.name)}</b><div class="muted">${fmtDate(booking.event.date, booking.event.time)}<br>Booking ${booking.public_id}</div><span class="chip c" style="margin-top:6px">Confirmed</span></div>
        <div class="s"><div class="qr"></div>${booking.tickets.length} ticket${booking.tickets.length > 1 ? 's' : ''}</div>
      </div>
      <div class="actions">
        <a class="bt" href="#/pass/${booking.tickets[0].id}">Open Smart Pass</a>
        <a class="bt o" href="#/bookings">View my bookings</a>
      </div>
      ${booking.tickets.length > 1 ? `<nav class="pills" aria-label="Your tickets">${booking.tickets.map((t, i) => `<a class="pill" href="#/pass/${t.id}">Ticket ${i + 1}</a>`).join('')}</nav>` : ''}
    </div>
  </main>`;
}

async function viewConfirmPage(id) {
  if (!me) { navigate('/login'); return; }
  const { booking } = await api('/api/bookings/' + id);
  viewConfirm(booking);
}

async function viewBookings() {
  if (!me) { navigate('/login?next=/bookings'); return; }
  app.innerHTML = `<main class="w page"><h2>My bookings</h2><div class="skel" style="height:80px"></div></main>`;
  const { bookings } = await api('/api/bookings');
  window.__bookings = bookings;
  const tab = (window.__btab || 'upcoming');
  const now = Date.now();
  const filtered = bookings.filter((b) => {
    const start = new Date(`${b.event.date}T${b.event.time}:00`).getTime();
    if (tab === 'cancelled') return b.status === 'cancelled';
    if (tab === 'past') return b.status !== 'cancelled' && (start < now || b.tickets.every((t) => t.status === 'used'));
    return b.status === 'confirmed' && start >= now && b.tickets.some((t) => t.status === 'confirmed');
  });
  app.innerHTML = `<main class="w page">
    <div class="wf">
    <div class="top">My bookings</div>
    <div class="pills" id="btabs">
      <button data-t="upcoming" class="${tab === 'upcoming' ? 'on' : ''}">Upcoming</button>
      <button data-t="past" class="${tab === 'past' ? 'on' : ''}">Past</button>
      <button data-t="cancelled" class="${tab === 'cancelled' ? 'on' : ''}">Cancelled</button>
    </div>
    <div style="display:grid;gap:10px;margin-top:12px">
      ${filtered.length ? filtered.map((b) => {
        const st = b.status === 'cancelled' ? 'cancelled' : (b.tickets.every((t) => t.status === 'used') ? 'used' : 'confirmed');
        const open = b.tickets.find((t) => t.status === 'confirmed') || b.tickets[0];
        return `<div class="tk">
          <div class="m"><b>${esc(b.event.name)}</b><div class="muted">${fmtDate(b.event.date, b.event.time)} · ${b.public_id}</div>
            <div class="muted">${esc(b.items.map((i) => i.quantity + ' × ' + i.name).join(', '))} · ${rupee(b.amount_paise)}</div>
            ${chip(st)}</div>
          <div class="s">${st === 'confirmed' ? `<a href="#/pass/${open.id}">Open</a>` : st === 'used' ? 'Receipt' : 'Refund'}</div>
        </div>`;
      }).join('') : `<div class="empty">No bookings yet. Browse events</div>`}
    </div>
    </div>
  </main>`;
  $('#btabs').onclick = (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    window.__btab = b.dataset.t;
    viewBookings();
  };
}

async function viewLogin() {
  const next = new URLSearchParams(path().split('?')[1] || location.hash.split('?')[1] || '').get('next') || '';
  const state = { role: 'customer', mode: 'signin' };
  const paint = () => {
    app.innerHTML = `<main class="w page"><div class="two">
      <div class="wf" style="max-width:380px">
        <div class="top">EventPass</div>
        <div class="pills" id="role"><button data-r="customer" class="${state.role === 'customer' ? 'on' : ''}">Attendee</button><button data-r="organizer" class="${state.role === 'organizer' ? 'on' : ''}">Organizer</button></div>
        <div class="pills" id="mode"><button data-m="signin" class="${state.mode === 'signin' ? 'on' : ''}">Sign in</button><button data-m="register" class="${state.mode === 'register' ? 'on' : ''}">Create account</button></div>
        ${state.mode === 'register' ? `<div class="field"><label>Full name</label><input id="name"><div class="hint"></div></div>` : ''}
        <div class="field"><label>Email</label><input id="email" type="email" autocomplete="username"><div class="hint" id="eh"></div></div>
        <div class="field"><label>Password</label><input id="password" type="password" autocomplete="current-password"><div class="hint"></div></div>
        <div class="err" id="formerr"></div>
        <button class="bt" id="go">${state.mode === 'signin' ? 'Sign in' : 'Create account'}</button>
        <div class="demo">Demo attendee: ananya.sharma@eventpass.in<br>Demo organizer: priya.mehta@eventpass.in<br>Password: EventPass@2026</div>
      </div>
      <div>
        <h2>One login. The role decides the desk.</h2>
        <p class="lead">Attendees book and carry a Smart Pass. Organizers run capacity, pricing insight, and door check-in.</p>
      </div>
    </div></main>`;
    $('#role').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; state.role = b.dataset.r; paint(); };
    $('#mode').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; state.mode = b.dataset.m; paint(); };
    $('#go').onclick = async function () {
      const email = $('#email').value.trim();
      const password = $('#password').value;
      const name = $('#name') ? $('#name').value.trim() : '';
      $('#eh').textContent = /@/.test(email) ? '' : 'Enter a valid email, like name@mail.com';
      if (!/@/.test(email) || password.length < 8 || (state.mode === 'register' && name.length < 2)) {
        $('#formerr').textContent = 'Check the highlighted fields.';
        return;
      }
      this.classList.add('load'); this.disabled = true;
      try {
        const url = state.mode === 'signin' ? '/api/auth/login' : '/api/auth/register';
        const { user } = await api(url, { method: 'POST', body: { email, password, name, role: state.role } });
        me = user;
        toast(state.mode === 'signin' ? 'Signed in' : 'Account created');
        if (next) navigate(next);
        else navigate(user.role === 'organizer' ? '/organizer' : '/');
      } catch (err) {
        $('#formerr').textContent = err.message;
        this.classList.remove('load'); this.disabled = false;
      }
    };
  };
  paint();
}

async function viewAccount() {
  if (!me) { navigate('/login'); return; }
  app.innerHTML = `<main class="w page" style="max-width:480px">
    <h2>Account</h2>
    <div class="wf">
      <div class="field"><label>Name</label><input id="nm" value="${esc(me.name)}"></div>
      <div class="field"><label>Email</label><input value="${esc(me.email)}" disabled></div>
      <div class="field"><label>Phone</label><input id="ph" value="${esc(me.phone || '')}"></div>
      <p class="muted">Role: ${me.role}</p>
      <button class="bt" id="save">Save profile</button>
    </div>
  </main>`;
  $('#save').onclick = async function () {
    try {
      const { user } = await api('/api/auth/profile', { method: 'PUT', body: { name: $('#nm').value, phone: $('#ph').value } });
      me = user; toast('Profile saved'); render();
    } catch (e) { toast(e.message); }
  };
}

function typeEditor(types) {
  return types.map((t, i) => `<div class="g3 trow">
    <input data-k="name" data-i="${i}" value="${esc(t.name)}" placeholder="Ticket type">
    <input data-k="price" data-i="${i}" type="number" min="0" value="${t.price ?? Math.round(t.price_paise / 100)}" placeholder="Price ₹">
    <input data-k="capacity" data-i="${i}" type="number" min="1" value="${t.capacity}" placeholder="Capacity">
  </div>`).join('');
}

async function viewEventForm(id) {
  let event = {
    name: '', description: '', category: 'Workshops', date: '', time: '19:00', venue: '', address: '', city: '', image_key: 'tech',
    ticketTypes: [
      { name: 'Early Bird', price: 999, capacity: 50 },
      { name: 'General Admission', price: 1499, capacity: 200 },
      { name: 'VIP', price: 3499, capacity: 40 },
    ],
  };
  if (id) {
    const d = await api(`/api/organizer/events/${id}`);
    event = { ...d.event, ticketTypes: d.event.ticketTypes.map((t) => ({ id: t.id, name: t.name, price: Math.round(t.price_paise / 100), capacity: t.capacity })) };
  }
  const paint = () => {
    app.innerHTML = `<main class="w page" style="max-width:720px">
      <h2>${id ? 'Edit event' : 'New event'}</h2>
      <div class="steps"><b>Details</b>›<b>Tickets</b>›<b>Review</b></div>
      <div class="wf">
        <div class="field"><label>Event name</label><input id="en" value="${esc(event.name)}"></div>
        <div class="field"><label>Description</label><textarea id="ed" rows="4">${esc(event.description)}</textarea></div>
        <div class="g2">
          <div class="field"><label>Date</label><input id="da" type="date" value="${event.date}"></div>
          <div class="field"><label>Time</label><input id="tm" type="time" value="${event.time}"></div>
        </div>
        <div class="field"><label>Venue</label><input id="ve" value="${esc(event.venue)}"></div>
        <div class="field"><label>Address</label><input id="ad" value="${esc(event.address)}"></div>
        <div class="g2">
          <div class="field"><label>City</label><input id="ci" value="${esc(event.city)}"></div>
          <div class="field"><label>Category</label>
            <select id="ca">${['Music', 'Comedy', 'Workshops'].map((c) => `<option ${event.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
          </div>
        </div>
        <div id="types">${typeEditor(event.ticketTypes)}</div>
        <button class="bt o" type="button" id="addt">+ Add ticket type</button>
        <div class="err" id="ferr"></div>
        <div class="row"><button class="bt" id="pub">${id ? 'Save event' : 'Publish event'}</button>
          ${id ? '<button class="bt o" id="del">Delete</button>' : ''}</div>
      </div>
    </main>`;
    const read = () => {
      event.name = $('#en').value; event.description = $('#ed').value; event.date = $('#da').value; event.time = $('#tm').value;
      event.venue = $('#ve').value; event.address = $('#ad').value; event.city = $('#ci').value; event.category = $('#ca').value;
      app.querySelectorAll('.trow').forEach((row, i) => {
        event.ticketTypes[i] = event.ticketTypes[i] || {};
        event.ticketTypes[i].name = $('[data-k=name]', row).value;
        event.ticketTypes[i].price = Number($('[data-k=price]', row).value);
        event.ticketTypes[i].capacity = Number($('[data-k=capacity]', row).value);
      });
    };
    $('#addt').onclick = () => { read(); event.ticketTypes.push({ name: 'Premium', price: 2499, capacity: 30 }); paint(); };
    $('#pub').onclick = async () => {
      read();
      try {
        if (id) await api('/api/organizer/events/' + id, { method: 'PUT', body: event });
        else {
          const created = await api('/api/organizer/events', { method: 'POST', body: event });
          id = created.event.id;
        }
        toast('Event published');
        navigate('/organizer/events/' + id);
      } catch (e) { $('#ferr').textContent = e.message; }
    };
    const del = $('#del');
    if (del) del.onclick = async () => {
      if (!confirm('Delete this event?')) return;
      try { await api('/api/organizer/events/' + id, { method: 'DELETE' }); toast('Deleted'); navigate('/organizer/events'); }
      catch (e) { $('#ferr').textContent = e.message; }
    };
  };
  paint();
}

const routes = [
  [/^\/$/, viewHome],
  [/^\/events$/, () => viewBrowse()],
  [/^\/event\/(\d+)$/, (m) => viewEvent(m[1])],
  [/^\/checkout$/, viewCheckout],
  [/^\/confirmed\/(\d+)$/, (m) => viewConfirmPage(m[1])],
  [/^\/bookings$/, viewBookings],
  [/^\/pass\/(\d+)$/, (m) => viewPass(m[1])],
  [/^\/login/, viewLogin],
  [/^\/account$/, viewAccount],
  [/^\/organizer$/, viewOrgDash],
  [/^\/organizer\/events$/, viewOrgEvents],
  [/^\/organizer\/events\/new$/, () => viewEventForm()],
  [/^\/organizer\/events\/(\d+)\/edit$/, (m) => viewEventForm(m[1])],
  [/^\/organizer\/events\/(\d+)$/, (m) => viewOrgEvent(m[1])],
  [/^\/organizer\/scanner/, viewScanner],
];

async function render() {
  stopTimers();
  try { me = (await api('/api/auth/me')).user; } catch { me = null; }
  nav();
  lockBanner();
  const p = path().split('?')[0];
  const hit = routes.find(([re]) => re.test(p));
  if (!hit) {
    app.innerHTML = `<main class="w page"><div class="empty">Page not found. <a href="#/">Home</a></div></main>`;
    return;
  }
  const m = p.match(hit[0]);
  try { await hit[1](m); }
  catch (e) { app.innerHTML = `<main class="w page"><div class="empty">${e.message}</div></main>`; }
}

window.addEventListener('hashchange', render);
render();

/* Organizer check-in. Camera scan or pasted payload -> server verifies -> buyer details. */

const SCAN_STYLE = {
  ok:          { cls: 'scan-ok',   icon: '✓', title: 'Ticket verified' },
  used:        { cls: 'scan-used', icon: '!', title: 'Already used' },
  expired:     { cls: 'scan-bad',  icon: '✕', title: 'Expired pass' },
  invalid:     { cls: 'scan-bad',  icon: '✕', title: 'Invalid QR' },
  wrong_event: { cls: 'scan-bad',  icon: '✕', title: 'Wrong event' },
  cancelled:   { cls: 'scan-bad',  icon: '✕', title: 'Ticket cancelled' },
  static:      { cls: 'scan-info', icon: 'i', title: 'Identity confirmed, not for entry' },
};

async function viewScanner() {
  const { events } = await api('/api/organizer/events');
  if (!events.length) {
    app.innerHTML = `<main class="w page"><div class="empty">Create an event first, then come back to check people in.</div></main>`;
    return;
  }
  const qe = new URLSearchParams((path().split('?')[1] || '')).get('event');
  const eventId = Number(qe) || events[0].id;

  app.innerHTML = `<main class="w page" style="max-width:460px">
    <div class="wf">
      <div class="top">Check-in</div>
      <div class="field"><label for="ev">Event</label>
        <select id="ev">${events.map((e) => `<option value="${e.id}" ${e.id === eventId ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></div>
      <div class="scan-stats" id="sstats" aria-live="polite"></div>
      <div class="scan" id="reader"></div>
      <div id="rs" class="res" role="status" aria-live="assertive" style="color:var(--mu)">Ready to scan</div>
      <div class="field"><label for="manual">Or paste pass payload</label><input id="manual" placeholder="EP2.…" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
      <button class="bt" id="sc">Verify pass</button>
      <h4 style="margin:10px 0 0">Recent scans</h4>
      <ul class="plist scan-log" id="slog"><li class="muted">Nothing scanned yet.</li></ul>
    </div>
  </main>`;

  const log = [];
  let busy = false;
  let cooldownUntil = 0;
  let lastPayload = '';
  let lastPayloadAt = 0;

  const paintStats = (s) => {
    if (!s) return;
    $('#sstats').innerHTML = `<div><b>${s.checkedIn}</b><span>checked in of ${s.total}</span></div><div class="${s.blocked ? 'warn' : ''}"><b>${s.blocked}</b><span>blocked</span></div>`;
  };
  const paintLog = () => {
    $('#slog').innerHTML = log.length ? log.slice(0, 6).map((l) => `<li><span class="scan-pill ${SCAN_STYLE[l.result].cls}">${SCAN_STYLE[l.result].icon}</span> <b>${esc(l.who)}</b> <span class="muted">${esc(SCAN_STYLE[l.result].title)} · ${l.time}</span></li>`).join('') : '<li class="muted">Nothing scanned yet.</li>';
  };

  const show = (data) => {
    const st = SCAN_STYLE[data.result] || SCAN_STYLE.invalid;
    const rs = $('#rs');
    const a = data.attendee;
    rs.style.animation = 'none'; void rs.offsetWidth; rs.style.animation = '';
    rs.className = `res scan-result ${st.cls}`;
    rs.style.color = '';
    rs.innerHTML = `
      <div class="sr-head"><span class="sr-icon" aria-hidden="true">${st.icon}</span><div><b>${esc(data.message || st.title)}</b>${data.detail ? `<div class="sr-detail">${esc(data.detail)}</div>` : ''}</div></div>
      ${a ? `<dl class="sr-buyer">
        <div><dt>Buyer</dt><dd>${esc(a.holder)}</dd></div>
        <div><dt>Ticket</dt><dd>${esc(a.ticketType)} · ${a.ticketNumber} of ${a.ticketsInBooking}</dd></div>
        <div><dt>Booking</dt><dd>${esc(a.bookingId)}</dd></div>
        ${a.phone ? `<div><dt>Phone</dt><dd>${esc(a.phone)}</dd></div>` : ''}
        ${a.email ? `<div><dt>Email</dt><dd>${esc(a.email)}</dd></div>` : ''}
      </dl>` : ''}`;
    if (navigator.vibrate) navigator.vibrate(data.result === 'ok' ? 60 : [120, 60, 120]);
    paintStats(data.stats);
    log.unshift({ result: data.result in SCAN_STYLE ? data.result : 'invalid', who: a ? a.holder : 'Unknown QR', time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) });
    paintLog();
  };

  const verify = async (payload, { manual = false } = {}) => {
    payload = String(payload || '').trim();
    if (!payload || busy) return;
    const now = Date.now();
    // A camera reports the same QR on every frame. Without this, the first
    // "Ticket verified" would be overwritten a split second later by "Already used".
    if (!manual && (now < cooldownUntil || (payload === lastPayload && now - lastPayloadAt < 15000))) return;
    busy = true;
    lastPayload = payload; lastPayloadAt = now;
    try {
      const data = await api('/api/organizer/checkin', { method: 'POST', body: { eventId: Number($('#ev').value), payload } });
      show(data);
    } catch (e) {
      show({ result: 'invalid', message: e.message || 'Could not reach the server' });
    } finally {
      busy = false;
      cooldownUntil = Date.now() + 2200;
    }
  };

  $('#sc').onclick = () => { verify($('#manual').value, { manual: true }); };
  $('#manual').onkeydown = (e) => { if (e.key === 'Enter') verify($('#manual').value, { manual: true }); };
  $('#ev').onchange = () => { lastPayload = ''; cooldownUntil = 0; $('#rs').className = 'res'; $('#rs').textContent = 'Ready to scan'; refreshStats(); };

  async function refreshStats() {
    try { paintStats((await api(`/api/organizer/events/${$('#ev').value}`)).scan); } catch { /* non-critical */ }
  }
  refreshStats();

  if (window.Html5Qrcode) {
    scanner = new Html5Qrcode('reader');
    Html5Qrcode.getCameras().then((cams) => {
      const cam = cams.find((c) => /back|rear|environment/i.test(c.label)) || cams[0];
      if (!cam) throw new Error('no camera');
      return scanner.start(cam.id, { fps: 8, qrbox: 200 }, (txt) => { verify(txt); });
    }).catch(() => {
      const r = $('#reader');
      if (r) r.innerHTML = '<span class="muted" style="padding:12px;text-align:center">Camera unavailable (it needs HTTPS or localhost and permission). Paste a payload below.</span>';
    });
  } else {
    $('#reader').innerHTML = '<span class="muted" style="padding:12px;text-align:center">Scanner library did not load. Paste a payload below.</span>';
  }
}

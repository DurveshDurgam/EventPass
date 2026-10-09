/* Smart Pass: the attendee's ticket. Rolling QR (refreshes every 15s) plus a
   downloadable pass image that carries a static, entry-invalid verification QR. */

function qrLibReady() {
  return typeof QRCode !== 'undefined' && typeof QRCode.toCanvas === 'function';
}

async function viewPass(id) {
  if (!me) { navigate('/login'); return; }
  app.innerHTML = `<main class="w page pass"><div class="skel" style="height:420px"></div></main>`;
  const data = await api(`/api/tickets/${id}`);
  const { ticket, event, holder, siblings } = data;
  const live = ticket.status === 'confirmed';
  const position = siblings.findIndex((s) => s.id === ticket.id) + 1;

  app.innerHTML = `<main class="w page pass">
    <article class="pass-card ${live ? 'is-live' : 'is-off'}" aria-label="Smart Pass">
      <header class="pass-head">
        <span class="pass-brand">EventPass · Smart Pass</span>
        ${chip(ticket.status)}
      </header>
      <h2 class="pass-event">${esc(event.name)}</h2>
      <p class="pass-when">${esc(fmtDate(event.date, event.time))}<br>${esc(event.venue)}</p>

      <div class="pass-buyer">
        <span class="pass-label">ATTENDEE</span>
        <b class="pass-name">${esc(holder.name)}</b>
        <span class="pass-sub">${esc(ticket.ticket_type)} · Ticket ${position} of ${siblings.length}</span>
      </div>

      <div class="qr-wrap" id="qrwrap">
        <div id="qrbox" class="qr-box" aria-live="polite"></div>
        ${live ? '<span class="qr-live" aria-hidden="true"><i></i>LIVE <b id="qrclock">--:--:--</b></span><span class="qr-sweep" aria-hidden="true"></span>' : ''}
      </div>
      <div class="qr-timer" ${live ? '' : 'hidden'}>
        <div class="qr-bar" aria-hidden="true"><i id="qrbar"></i></div>
        <span id="qrcd" class="muted">${live ? 'Loading live QR…' : ''}</span>
      </div>
      <p id="qrnote" class="muted pass-note">${live ? 'This QR holds your name, ticket and booking, signed, and changes every 15 seconds. A screenshot stops working almost immediately.' : ''}</p>

      <dl class="pass-ids">
        <div><dt>Ticket</dt><dd>${esc(ticket.public_id)}</dd></div>
        <div><dt>Booking</dt><dd>${esc(ticket.booking_public_id)}</dd></div>
      </dl>

      ${siblings.length > 1 ? `<nav class="pills no-print" aria-label="Tickets in this booking">${siblings.map((s, i) =>
        `<a class="pill ${s.id === ticket.id ? 'on' : ''}" href="#/pass/${s.id}">Ticket ${i + 1} ${s.status === 'used' ? '✓' : s.status === 'cancelled' ? '✕' : ''}</a>`).join('')}</nav>` : ''}

      <div class="actions no-print">
        <button class="bt" id="dl">Download pass</button>
        <button class="bt o" id="print">Print</button>
        ${live ? `<button class="bt o" id="cancel">Cancel booking</button>` : ''}
        <a class="bt o" href="#/bookings">Back</a>
      </div>
      <p class="muted no-print pass-note">The downloaded pass is a verification copy. It proves who bought the ticket, but only the live QR on this screen gets you in.</p>
    </article>
  </main>`;

  $('#print').onclick = () => window.print();
  $('#dl').onclick = async function () {
    this.disabled = true;
    try { await downloadPassImage({ ticket, event, holder, position, total: siblings.length }); }
    catch (e) { toast(e.message || 'Could not build the pass image.'); }
    this.disabled = false;
  };
  const cancel = $('#cancel');
  if (cancel) cancel.onclick = async () => {
    if (!confirm('Cancel this booking and release the seats?')) return;
    try {
      await api(`/api/bookings/${ticket.booking_id}/cancel`, { method: 'POST', body: {} });
      toast('Booking cancelled');
      viewPass(id);
    } catch (e) { toast(e.message); }
  };

  if (!live) {
    $('#qrbox').innerHTML = `<div class="qr-off">${ticket.status === 'used' ? '<b>✓ Checked in</b><span>Entry recorded</span>' : '<b>Cancelled</b><span>This pass cannot be scanned</span>'}</div>`;
    return;
  }
  runRollingQr(id);
}

function runRollingQr(id) {
  const box = $('#qrbox');
  let deadline = 0;
  let period = 15000;
  let busy = false;

  const clockEl = $('#qrclock');
  const paintClock = () => { if (clockEl) clockEl.textContent = new Date().toLocaleTimeString('en-GB'); };

  async function refresh() {
    if (busy || path() !== '/pass/' + id) return;
    busy = true;
    const started = performance.now();
    try {
      const q = await api(`/api/tickets/${id}/qr`);
      if (!q.active) {
        box.innerHTML = `<div class="qr-off"><b>${q.status === 'used' ? '✓ Checked in' : 'Inactive'}</b><span>${q.status === 'used' ? 'Entry recorded' : 'This pass cannot be scanned'}</span></div>`;
        clearInterval(qrTimer);
        const t = $('.qr-timer'); if (t) t.hidden = true;
        return;
      }
      if (!qrLibReady()) {
        box.innerHTML = '<div class="qr-off"><b>QR library unavailable</b><span>Check your connection and reload.</span></div>';
        return;
      }
      period = q.periodMs || 15000;
      // Count from when we asked, not when the answer arrived: we may refresh a
      // few ms early, never late.
      deadline = started + q.remainingMs;
      const canvas = document.createElement('canvas');
      await QRCode.toCanvas(canvas, q.payload, { width: 264, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#3A2E1F', light: '#FFFEF7' } });
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', 'Live entry QR code');
      box.replaceChildren(canvas);
    } catch (e) {
      const cd = $('#qrcd'); if (cd) cd.textContent = 'Reconnecting…';
      deadline = performance.now() + 2000;
    } finally {
      busy = false;
    }
  }

  const tick = () => {
    paintClock();
    const left = deadline - performance.now();
    const bar = $('#qrbar');
    const cd = $('#qrcd');
    if (!bar || !cd) return;
    if (left <= 0) { if (!busy) refresh(); return; }
    bar.style.width = `${Math.max(0, Math.min(100, (left / period) * 100))}%`;
    cd.textContent = `New code in ${Math.ceil(left / 1000)}s`;
  };

  refresh().then(() => {
    clearInterval(qrTimer);
    qrTimer = setInterval(tick, 200);
    tick();
  });
}

/* ---------- downloadable pass image ---------- */

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapText(ctx, text, x, y, maxW, lineH, maxLines = 3) {
  const words = String(text).split(/\s+/);
  let line = '';
  let lines = 0;
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, y); y += lineH; lines += 1; line = w;
      if (lines >= maxLines - 1) break;
    } else line = test;
  }
  ctx.fillText(line, x, y);
  return y + lineH;
}

async function downloadPassImage({ ticket, event, holder, position, total }) {
  if (!qrLibReady()) throw new Error('QR library did not load. Check your connection.');
  const { payload } = await api(`/api/tickets/${ticket.id}/receipt`);
  const qrCanvas = document.createElement('canvas');
  await QRCode.toCanvas(qrCanvas, payload, { width: 440, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#3A2E1F', light: '#FFFEF7' } });

  const W = 900, H = 1380, P = 64;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const D = "'Bricolage Grotesque','Segoe UI',system-ui,sans-serif";
  const B = "'Figtree','Segoe UI',system-ui,sans-serif";
  const INK = '#3A2E1F', MU = '#6B5E47', LN = '#ccd5ae', OR = '#d4a373';

  g.fillStyle = '#fefae0'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#FFFEF7'; roundRect(g, 28, 28, W - 56, H - 56, 36); g.fill();
  g.lineWidth = 3; g.strokeStyle = LN; g.stroke();
  g.fillStyle = OR; g.save(); roundRect(g, 28, 28, W - 56, 120, 36); g.clip(); g.fillRect(28, 28, W - 56, 120); g.restore();

  g.fillStyle = INK; g.textBaseline = 'alphabetic';
  g.font = `800 34px ${D}`; g.fillText('EventPass', P, 100);
  g.font = `700 22px ${B}`; g.textAlign = 'right'; g.fillText('VERIFICATION COPY', W - P, 98); g.textAlign = 'left';

  let y = 230;
  g.font = `800 58px ${D}`;
  y = wrapText(g, event.name, P, y, W - P * 2, 66, 3) + 4;
  g.fillStyle = MU; g.font = `500 28px ${B}`;
  g.fillText(fmtDate(event.date, event.time), P, y); y += 40;
  y = wrapText(g, event.venue, P, y, W - P * 2, 38, 2) + 18;

  g.strokeStyle = LN; g.setLineDash([12, 10]); g.lineWidth = 3;
  g.beginPath(); g.moveTo(P, y); g.lineTo(W - P, y); g.stroke(); g.setLineDash([]);
  y += 54;

  g.fillStyle = MU; g.font = `800 20px ${B}`; g.fillText('ATTENDEE', P, y); y += 52;
  g.fillStyle = INK; g.font = `800 50px ${D}`;
  y = wrapText(g, holder.name, P, y, W - P * 2, 56, 2);
  g.fillStyle = MU; g.font = `500 28px ${B}`;
  g.fillText(`${ticket.ticket_type} · Ticket ${position} of ${total}`, P, y); y += 30;

  const qx = (W - 440) / 2, qy = y + 24;
  g.fillStyle = '#FFFEF7'; roundRect(g, qx - 20, qy - 20, 480, 480, 20); g.fill();
  g.lineWidth = 3; g.strokeStyle = LN; g.stroke();
  g.drawImage(qrCanvas, qx, qy, 440, 440);

  let fy = qy + 440 + 70;
  g.textAlign = 'center';
  g.fillStyle = INK; g.font = `700 26px ${B}`;
  g.fillText(`${ticket.public_id}  ·  ${ticket.booking_public_id}`, W / 2, fy); fy += 44;
  g.fillStyle = MU; g.font = `500 22px ${B}`;
  g.fillText('This copy confirms who bought the ticket. It is not valid for entry.', W / 2, fy); fy += 32;
  g.fillText('Open the live Smart Pass in EventPass at the door.', W / 2, fy);

  const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
  if (!blob) throw new Error('Could not create the image.');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `EventPass-${ticket.public_id}.png`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('Pass downloaded');
}

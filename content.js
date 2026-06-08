(function () {
  'use strict';
  if (window.__wsReadable) return;            // don't double-inject
  window.__wsReadable = true;

  const SENTINEL = 'T2SESSION_EXPIRED';
  const num = m => (m && m[1] != null) ? parseFloat(String(m[1]).replace(/,/g, '')) : null;
  const f = n => (n == null || isNaN(n)) ? '--' : Math.round(n).toLocaleString('en-US');
  const mdy = d => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
  // North Ogden secondary (irrigation) water shut-off. month is 0-indexed (9 = October).
  // asOf = when this date was last confirmed. The auto-update can overwrite this at runtime.
  const SHUTOFF = { month: 9, day: 15, asOf: '2026-06-08', source: 'North Ogden City' };

  // Remotely-updatable shut-off date. The extension re-checks this small file at most every
  // ~2 weeks and caches it, so a single edit updates every installed copy. Falls back to the
  // default above if the file is ever unreachable.
  const CONFIG_URL = 'https://raw.githubusercontent.com/notifydesign/readable-water-budget/main/config.json';
  const CONFIG_TTL = 14 * 864e5;
  const store = {
    get(k) { return new Promise(res => {
      try { if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) return chrome.storage.local.get(k, o => res(o[k])); } catch (e) {}
      try { return res(JSON.parse(localStorage.getItem(k))); } catch (e) { return res(null); }
    }); },
    set(k, v) {
      try { if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) { chrome.storage.local.set({ [k]: v }); return; } } catch (e) {}
      try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
    }
  };
  async function loadShutoffConfig() {
    let cached = null;
    try { cached = await store.get('wsbShutoff'); } catch (e) {}
    if (cached && cached.month != null) Object.assign(SHUTOFF, cached);     // apply cached instantly
    const fresh = cached && cached.fetchedAt && (Date.now() - cached.fetchedAt) < CONFIG_TTL;
    if (!fresh) {
      try {
        const j = await (await fetch(CONFIG_URL, { cache: 'no-store' })).json();
        const s = j.shutoff || j;
        if (s && s.month && s.day) {
          const next = { month: s.month - 1, day: s.day, asOf: s.asOf || SHUTOFF.asOf, source: s.source || SHUTOFF.source, fetchedAt: Date.now() };
          Object.assign(SHUTOFF, next);
          store.set('wsbShutoff', next);
        }
      } catch (e) { /* unreachable: keep cached/default */ }
    }
  }

  // ---------- data layer ----------
  async function getText(url, opts) {
    const r = await fetch(url, Object.assign({ credentials: 'include' }, opts || {}));
    return r.text();
  }

  function parseBudget(html) {
    if (!html || html.indexOf(SENTINEL) !== -1) return null;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const t = doc.body.textContent.replace(/\s+/g, ' ');
    const dates = t.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
    let daysInCycle = 30, cycleStart = null;
    if (dates) {
      cycleStart = new Date(dates[1]);
      const end = new Date(dates[2]);
      daysInCycle = Math.round((end - cycleStart) / 864e5) + 1;
    }
    const perEl = doc.getElementById('waterBudgetPer');
    return {
      cycleUsed:    num(t.match(/used\s+([\d.,]+)\s*G\s+so far this cycle/i)),
      cyclePct:     perEl ? parseFloat(perEl.textContent) : num(t.match(/which is\s+([\d.]+)\s*%\s+of your water budget/i)),
      daysIn:       num(t.match(/You are\s+([\d.]+)\s+days into this cycle/i)),
      irrigation:   num(t.match(/used\s+([\d.,]+)\s*G\s+for Irrigation/i)),
      dailyTarget:  num(t.match(/Daily Target\s*([\d.,]+)\s*G/i)),
      last24:       num(t.match(/Last 24 Hr\s*([\d.,]+)\s*G/i)),
      cycleBudget:  num(t.match(/Cycle Budget\s*([\d.,]+)\s*G/i)),
      daysInCycle, cycleStart
    };
  }

  function parseAnnual(html) {
    if (!html) return {};
    return {
      annualBudget: num(html.match(/Annual Water Budget<\/span>\s*<p[^>]*>\s*([\d.,]+)/i)),
      annualUsed:   num(html.match(/Consumed Water Budget<\/span>\s*<p[^>]*>\s*([\d.,]+)/i))
    };
  }

  function tsOf(s) { const m = /(\d+)/.exec(s || ''); return m ? parseInt(m[1]) : null; }

  async function fetchDay(date, acct, meter) {
    const body = new URLSearchParams({
      numberOfDays: '1', startLogDate: mdy(date), endLogDate: mdy(date),
      AccountId: acct, MeterId: meter, sort: '', group: '', filter: ''
    });
    const txt = await getText('/Consumer/Consumption/ConsumptionHistoryDataClaculation', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
      body: body.toString()
    });
    if (!txt || txt.indexOf(SENTINEL) !== -1 || txt.trim()[0] !== '[') return null;
    try { return JSON.parse(txt); } catch (e) { return null; }
  }

  async function fetchCycleConsumption(cycleStart, acct, meter) {
    const start = cycleStart ? new Date(cycleStart) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const today = new Date();
    const days = [];
    for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) days.push(new Date(d));
    const results = await Promise.all(days.map(d => fetchDay(d, acct, meter).then(rows => ({ d, rows }))));

    const daily = [];
    let leakGal = 0, bestDay = null, bestTotal = -1;
    for (const { d, rows } of results) {
      if (!rows) { daily.push({ date: d, total: 0, irr: 0, missing: true }); continue; }
      let total = 0, irr = 0;
      for (const r of rows) {
        total += r.dailyLog || 0; irr += r.Irrigation || 0;
        leakGal += (r.Leak || 0) + (r.IntermittentLeak || 0);
      }
      daily.push({ date: d, total, irr });
      if (total > bestTotal) { bestTotal = total; bestDay = { d, rows }; }
    }
    // sprinkler runs for the heaviest day
    let runs = [], maxLabel = '';
    if (bestDay && bestDay.rows) {
      maxLabel = bestDay.d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
      let cur = null;
      const sorted = bestDay.rows.slice().sort((a, b) => (tsOf(a.ConsumptionChartDate) || 0) - (tsOf(b.ConsumptionChartDate) || 0));
      for (const r of sorted) {
        const fr = r.flowRate || 0, when = new Date(tsOf(r.ConsumptionChartDate));
        if (fr > 0.5) {
          if (!cur) cur = { start: when, end: when, gal: 0, peak: 0 };
          cur.end = when; cur.gal += r.dailyLog || 0; cur.peak = Math.max(cur.peak, fr);
        } else { if (cur && cur.gal > 1) runs.push(cur); cur = null; }
      }
      if (cur && cur.gal > 1) runs.push(cur);
    }
    return { daily, leakGal, runs, maxLabel };
  }

  // ---------- view ----------
  const RT = (typeof chrome!=='undefined' && chrome.runtime && chrome.runtime.getURL) ? (p=>chrome.runtime.getURL(p)) : (p=>p);
  const FONT_CSS = [400,600,700,800].map(w=>`@font-face{font-family:'Inter';font-style:normal;font-weight:${w};font-display:swap;src:url('${RT('fonts/Inter-'+w+'.woff2')}') format('woff2')}`).join('');
  const STYLE = FONT_CSS + `
  :host{all:initial}
  *{box-sizing:border-box;font-family:'Inter',-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
  .scrim{position:fixed;inset:0;background:rgba(30,41,59,.5);z-index:2147483646;display:flex;justify-content:center;overflow:auto;padding:28px 16px}
  .wrap{width:100%;max-width:1020px;margin:auto 0;color:#1A2230}
  .serif{font-weight:700}
  .mono{font-variant-numeric:tabular-nums;font-weight:700}
  .muted{color:#6B7685}
  .panel{background:#EDF1F7;border-radius:20px;padding:24px;box-shadow:0 20px 60px rgba(15,23,42,.4)}
  header{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;padding-bottom:18px;margin-bottom:18px;border-bottom:1px solid #DDE3EC;flex-wrap:wrap}
  .brand{display:flex;align-items:center;gap:11px}
  .drop{width:24px;height:24px;color:#2563EB}
  h1{font-size:20px;margin:0;font-weight:700}
  .sub{font-size:12.5px;margin-top:2px}
  .x{cursor:pointer;border:1px solid #DDE3EC;background:#fff;border-radius:9px;font-size:13px;padding:7px 11px;color:#1A2230;font-weight:500}
  .x:hover{background:#F8FAFC}
  .grid{display:grid;gap:14px}
  .card{background:#fff;border:1px solid #E4E9F0;border-radius:16px;padding:20px 22px;box-shadow:0 1px 2px rgba(15,23,42,.04),0 8px 24px rgba(15,23,42,.06)}
  .ttl{font-size:14px;letter-spacing:0;text-transform:none;color:#6B7685;margin:0 0 12px;font-weight:600}
  .hero .head{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px}
  .big{font-size:54px;line-height:1;font-weight:800;letter-spacing:-.02em}
  .of{font-size:19px;color:#6B7685;font-weight:700}
  .verdict{display:inline-flex;align-items:center;gap:7px;font-size:13.5px;font-weight:700;padding:6px 13px;border-radius:30px}
  .v-off{background:#FEE7E0;color:#E2451E}.v-on{background:#DCFCE7;color:#16A34A}
  .bar{position:relative;height:18px;background:#E1E7F0;border-radius:10px;margin:38px 0 8px}
  .bar .fill{height:100%;border-radius:10px}
  .bar .mark{position:absolute;top:-7px;width:2px;height:32px;background:#1A2230;opacity:.5}
  .bar .mark span{position:absolute;top:-18px;left:50%;transform:translateX(-50%);white-space:nowrap;font-size:10px;color:#6B7685;font-weight:600}
  .barfoot{display:flex;justify-content:space-between;font-size:12.5px}
  .barfoot b{font-weight:700}
  .three{grid-template-columns:1fr 1fr 1fr}
  .lab{font-size:13px;color:#6B7685;font-weight:600}
  .nm{font-size:27px;font-weight:800;line-height:1.1;margin-top:6px}
  .bad{color:#E2451E}
  .note{font-size:12px;color:#6B7685;margin-top:7px}
  .note b{font-weight:700;color:#1A2230}
  .two{grid-template-columns:1fr 1fr}
  .abar{height:13px;background:#E1E7F0;border-radius:8px;overflow:hidden;margin:8px 0 10px}
  .abar .f{height:100%;background:linear-gradient(90deg,#3B82F6,#2563EB);border-radius:8px}
  .leak{display:flex;flex-direction:column}
  .leak.ok{background:#DCFCE7;border-color:#BBF7D0}.leak.bad{background:#FEE7E0;border-color:#FBCEC2}
  .leakmid{flex:1;display:flex;align-items:center}
  .leak .st{font-size:27px;font-weight:800;line-height:1.15}
  .leak.ok .st{color:#16A34A}.leak.bad .st{color:#E2451E}
  .leak .leaksub{font-size:13.5px;margin:0;line-height:1.5}
  .bars{display:flex;align-items:flex-end;gap:8px;height:160px;padding-top:8px;position:relative}
  .bcol{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;height:100%;justify-content:flex-end}
  .bstack{width:100%;max-width:40px;border-radius:5px 5px 0 0;display:flex;flex-direction:column;justify-content:flex-end;overflow:hidden;background:#E1E7F0}
  .bfill{width:100%;height:100%;background:linear-gradient(180deg,#22C55E,#16A34A)}
  .bover{width:100%;height:100%;background:linear-gradient(180deg,#FB923C,#EF4444)}
  .blab{font-size:10px;color:#6B7685;text-align:center;line-height:1.2}
  .blab b{display:block;color:#1A2230;font-weight:700;font-size:11px}
  .bval{font-size:9.5px;color:#6B7685;font-weight:700}
  .tline{position:absolute;left:0;right:0;border-top:2px dashed #94A3B8;z-index:2}
  .tline span{position:absolute;right:0;top:-15px;font-size:10px;color:#64748B;font-weight:700;background:#fff;padding:0 4px}
  .run{display:flex;align-items:center;gap:12px;padding:9px 0;border-bottom:1px solid #E4E9F0;font-size:13px}
  .run:last-child{border-bottom:0}.run .tm{width:110px;font-weight:700}.run .meta{color:#6B7685;font-size:12px;flex:1}.run .g{font-weight:700}
  .mt{margin-top:14px}
  .center{text-align:center;padding:50px 20px;color:#6B7685;font-size:14px}
  .spin{display:inline-block;width:22px;height:22px;border:3px solid #E1E7F0;border-top-color:#2563EB;border-radius:50%;animation:sp 1s linear infinite;margin-bottom:12px}
  @keyframes sp{to{transform:rotate(360deg)}}
  .foot{margin-top:18px;font-size:11.5px;color:#6B7685;text-align:center;line-height:1.6}
  .fab{position:fixed;right:18px;bottom:18px;z-index:2147483645;background:#2563EB;color:#fff;border:0;border-radius:30px;
       padding:12px 18px;font-size:14px;font-weight:600;box-shadow:0 8px 24px rgba(37,99,235,.35);cursor:pointer;display:flex;align-items:center;gap:8px}
  .fab:hover{background:#1D4ED8}
  .banner{display:flex;gap:14px;align-items:flex-start;border-radius:16px;padding:22px 24px;border:1px solid}
  .banner.bad{background:#FEE7E0;border-color:#FBCEC2}
  .banner.ok{background:#E9F7EE;border-color:#BBE8CB}
  .bicon{font-size:28px;line-height:1.1;flex-shrink:0}
  .blead{font-weight:800;font-size:16px;margin-bottom:4px}
  .banner.bad .blead{color:#E2451E}.banner.ok .blead{color:#16A34A}
  .btext{font-size:18px;line-height:1.5;color:#1A2230}
  .btext b{font-weight:800}.banner.bad .btext b{color:#E2451E}.banner.ok .btext b{color:#16A34A}
  .actionbig{font-size:25px;font-weight:800;letter-spacing:-.01em;margin:2px 0 10px;color:#E2451E}
  .action .note,.good-card .note{font-size:14.5px;line-height:1.55}
  .herorow{display:grid;grid-template-columns:3fr 1fr;gap:14px;align-items:stretch}
  .shut{display:flex;flex-direction:column}
  .shutdate{font-size:28px;font-weight:800;letter-spacing:-.02em;color:#1A2230;line-height:1.05}
  .shutyear{font-size:14px;font-weight:700;color:#6B7685;margin-top:2px}
  .updated{font-size:12px;color:#94A3B8;margin-top:14px}
  @media(max-width:780px){.three,.two,.herorow{grid-template-columns:1fr}.big{font-size:40px}.btext{font-size:16px}}`;

  function render(root, B, A, C) {
    const used = B.cycleUsed, cap = B.cycleBudget || (B.dailyTarget * B.daysInCycle), left = cap - used;
    const pctUsed = cap ? used / cap * 100 : 0;
    const pctTime = B.daysInCycle ? B.daysIn / B.daysInCycle * 100 : 0;
    const daysLeft = Math.max(0, B.daysInCycle - B.daysIn);
    const pace = B.daysIn ? used / B.daysIn : 0;
    const proj = pace * B.daysInCycle, projPct = cap ? proj / cap * 100 : 0;
    const offTrack = projPct > 105;
    const fillCol = offTrack ? 'linear-gradient(90deg,#FB923C,#EF4444)' : 'linear-gradient(90deg,#3B82F6,#2563EB)';
    const monthName = B.cycleStart ? B.cycleStart.toLocaleDateString('en-US', { month: 'long' }) : 'this month';

    // ---- Year-end outlook + action steps (irrigation-dominant meter: the watering season drives the year) ----
    const aBudget = A.annualBudget, aUsed = A.annualUsed;
    const haveAnnual = !!(aBudget && aUsed != null);
    const aPct = haveAnnual ? aUsed / aBudget * 100 : null;
    const now = new Date();
    const seasonEnd = new Date(now.getFullYear(), SHUTOFF.month, SHUTOFF.day);   // North Ogden secondary water shuts off ~Oct 15
    const daysToSeasonEnd = Math.max(0, Math.round((seasonEnd - now) / 864e5));
    const updatedStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' at ' + now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const shutMonthDay = seasonEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const shutYear = seasonEnd.getFullYear();
    const shutAsOf = new Date(SHUTOFF.asOf + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const canOutlook = haveAnnual && daysToSeasonEnd > 0 && pace > 0;
    let yearClass = '', yearLead = '', yearMsg = '', cutPct = 0, allowedDailyYear = 0;
    if (canOutlook) {
      const diff = aBudget - (aUsed + pace * daysToSeasonEnd);     // + = leftover, - = over
      allowedDailyYear = Math.max(0, (aBudget - aUsed) / daysToSeasonEnd);
      cutPct = pace > allowedDailyYear ? Math.round((pace - allowedDailyYear) / pace * 100) : 0;
      if (diff >= 0) {
        yearClass = 'ok'; yearLead = 'Good news.';
        yearMsg = `If you keep watering like you are now, you'll finish the season with about <b>${f(diff)} gallons to spare</b> before the water shuts off in October.`;
      } else {
        yearClass = 'bad'; yearLead = 'Heads up.';
        yearMsg = `If you keep watering like you are now, you'll go <b>about ${f(-diff)} gallons over</b> your yearly limit by the time the water shuts off in mid-October.`;
      }
    }

    // daily bars
    let barsHtml = '<div class="tline" id="tl"><span>daily limit</span></div>';
    let maxv = B.dailyTarget || 1;
    if (C && C.daily.length) { C.daily.forEach(d => { if (d.total > maxv) maxv = d.total; }); }
    if (C && C.daily.length) {
      barsHtml += C.daily.map(d => {
        const h = Math.max(2, d.total / maxv * 100);
        const over = d.total > B.dailyTarget;
        const lbl = d.total >= 1000 ? (d.total / 1000).toFixed(1) + 'k' : Math.round(d.total);
        return `<div class="bcol"><div class="bval mono">${d.missing ? '' : lbl}</div>
          <div class="bstack" style="height:${h}%"><div class="${over ? 'bover' : 'bfill'}"></div></div>
          <div class="blab"><b>${d.date.getDate()}</b>${d.date.toLocaleDateString('en-US',{weekday:'short'})}</div></div>`;
      }).join('');
    }

    const leakBad = C && C.leakGal > 0.5;
    const runsHtml = (C && C.runs.length) ? C.runs.map(r => `
      <div class="run"><span class="tm mono">${r.start.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}).toLowerCase()}</span>
      <span class="meta">${Math.round((r.end - r.start) / 6e4) + 1} min &middot; up to ${r.peak.toFixed(1)} gallons a minute</span>
      <span class="g mono">${f(r.gal)} gal</span></div>`).join('') : '<div class="muted" style="font-size:13.5px">No detailed sprinkler data for this period.</div>';

    root.innerHTML = `<style>${STYLE}</style>
    <div class="scrim" id="scrim"><div class="wrap"><div class="panel">
      <header>
        <div class="brand">
          <svg class="drop" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.2s7 7.3 7 12.3a7 7 0 1 1-14 0C5 9.5 12 2.2 12 2.2z"/></svg>
          <div><h1 class="serif">Your sprinkler water usage</h1><div class="sub muted">Straight from your meter. Updated every time you open this.</div></div>
        </div>
        <div><button class="x" id="refresh">Refresh</button> <button class="x" id="close">Close &times;</button></div>
      </header>

      <div class="herorow">
        <div class="card hero">
          <div class="head"><p class="ttl" style="margin:0">This is how much water you've used this month</p>
            <span class="verdict ${offTrack ? 'v-off' : 'v-on'}">${offTrack ? '&#9650; Off track' : '&#10003; On track'}</span></div>
          <div class="mt"><span class="big mono">${f(used)}</span> <span class="of">gallons</span></div>
          <div class="muted" style="font-size:15px;margin-top:3px">out of your <b style="color:#1A2230">${f(cap)} gallon</b> limit for ${monthName}</div>
          <div class="bar"><div class="fill" style="width:${Math.min(100, pctUsed)}%;background:${fillCol}"></div>
            <div class="mark" style="left:${Math.min(96, pctTime)}%"><span>today</span></div></div>
          <div class="barfoot"><span><b style="color:${offTrack ? '#E2451E' : '#16A34A'};font-size:14px">${Math.round(pctUsed)}% used</b></span>
            <span class="muted"><b style="color:#1A2230">${f(left)} gallons</b> left, ${daysLeft} days to go</span></div>
          <div class="updated">Updated ${updatedStr}</div>
        </div>
        <div class="card shut">
          <p class="ttl">Water shuts off</p>
          <div class="leakmid"><div><div class="shutdate">${shutMonthDay}</div><div class="shutyear">${shutYear}</div></div></div>
          <p class="leaksub muted">${daysToSeasonEnd > 0 ? 'in about ' + daysToSeasonEnd + ' days' : 'off for the season'}<br>as of ${shutAsOf}</p>
        </div>
      </div>

      ${canOutlook ? `<div class="banner ${yearClass} mt">
        <div class="bicon">${yearClass === 'bad' ? '&#9888;&#65039;' : '&#127881;'}</div>
        <div><div class="blead">${yearLead}</div><div class="btext">${yearMsg}</div></div></div>` : ''}

      ${canOutlook && cutPct > 0 ? `<div class="card action mt">
        <p class="ttl">What to do about it</p>
        <div class="actionbig">Water about ${cutPct}% less</div>
        <p class="note">Right now you're using about <b>${f(pace)} gallons a day</b>. To stay under your limit for the year, aim for about <b>${f(allowedDailyYear)} gallons a day</b> or less.<br><br>
        The two easiest ways to get there: run each sprinkler zone about <b>${cutPct}% shorter</b>, or <b>water one fewer day each week</b>.</p></div>`
      : (canOutlook ? `<div class="card good-card mt">
        <p class="ttl">What to do about it</p>
        <div class="actionbig" style="color:#16A34A">Nothing, you're on track.</div>
        <p class="note">You're using about <b>${f(pace)} gallons a day</b>, which keeps you under your yearly limit. Keep doing what you're doing.</p></div>` : '')}

      <div class="grid two mt">
        <div class="card"><p class="ttl">Your water budget for the whole year</p>
          ${aPct == null ? '<div class="muted" style="font-size:13.5px">Yearly figure unavailable right now.</div>' : `
          <div style="display:flex;justify-content:space-between;align-items:baseline"><span class="nm mono">${Math.round(aPct)}% used</span>
            <span class="muted" style="font-size:13.5px">${f(aUsed)} of ${f(aBudget)} gal</span></div>
          <div class="abar"><div class="f" style="width:${Math.min(100, aPct)}%"></div></div>
          <div class="muted" style="font-size:13.5px"><b style="color:#1A2230">${f(aBudget - aUsed)} gallons</b> left for the rest of the year</div>`}</div>
        <div class="card leak ${leakBad ? 'bad' : 'ok'}"><p class="ttl">Leak check</p>
          <div class="leakmid"><span class="st">${leakBad ? '&#9888;&#65039; Possible leak' : '&#10003; No leaks found'}</span></div>
          <p class="leaksub muted">${leakBad ? f(C.leakGal) + ' gallons looked like a leak this month. Worth a closer look.' : 'Good news, nothing looks like a leak. Your high usage is the sprinklers, not a hidden problem.'}</p></div>
      </div>

      <div class="card mt"><p class="ttl">How much water you use each day <span style="color:#94A3B8;font-weight:500">(your daily limit is ${f(B.dailyTarget)} gallons)</span></p>
        <div class="bars" id="bars">${barsHtml}</div></div>

      <div class="card mt"><p class="ttl">When your sprinklers ran${C && C.maxLabel ? ', ' + C.maxLabel : ''}</p>
        <div>${runsHtml}</div></div>

      <div class="foot">This is the same information your water utility already has, just shown more clearly.</div>
    </div></div></div>`;

    // target line position
    const tl = root.getElementById('tl');
    if (tl && B.dailyTarget) tl.style.bottom = (B.dailyTarget / maxv * 100) + '%';
    root.getElementById('close').onclick = hide;
    root.getElementById('refresh').onclick = () => { show(); load(); };
    root.getElementById('scrim').onclick = e => { if (e.target.id === 'scrim') hide(); };
  }

  function loading(root, msg) {
    root.innerHTML = `<style>${STYLE}</style><div class="scrim" id="scrim"><div class="wrap"><div class="panel">
      <div class="center"><div class="spin"></div><br>${msg || 'Reading your meter...'}</div></div></div></div>`;
    const s = root.getElementById('scrim'); if (s) s.onclick = e => { if (e.target.id === 'scrim') hide(); };
  }

  function errored(root, msg) {
    root.innerHTML = `<style>${STYLE}</style><div class="scrim" id="scrim"><div class="wrap"><div class="panel">
      <div class="center">${msg}<br><br><button class="x" id="close">Close</button></div></div></div></div>`;
    root.getElementById('close').onclick = hide;
    root.getElementById('scrim').onclick = e => { if (e.target.id === 'scrim') hide(); };
  }

  // ---------- mount ----------
  const host = document.createElement('div');
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });

  const fab = document.createElement('button');
  fab.className = 'fab';
  fab.innerHTML = '&#128167; Budget';
  fab.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483645;background:#2563EB;color:#fff;border:0;border-radius:30px;padding:12px 18px;font:600 14px Inter,-apple-system,Helvetica,Arial,sans-serif;box-shadow:0 8px 24px rgba(37,99,235,.35);cursor:pointer';
  fab.onclick = () => { show(); load(); };
  document.body.appendChild(fab);

  function show() { host.style.display = 'block'; fab.style.display = 'none'; }
  function hide() { root.innerHTML = ''; host.style.display = 'none'; fab.style.display = 'block'; }

  async function load() {
    loading(root);
    try {
      await loadShutoffConfig();
      const [bHtml, aHtml] = await Promise.all([
        getText('/Consumer/WaterBudget/WaterBudget'),
        getText('/Consumer/Dashboard/Dashboard')
      ]);
      const B = parseBudget(bHtml);
      if (!B || B.cycleUsed == null) {
        if (bHtml && (bHtml.indexOf(SENTINEL) !== -1 || /login|sign in/i.test(bHtml)))
          return errored(root, 'Your Waterscope session looks expired. Reload the page, log in, and reopen this.');
        return errored(root, 'Could not read the budget. Open the dashboard once, then reopen this.');
      }
      const A = parseAnnual(aHtml);
      // Discover THIS user's own meter/account from their own dashboard (never hardcoded).
      const acct  = (num(aHtml.match(/accountId\s*=\s*'(\d+)'/i)) || (document.querySelector('#AccountId') || {}).value || '');
      const meter = (num(aHtml.match(/MeterId\s*:\s*'(\d+)'/i))   || (document.querySelector('#MeterId')   || {}).value || '');
      render(root, B, A, null);                 // paint budget immediately
      try {                                       // enrich with daily detail (best effort)
        if (!acct || !meter) throw new Error('no meter id');
        const C = await fetchCycleConsumption(B.cycleStart, acct, meter);
        render(root, B, A, C);
      } catch (e) { /* keep budget-only view */ }
    } catch (e) {
      errored(root, 'Something went wrong reaching Waterscope. Reload and try again.');
    }
  }

  // auto-open on first load
  show(); load();
})();

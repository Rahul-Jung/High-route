/* ============================================================
   HIGH ROUTE MTB — shared behaviour
   ============================================================ */

/* ---------- Header scroll state ---------- */
(function(){
  const header = document.querySelector('.site-header');
  if(!header) return;
  const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 40);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive:true });
})();

/* ============================================================
   MOBILE NAV — builds a single accessible slide-in panel from
   whatever the page's .main-nav already contains (top-level links,
   plus any .nav-panel-inner sub-links become a native <details>
   accordion), so every page gets the same rich menu without
   duplicating markup across all six HTML files. Locks body scroll
   while open, closes on Escape/backdrop click/link click, and
   restores focus to the toggle button on close.
   ============================================================ */
(function(){
  const toggle = document.querySelector('.nav-toggle');
  const mainNav = document.querySelector('.main-nav');
  if(!toggle || !mainNav) return;

  toggle.innerHTML = '<span class="nav-toggle-bar"></span><span class="nav-toggle-bar"></span><span class="nav-toggle-bar"></span>';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'mobile-nav-panel');

  const backdrop = document.createElement('div');
  backdrop.className = 'mobile-nav-backdrop';
  const panel = document.createElement('div');
  panel.className = 'mobile-nav-panel';
  panel.id = 'mobile-nav-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Site menu');

  const linksHtml = [...mainNav.children].map(li => {
    const topLink = li.querySelector(':scope > a');
    if(!topLink) return '';
    const subLinks = [...li.querySelectorAll('.nav-panel-inner a')];
    if(!subLinks.length){
      return `<a class="mn-link" href="${topLink.getAttribute('href')}">${escapeHtml(topLink.textContent.trim())}</a>`;
    }
    const subHtml = subLinks.map(a => `<a href="${a.getAttribute('href')}">${escapeHtml(a.textContent.trim())}</a>`).join('');
    return `<details><summary>${escapeHtml(topLink.textContent.trim())}</summary><div class="mn-sub">${subHtml}</div></details>`;
  }).join('');

  const navCta = document.querySelector('.nav-cta');
  panel.innerHTML = `
    <div class="mobile-nav-head">
      <span class="logo"><span class="mark">&#9670;</span> HIGH ROUTE</span>
      <button type="button" class="mobile-nav-close" aria-label="Close menu">&times;</button>
    </div>
    <nav class="mobile-nav-links">${linksHtml}</nav>
    <div class="mobile-nav-foot">
      ${navCta ? `<a href="${navCta.getAttribute('href')}" class="btn btn-solid btn-block">${escapeHtml(navCta.textContent.trim())}</a>` : ''}
    </div>`;

  document.body.appendChild(backdrop);
  document.body.appendChild(panel);

  function open(){
    backdrop.classList.add('open');
    panel.classList.add('open');
    document.body.classList.add('nav-open');
    toggle.setAttribute('aria-expanded', 'true');
    panel.querySelector('.mobile-nav-close').focus();
    document.addEventListener('keydown', onKeydown);
  }
  function close(){
    backdrop.classList.remove('open');
    panel.classList.remove('open');
    document.body.classList.remove('nav-open');
    toggle.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKeydown);
    toggle.focus();
  }
  function onKeydown(e){ if(e.key === 'Escape') close(); }

  toggle.addEventListener('click', () => { toggle.getAttribute('aria-expanded') === 'true' ? close() : open(); });
  backdrop.addEventListener('click', close);
  panel.querySelector('.mobile-nav-close').addEventListener('click', close);
  panel.querySelectorAll('.mn-link, .mn-sub a').forEach(a => a.addEventListener('click', close));

  // Desktop hover-driven mega menu still works on wide screens; this panel
  // only ever displays under the same breakpoint the CSS uses for .nav-toggle.
  window.addEventListener('resize', () => { if(window.innerWidth > 1080) close(); });
})();


/* ---------- Tour card 3D tilt (re-callable, since card grids can be re-rendered from the API) ---------- */
window.initTourTilt = function(){
  const cards = document.querySelectorAll('.tour-card:not([data-tilt-bound])');
  if(!cards.length || window.matchMedia('(pointer: coarse)').matches) return;
  cards.forEach(card => {
    card.setAttribute('data-tilt-bound', '1');
    card.addEventListener('mousemove', e => {
      const r = card.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      card.style.transform = `perspective(900px) rotateY(${x*6}deg) rotateX(${-y*6}deg) translateZ(4px)`;
    });
    card.addEventListener('mouseleave', () => { card.style.transform = ''; });
  });
};
window.initTourTilt();

/* ---------- Animated stat counters ---------- */
(function(){
  const stats = document.querySelectorAll('[data-count]');
  if(!stats.length) return;
  const io = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if(!entry.isIntersecting) return;
      const el = entry.target;
      const target = parseFloat(el.dataset.count);
      const suffix = el.dataset.suffix || '';
      const dur = 1100; const start = performance.now();
      function tick(now){
        const p = Math.min(1, (now - start) / dur);
        const eased = 1 - Math.pow(1-p, 3);
        el.textContent = Math.round(target * eased).toLocaleString() + suffix;
        if(p < 1) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
      io.unobserve(el);
    });
  }, { threshold:0.5 });
  stats.forEach(el => io.observe(el));
})();

/* ============================================================
   API CLIENT — talks to the High Route backend (server.js).
   Override the base URL by setting window.HIGHROUTE_API_BASE
   before this script loads if the backend runs somewhere else.
   ============================================================ */
const API_BASE = window.HIGHROUTE_API_BASE || 'http://localhost:4000';
/** True once the Auth module (defined just below) exists and has a signed-in rider. */
function riderAuthHeaders(){
  return (typeof Auth !== 'undefined' && Auth.isSignedIn()) ? { 'Authorization': 'Bearer ' + Auth.token() } : {};
}
async function apiGet(path){
  // Sent whenever signed in so account-scoped GETs (e.g. /api/riders/me,
  // /api/riders/me/bookings) work the same way as every other call — public
  // endpoints simply ignore the extra header.
  const r = await fetch(API_BASE + path, { headers: riderAuthHeaders() });
  const data = await r.json();
  if(!r.ok) { const err = new Error(data.error || r.statusText); err.data = data; throw err; }
  return data;
}
async function apiPost(path, body){
  // Threads the signed-in rider's session into every POST automatically (booking
  // creation, custom requests, reviews, ...) so the backend can attribute them to
  // an account without every call site having to remember to add the header.
  const headers = { 'Content-Type':'application/json', ...riderAuthHeaders() };
  const r = await fetch(API_BASE + path, { method:'POST', headers, body: JSON.stringify(body) });
  const data = await r.json();
  // err.data carries the rest of the error body (e.g. login's { needs_verification,
  // email } on a 403) for callers that need more than just the message string.
  if(!r.ok) { const err = new Error(data.error || r.statusText); err.data = data; throw err; }
  return data;
}
async function apiPatch(path, body){
  const headers = { 'Content-Type':'application/json', ...riderAuthHeaders() };
  const r = await fetch(API_BASE + path, { method:'PATCH', headers, body: JSON.stringify(body) });
  const data = await r.json();
  if(!r.ok) { const err = new Error(data.error || r.statusText); err.data = data; throw err; }
  return data;
}

/** Escapes text for safe interpolation into innerHTML template strings.
 *  Applied to every value below that ultimately comes from the API (tour/guide/
 *  gallery/review/destination content, error messages) — most of that content
 *  is editable through the admin CMS or, for reviews, submitted by any site
 *  visitor, so none of it can be trusted as pre-formed HTML. */
function escapeHtml(value){
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

/* ============================================================
   TOAST NOTIFICATIONS — top-right, color-coded (success/error/warning/
   info), used across the whole public site whenever an action completes:
   booking, cancelling, paying, submitting a review or request, signing in,
   etc. Lazily creates its own #toast-stack container the first time it's
   called, so no page needs to add one to its markup — just call
   showToast(message, type) from anywhere. Mirrors the admin panel's toast
   component (styling lives in style.css's "TOAST NOTIFICATIONS" section).
   ============================================================ */
const TOAST_ICON = { success:'✓', error:'✕', warning:'⚠', info:'ℹ' };
const TOAST_DURATION_MS = 6000;
function ensureToastStack(){
  let stack = document.getElementById('toast-stack');
  if(!stack){
    stack = document.createElement('div');
    stack.id = 'toast-stack';
    stack.setAttribute('aria-live', 'polite');
    document.body.appendChild(stack);
  }
  return stack;
}
function showToast(message, type){
  type = TOAST_ICON[type] ? type : 'info';
  const stack = ensureToastStack();
  const card = document.createElement('div');
  card.className = 'toast-card ' + type;
  card.innerHTML = `<span class="toast-ic">${TOAST_ICON[type]}</span><span class="toast-msg">${escapeHtml(message)}</span>
    <div class="toast-progress" style="animation-duration:${TOAST_DURATION_MS}ms;"></div>`;
  const progress = card.querySelector('.toast-progress');

  let remaining = TOAST_DURATION_MS;
  let startedAt = Date.now();
  let timer;
  const clear = () => clearTimeout(timer);
  const remove = () => { clear(); card.classList.add('leaving'); setTimeout(() => card.remove(), 280); };
  const schedule = ms => { startedAt = Date.now(); timer = setTimeout(remove, ms); };

  card.addEventListener('mouseenter', () => {
    clear();
    remaining -= (Date.now() - startedAt);
    progress.style.animationPlayState = 'paused';
  });
  card.addEventListener('mouseleave', () => {
    schedule(Math.max(remaining, 300));
    progress.style.animationPlayState = 'running';
  });
  card.addEventListener('click', remove);

  stack.appendChild(card);
  schedule(TOAST_DURATION_MS);
}

/* ============================================================
   RIDER ACCOUNTS — sign in / sign up modal + header account control.
   Mounted on every page that has a .header-actions container (all of them).
   Booking a tour requires an account (see renderBookingSidebar below), and so
   does submitting the Build Your Adventure wizard (see doSubmit below) — every
   custom-request lead is tied to a real rider from the start.
   ============================================================ */
const Auth = (function(){
  function token(){ return localStorage.getItem('hr_rider_token'); }
  function name(){ return localStorage.getItem('hr_rider_name'); }
  function email(){ return localStorage.getItem('hr_rider_email'); }
  function isSignedIn(){ return !!token(); }

  function setSession(data){
    localStorage.setItem('hr_rider_token', data.token);
    localStorage.setItem('hr_rider_name', data.rider.name);
    localStorage.setItem('hr_rider_email', data.rider.email);
  }
  async function signOut(){
    try { await fetch(API_BASE + '/api/auth/session', { method:'DELETE', headers:{ Authorization:'Bearer ' + token() } }); } catch { /* best-effort */ }
    localStorage.removeItem('hr_rider_token');
    localStorage.removeItem('hr_rider_name');
    localStorage.removeItem('hr_rider_email');
    location.reload();
  }

  let onSuccess = null; // resumes a pending action (e.g. "book this tour") right after sign-in

  function ensureModal(){
    if(document.getElementById('auth-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'auth-overlay';
    overlay.className = 'auth-overlay hidden';
    overlay.innerHTML = `
      <div class="auth-modal">
        <button class="auth-close" type="button" aria-label="Close">&times;</button>
        <div class="auth-tabs">
          <button class="auth-tab active" data-tab="signin" type="button">Sign in</button>
          <button class="auth-tab" data-tab="signup" type="button">Sign up</button>
        </div>
        <form class="auth-form" id="auth-signin-form">
          <h2>Welcome back</h2>
          <p class="auth-sub">Sign in to book a tour or track your requests.</p>
          <div class="auth-field"><label>Email</label><input type="email" id="auth-signin-email" autocomplete="username" required></div>
          <div class="auth-field"><label>Password</label><input type="password" id="auth-signin-password" autocomplete="current-password" required></div>
          <div class="auth-error" id="auth-signin-error"></div>
          <button type="submit" class="btn btn-solid btn-block">Sign in</button>
        </form>
        <form class="auth-form hidden" id="auth-signup-form">
          <h2>Create your account</h2>
          <p class="auth-sub">One account to book, request custom trips, and track it all.</p>
          <div class="auth-field"><label>Name</label><input type="text" id="auth-signup-name" required></div>
          <div class="auth-field"><label>Email</label><input type="email" id="auth-signup-email" autocomplete="username" required></div>
          <div class="auth-field"><label>Password</label><input type="password" id="auth-signup-password" autocomplete="new-password" minlength="8" required></div>
          <div class="auth-error" id="auth-signup-error"></div>
          <button type="submit" class="btn btn-solid btn-block">Create account</button>
        </form>
        <form class="auth-form hidden" id="auth-verify-form">
          <h2>Check your email</h2>
          <p class="auth-sub">We sent a 6-digit code to <b id="auth-verify-email"></b>. Enter it below to activate your account.</p>
          <div class="auth-field"><label>Verification code</label><input type="text" id="auth-verify-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></div>
          <div class="auth-error" id="auth-verify-error"></div>
          <button type="submit" class="btn btn-solid btn-block">Verify &amp; sign in</button>
          <button type="button" class="btn btn-ghost btn-block" id="auth-verify-resend" style="margin-top:10px;">Resend code</button>
        </form>
      </div>`;
    document.body.appendChild(overlay);

    // The verify step isn't one of the tabs (you only land on it right after
    // signing up, or after a sign-in attempt reports the account still needs
    // verifying) — switching tabs manually always backs out of it to signin/signup.
    function showVerifyStep(email){
      overlay.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
      overlay.querySelector('#auth-signin-form').classList.add('hidden');
      overlay.querySelector('#auth-signup-form').classList.add('hidden');
      overlay.querySelector('#auth-verify-form').classList.remove('hidden');
      overlay.querySelector('#auth-verify-email').textContent = email;
      overlay.querySelector('#auth-verify-form').dataset.email = email;
      overlay.querySelector('#auth-verify-error').textContent = '';
      overlay.querySelector('#auth-verify-code').value = '';
    }

    overlay.addEventListener('click', e => { if(e.target === overlay) close(); });
    overlay.querySelector('.auth-close').addEventListener('click', close);
    overlay.querySelectorAll('.auth-tab').forEach(tab => tab.addEventListener('click', () => {
      overlay.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('active', t === tab));
      overlay.querySelector('#auth-signin-form').classList.toggle('hidden', tab.dataset.tab !== 'signin');
      overlay.querySelector('#auth-signup-form').classList.toggle('hidden', tab.dataset.tab !== 'signup');
      overlay.querySelector('#auth-verify-form').classList.add('hidden');
      overlay.querySelector('#auth-signin-error').textContent = '';
      overlay.querySelector('#auth-signup-error').textContent = '';
    }));

    overlay.querySelector('#auth-signin-form').addEventListener('submit', async e => {
      e.preventDefault();
      const errEl = document.getElementById('auth-signin-error');
      errEl.textContent = '';
      try {
        const data = await apiPost('/api/auth/login', {
          email: document.getElementById('auth-signin-email').value.trim(),
          password: document.getElementById('auth-signin-password').value,
        });
        setSession(data);
        close();
        if(onSuccess){ const cb = onSuccess; onSuccess = null; cb(); }
        else {
          // Signed in from the plain header widget, not via requireSignIn —
          // no caller is waiting to resume anything. Some pages (calendar.html's
          // auto-jump, dashboard-style content elsewhere) render auth-dependent
          // content once at load and never re-check afterward, so without a
          // reload here signing in mid-visit silently leaves that content stuck
          // on its earlier, signed-out state. A full reload guarantees every
          // page picks up the new session, matching what requireSignIn's own
          // callers already do (see trip.html/tour-detail.html/dashboard.html).
          location.reload();
        }
      } catch(err) {
        // A correct password on an account that never finished signup email
        // verification — send them straight to the code-entry step instead
        // of just showing an error they can't act on.
        if(err.data && err.data.needs_verification){ showVerifyStep(err.data.email); return; }
        errEl.textContent = err.message;
      }
    });

    overlay.querySelector('#auth-signup-form').addEventListener('submit', async e => {
      e.preventDefault();
      const errEl = document.getElementById('auth-signup-error');
      errEl.textContent = '';
      try {
        const email = document.getElementById('auth-signup-email').value.trim();
        await apiPost('/api/auth/register', {
          name: document.getElementById('auth-signup-name').value.trim(),
          email,
          password: document.getElementById('auth-signup-password').value,
        });
        // Registering no longer signs you in directly — the account exists
        // but is unusable until the emailed code is entered (see the comment
        // on POST /api/auth/register in routes/auth.js).
        showVerifyStep(email);
      } catch(err) { errEl.textContent = err.message; }
    });

    overlay.querySelector('#auth-verify-form').addEventListener('submit', async e => {
      e.preventDefault();
      const errEl = document.getElementById('auth-verify-error');
      errEl.textContent = '';
      try {
        const data = await apiPost('/api/auth/verify-email', {
          email: overlay.querySelector('#auth-verify-form').dataset.email,
          code: document.getElementById('auth-verify-code').value.trim(),
        });
        setSession(data);
        close();
        if(onSuccess){ const cb = onSuccess; onSuccess = null; cb(); }
        else location.reload(); // see the matching comment in the sign-in handler above
      } catch(err) { errEl.textContent = err.message; }
    });

    overlay.querySelector('#auth-verify-resend').addEventListener('click', async () => {
      const btn = overlay.querySelector('#auth-verify-resend');
      const errEl = document.getElementById('auth-verify-error');
      const email = overlay.querySelector('#auth-verify-form').dataset.email;
      const originalLabel = btn.textContent;
      btn.disabled = true; btn.textContent = 'Sending...';
      try {
        await apiPost('/api/auth/resend-verification', { email });
        errEl.style.color = '#4C9A55'; errEl.textContent = 'A new code has been sent.';
      } catch(err) {
        errEl.style.color = ''; errEl.textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = originalLabel;
      }
    });
  }

  function open(tab){
    ensureModal();
    const overlay = document.getElementById('auth-overlay');
    overlay.classList.remove('hidden');
    if(tab) overlay.querySelector(`.auth-tab[data-tab="${tab}"]`).click();
  }
  function close(){
    const overlay = document.getElementById('auth-overlay');
    if(overlay) overlay.classList.add('hidden');
  }

  /** Runs fn() immediately if already signed in; otherwise opens the sign-in
   *  modal and resumes fn() automatically the moment sign-in/sign-up succeeds. */
  function requireSignIn(fn){
    if(isSignedIn()) return fn();
    onSuccess = fn;
    open('signin');
  }

  return { token, name, email, isSignedIn, signOut, open, requireSignIn };
})();

function mountAccountControl(){
  const host = document.querySelector('.header-actions');
  if(!host) return;
  let control = document.getElementById('account-control');
  if(!control){
    control = document.createElement('div');
    control.id = 'account-control';
    control.className = 'account-control';
    host.insertBefore(control, host.firstChild);
  }
  if(Auth.isSignedIn()){
    control.innerHTML = `<button class="account-btn" id="account-toggle" type="button">${escapeHtml(Auth.name())} &#9662;</button>
      <div class="account-menu hidden" id="account-menu">
        <a href="dashboard.html">My account</a>
        <button type="button" id="account-signout">Sign out</button>
      </div>`;
    control.querySelector('#account-toggle').addEventListener('click', () => {
      control.querySelector('#account-menu').classList.toggle('hidden');
    });
    control.querySelector('#account-signout').addEventListener('click', () => Auth.signOut());
  } else {
    control.innerHTML = `<button class="account-btn" id="account-signin-btn" type="button">Sign in</button>`;
    control.querySelector('#account-signin-btn').addEventListener('click', () => Auth.open('signin'));
  }
  mountNotificationBell();
}
mountAccountControl();

/* ============================================================
   NOTIFICATION BELL — mounted next to the account control on every page
   (only once signed in). In-app only: this demo has no outbound email/SMS
   provider wired up, so a proposal-sent/customer-responded/payment-confirmed
   notification (see routes/proposals.js) shows up here, not in an inbox.
   ============================================================ */
var notifBellPollStarted = false; // var (not let/const): mountAccountControl() below calls mountNotificationBell() at load time, before this line would otherwise run
function mountNotificationBell(){
  const host = document.querySelector('.header-actions');
  if(!host) return;
  let bell = document.getElementById('notif-bell');
  if(!Auth.isSignedIn()){ if(bell) bell.remove(); return; }
  if(!bell){
    bell = document.createElement('div');
    bell.id = 'notif-bell';
    bell.className = 'notif-bell';
    bell.innerHTML = `<button class="notif-bell-btn" id="notif-bell-toggle" type="button" aria-label="Notifications">&#128276;<span class="notif-badge hidden" id="notif-badge">0</span></button>
      <div class="notif-panel hidden" id="notif-panel">
        <div class="notif-panel-head"><b>Notifications</b><button type="button" id="notif-mark-all">Mark all read</button></div>
        <div class="notif-panel-list" id="notif-panel-list"><p class="dash-empty" style="padding:14px; font-size:12.5px;">Loading&hellip;</p></div>
      </div>`;
    host.insertBefore(bell, host.firstChild);
    bell.querySelector('#notif-bell-toggle').addEventListener('click', () => {
      const panel = document.getElementById('notif-panel');
      const willOpen = panel.classList.contains('hidden');
      panel.classList.toggle('hidden');
      if(willOpen) loadNotificationBell(false);
    });
    bell.querySelector('#notif-mark-all').addEventListener('click', async () => {
      try { await apiPost('/api/riders/me/notifications/read-all', {}); loadNotificationBell(false); } catch { /* best-effort */ }
    });
    document.addEventListener('click', e => {
      const panel = document.getElementById('notif-panel');
      if(panel && !bell.contains(e.target)) panel.classList.add('hidden');
    });
  }
  loadNotificationBell(true);
  if(!notifBellPollStarted){ notifBellPollStarted = true; setInterval(() => loadNotificationBell(true), 60000); }
}
async function loadNotificationBell(badgeOnly){
  const badge = document.getElementById('notif-badge');
  if(!badge) return;
  try {
    const data = await apiGet('/api/riders/me/notifications');
    if(data.unread_count > 0){ badge.textContent = data.unread_count; badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
    if(badgeOnly) return;
    const list = document.getElementById('notif-panel-list');
    list.innerHTML = data.notifications.length ? data.notifications.map(n => `
      <div class="notif-item${n.read_at ? '' : ' unread'}" data-id="${n.id}" data-link="${escapeHtml(n.link_url || '')}">
        <div class="notif-item-title">${escapeHtml(n.title)}</div>
        ${n.body ? `<div class="notif-item-body">${escapeHtml(n.body)}</div>` : ''}
        <div class="notif-item-time">${escapeHtml((n.created_at || '').slice(0, 16))}</div>
      </div>`).join('') : '<p class="dash-empty" style="padding:14px; font-size:12.5px;">No notifications yet.</p>';
    list.querySelectorAll('.notif-item').forEach(el => el.addEventListener('click', async () => {
      try { await apiPost('/api/riders/me/notifications/' + el.dataset.id + '/read', {}); } catch { /* best-effort */ }
      if(el.dataset.link) location.href = el.dataset.link;
      else loadNotificationBell(false);
    }));
  } catch { /* best-effort — never block the header on a failed fetch */ }
}

/** Turns a day's real gain/loss/high-point stats into a plausible-looking curve
 *  for the chart — nothing here is stored separately in the database, it's
 *  derived from the same numbers shown in the stat readout, so the chart can
 *  never disagree with the figures next to it. */
function synthesizeProfile(day){
  const high = day.high, start = high - day.gain, end = high - day.loss;
  const n = 9, peakAt = 5;
  const ease = t => t*t*(3-2*t);
  const pts = [];
  for(let i=0;i<n;i++){
    let v;
    if(i <= peakAt){ v = start + (high-start)*ease(i/peakAt); }
    else { v = high + (end-high)*ease((i-peakAt)/(n-1-peakAt)); }
    const jitter = Math.sin((i+1)*(day.day+1)*1.7) * Math.max(20, day.gain*0.02);
    pts.push(Math.round(v + jitter));
  }
  pts[0] = Math.round(start); pts[n-1] = Math.round(end);
  return pts;
}

/* ============================================================
   TOUR DETAIL — day tabs + interactive elevation profile
   FALLBACK_ROUTE_DAYS is only used if the backend can't be reached
   (e.g. viewing the site without server.js running) so the page still
   works offline. When the API responds, its data wins.
   ============================================================ */
const FALLBACK_ROUTE_DAYS = [
  { day:1, title:'Kathmandu → Jomsom → Kagbeni', dist:18, gain:540, loss:180, high:2810, hours:'3–4', terrain:'Jeep track, riverbed gravel',
    profile:[2700,2760,2810,2740,2690,2810,2800], place:'Kagbeni gate' },
  { day:2, title:'Kagbeni → Chele via the windy canyon', dist:22, gain:970, loss:210, high:3050, hours:'5–6', terrain:'Singletrack, canyon rim',
    profile:[2810,2900,3050,2980,2940,3010,2960], place:'Chele monastery' },
  { day:3, title:'Chele → Syangboche, over Taklam La', dist:19, gain:1250, loss:340, high:3630, hours:'6', terrain:'Technical climb, alpine descent',
    profile:[2960,3200,3500,3630,3400,3300,3280], place:'Taklam La pass' },
  { day:4, title:'Syangboche → Ghami, the red cliffs', dist:24, gain:820, loss:790, high:3800, hours:'5', terrain:'Flow trail, gravel road',
    profile:[3280,3500,3800,3600,3200,3000,2990], place:'Ghami village' },
  { day:5, title:'Ghami → Charang, plateau riding', dist:20, gain:1850, loss:2100, high:3870, hours:'6–7', terrain:'Rolling plateau, rocky descent',
    profile:[2990,3300,3600,3870,3500,3100,2760], place:'Charang fort' },
  { day:6, title:'Charang → Lo Manthang, the walled city', dist:16, gain:670, loss:410, high:3840, hours:'3–4', terrain:'Wide jeep track',
    profile:[2760,3000,3200,3400,3600,3750,3840], place:'Lo Manthang' },
  { day:7, title:'Rest & acclimatisation, Lo Manthang', dist:8, gain:270, loss:270, high:4200, hours:'2', terrain:'Short exploratory loop to a viewpoint',
    profile:[3840,3980,4200,4100,3950,3880,3840], place:'Namgyal viewpoint' },
  { day:8, title:'Lo Manthang → Yara, remote valley', dist:27, gain:870, loss:1120, high:3760, hours:'6', terrain:'Remote singletrack, river crossings',
    profile:[3840,3760,3600,3400,3200,3100,2900], place:'Yara caves' },
  { day:9, title:'Yara → Tange, the big descent', dist:31, gain:530, loss:1680, high:3600, hours:'6–7', terrain:'Long technical descent',
    profile:[2900,3100,3600,3300,2800,2400,2100], place:'Tange canyon' },
  { day:10, title:'Tange → Jomsom → fly to Pokhara', dist:23, gain:230, loss:940, high:2900, hours:'4', terrain:'Flow descent to the valley floor',
    profile:[2100,2400,2900,2700,2500,2300,2200], place:'Jomsom airstrip' },
];
/** Header fields for the offline-fallback Upper Mustang view (see FALLBACK_ROUTE_DAYS above). */
const FALLBACK_TOUR_META = {
  name: 'Upper Mustang — Kingdom of Dirt', slug: 'upper-mustang', region: 'Mustang',
  summary: "Ten days of canyon singletrack, riverbed gravel and high alpine passes through Nepal's former forbidden kingdom, finishing inside the walled city of Lo Manthang.",
  duration_days: 10, difficulty_level: 5, riding_style: 'Enduro', distance_km: 320,
  elevation_gain_m: 8000, max_altitude_m: 4200, best_season: 'Sep – Nov',
  group_size_min: 6, group_size_max: 10, image_url: null,
};

/** name → word used in the difficulty system section / quickbar, keyed by difficulty_level (1-5). */
const DIFFICULTY_WORD = { 1:'Explorer', 2:'Trail rider', 3:'Mountain rider', 4:'Enduro', 5:'Himalayan expedition' };

(function(){
  const tabWrap = document.getElementById('day-tabs');
  if(!tabWrap) return;

  // Which tour to show: ?slug=<slug> in the URL, falling back to Upper
  // Mustang so a bare tour-detail.html link (old bookmarks, direct visits)
  // still shows something rather than a blank page. ?request=<id> is the
  // custom-trip mode instead (see loadCustomTripView below) — a signed-in
  // rider's own custom request, whose base tour and proposed terms get
  // fetched and overlaid instead of a bare catalogue slug.
  const params = new URLSearchParams(location.search);
  const requestId = params.get('request');
  const slug = params.get('slug') || params.get('tour') || 'upper-mustang';

  let DAYS = [];       // normalized {day,title,dist,gain,loss,high,hours,terrain,place,profile}
  const dataSourceNote = document.getElementById('data-source-note');
  const routeSection = document.getElementById('route-section');
  const routeEmpty = document.getElementById('route-empty');

  function normalizeFromApi(apiDays){
    return apiDays.map(d => {
      const norm = {
        day: d.day_number, title: d.title, dist: d.distance_km, gain: d.elevation_gain_m,
        loss: d.elevation_loss_m, high: d.high_point_m, hours: d.riding_hours,
        terrain: d.terrain, place: d.overnight_place,
        // Only ever real admin-entered coordinates (see tour_days.overnight_lat/lng)
        // — null for most tours/days, which renderRouteMap() must treat as
        // "no data" rather than guessing a position.
        lat: d.overnight_lat ?? null, lng: d.overnight_lng ?? null,
      };
      norm.profile = synthesizeProfile(norm);
      return norm;
    });
  }

  function buildTabs(){
    tabWrap.innerHTML = '';
    DAYS.forEach((d, i) => {
      const btn = document.createElement('button');
      btn.className = 'day-tab' + (i===0 ? ' active' : '');
      btn.textContent = 'DAY ' + d.day;
      btn.addEventListener('click', () => selectDay(i));
      tabWrap.appendChild(btn);
    });
    selectDay(0);
  }

  /** Fills the hero/quickbar/overview/highlights/difficulty-system/book-card
   *  chrome around the page from live tour fields — works for any tour the
   *  admin has added, not just the hand-authored Upper Mustang copy this
   *  page used to be hardcoded to. */
  function renderTourHeader(tour){
    document.getElementById('page-title').textContent = tour.name + ' | High Route';
    document.getElementById('page-description').setAttribute('content',
      tour.duration_days + ' days, ' + (DIFFICULTY_WORD[tour.difficulty_level] || 'guided') + ' riding through ' +
      tour.region + ': ' + tour.distance_km + 'km, ' + tour.elevation_gain_m.toLocaleString() + 'm of climbing, a ' +
      tour.max_altitude_m.toLocaleString() + 'm high point.');

    const heroImg = document.getElementById('hero-img');
    heroImg.src = tour.image_url || 'https://images.unsplash.com/photo-1652361561822-b2aa3f30416a?auto=format&fit=crop&w=1920&q=80';
    heroImg.alt = tour.name;
    document.getElementById('crumb-name').textContent = tour.name;

    const titleParts = tour.name.split(' — ');
    document.getElementById('hero-title').innerHTML = titleParts.length > 1
      ? escapeHtml(titleParts[0]) + '<br>' + escapeHtml(titleParts.slice(1).join(' — '))
      : escapeHtml(tour.name);

    const diffWord = DIFFICULTY_WORD[tour.difficulty_level] || ('Level ' + tour.difficulty_level);
    document.getElementById('qb-duration').textContent = tour.duration_days + ' days';
    document.getElementById('qb-difficulty').textContent = diffWord;
    document.getElementById('qb-altitude').textContent = tour.max_altitude_m.toLocaleString() + 'm';
    document.getElementById('qb-distance').textContent = tour.distance_km + 'km';
    document.getElementById('qb-groupsize').textContent = tour.group_size_min + '–' + tour.group_size_max + ' riders';
    document.getElementById('qb-season').textContent = tour.best_season || 'Year-round';
    // These three only exist in the sidebar's "pick a date and book" layout
    // (tour-detail.html's own slug mode) — trip.html reuses everything else
    // on this page but replaces the whole sidebar with real booking/payment
    // status instead (see renderTripSidebar), so it never has these ids.
    const bcDuration = document.getElementById('bc-duration');
    const bcGroupsize = document.getElementById('bc-groupsize');
    const bcDifficulty = document.getElementById('bc-difficulty');
    if(bcDuration) bcDuration.textContent = tour.duration_days + ' days';
    if(bcGroupsize) bcGroupsize.textContent = tour.group_size_min + '–' + tour.group_size_max + ' riders';
    if(bcDifficulty) bcDifficulty.textContent = 'Level ' + tour.difficulty_level + ' · ' + diffWord;

    document.getElementById('tour-overview').innerHTML =
      '<p>' + escapeHtml(tour.summary) + '</p>' +
      '<p>This is a Level ' + tour.difficulty_level + ' (' + escapeHtml(diffWord) + ') trip: ' + tour.duration_days +
      ' days and ' + tour.distance_km + 'km of ' + escapeHtml(tour.riding_style) + ' riding through ' + escapeHtml(tour.region) +
      ', climbing ' + tour.elevation_gain_m.toLocaleString() + 'm in total up to a high point of ' +
      tour.max_altitude_m.toLocaleString() + 'm.</p>';

    document.getElementById('tour-highlights').innerHTML = [
      { h:'Region', items:[tour.region] },
      { h:'Riding style', items: tour.riding_style.split('/').map(s => s.trim()).filter(Boolean) },
      { h:'Best season', items:[tour.best_season || 'Year-round'] },
      { h:'Group size', items:[tour.group_size_min + '–' + tour.group_size_max + ' riders'] },
    ].map(cell => `<div class="ride-cell"><h5>${escapeHtml(cell.h)}</h5><ul>${cell.items.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul></div>`).join('');

    document.querySelectorAll('#level-list .level-row').forEach(row => {
      row.classList.toggle('current', Number(row.dataset.level) === tour.difficulty_level);
    });
    document.getElementById('levels-current-label').textContent = 'Level ' + tour.difficulty_level;
  }

  function showLoadError(message){
    document.querySelector('.detail-hero').classList.add('hidden');
    document.querySelector('.quickbar').classList.add('hidden');
    document.querySelector('.section').classList.add('hidden');
    document.getElementById('tour-load-error-msg').textContent = message;
    document.getElementById('tour-load-error').classList.remove('hidden');
  }

  function renderSharedTourSections(tour){
    if(tour.days && tour.days.length){
      DAYS = normalizeFromApi(tour.days);
      if(dataSourceNote) dataSourceNote.textContent = 'Live from the database (' + API_BASE + ').';
      buildTabs();
      renderRouteMap(DAYS);
    } else {
      routeSection.classList.add('hidden');
      routeEmpty.classList.remove('hidden');
    }
    renderReviews(tour.reviews || []);
    renderTourGallery(tour);
    renderTourEquipment(tour);
    renderTourSafety(tour);
    renderTourCancellation(tour);
  }

  /** ?request=<id> mode — a signed-in rider viewing their OWN custom trip.
   *  Fetches the request + its active proposal (owner-checked), then the
   *  real base tour that proposal was built from for all the generic
   *  destination content (gallery, day-by-day route, difficulty, equipment,
   *  safety, cancellation) — but overrides duration/inclusions/exclusions
   *  and the entire booking sidebar with THIS proposal's actual agreed
   *  terms, never the tour's default listing. Once a deposit's been paid a
   *  real departure+booking exists too, so the assigned guide shown here is
   *  the real one, not just "guides who've led this tour before". This is
   *  the one page a rider's dashboard links to for a custom trip, so there's
   *  never a second, inconsistent view of the same trip to drift out of sync. */
  async function loadCustomTripView(requestId){
    const gate = document.getElementById('detail-signin-gate');
    if(typeof Auth === 'undefined' || !Auth.isSignedIn()){
      document.querySelector('.detail-hero').classList.add('hidden');
      document.querySelector('.quickbar').classList.add('hidden');
      document.querySelector('.section').classList.add('hidden');
      gate.classList.remove('hidden');
      document.getElementById('detail-signin-btn').addEventListener('click', () => Auth.requireSignIn(() => location.reload()));
      return;
    }
    gate.classList.add('hidden');

    let reqData;
    try { reqData = await apiGet('/api/riders/me/requests/' + encodeURIComponent(requestId)); }
    catch(err){ showLoadError('Could not load this custom trip. (' + err.message + ')'); return; }

    const proposal = reqData.active_proposal;
    const tourSlug = (proposal && proposal.tour) ? proposal.tour.slug : (reqData.based_on_tour ? reqData.based_on_tour.slug : null);
    if(!proposal || !tourSlug){
      showLoadError('This request doesn’t have a sent proposal yet — check back once our team has proposed an itinerary, or view its status from your dashboard.');
      return;
    }

    let tour;
    try { tour = await apiGet('/api/tours/' + encodeURIComponent(tourSlug)); }
    catch(err){ showLoadError('Could not load the tour this proposal is based on. (' + err.message + ')'); return; }

    let booking = null;
    if(reqData.booking_id){
      try { booking = await apiGet('/api/bookings/' + reqData.booking_id); } catch(err) { /* real dates/price below still come from the proposal either way */ }
    }

    // Duration/inclusions/exclusions come from the PROPOSAL when set — this
    // is the whole point of this page existing: never show the tour's
    // default listing values for a trip whose actual terms differ from it.
    const overrideTour = {
      ...tour,
      duration_days: proposal.duration_days || tour.duration_days,
      inclusions: (proposal.inclusions && proposal.inclusions.length) ? proposal.inclusions : tour.inclusions,
      exclusions: (proposal.exclusions && proposal.exclusions.length) ? proposal.exclusions : tour.exclusions,
    };
    renderTourHeader(overrideTour);
    document.getElementById('hero-title').innerHTML = 'Your custom trip<br>' + escapeHtml(tour.name);
    document.getElementById('crumb-name').textContent = 'Custom trip';
    document.title = 'Your custom trip — ' + tour.name + ' | High Route';

    renderSharedTourSections(tour);
    const dep = booking && booking.departure;
    // This is a private, bespoke departure — never fall back to the base
    // tour's generic guide roster here, or it looks like a specific person
    // has been assigned when nobody has been yet.
    renderTourGuides(dep && dep.guide_name ? [{
      id: reqData.booking_id, name: dep.guide_name, role: dep.guide_role, bio: dep.guide_bio, photo_url: dep.guide_photo_url,
      years_experience: dep.guide_years_experience, languages: dep.guide_languages, trips_led: dep.guide_trips_led, rating: dep.guide_rating,
    }] : [], 'Your dedicated guide will be assigned by our team ahead of departure.');
    renderInclusionsExclusions(overrideTour);
    renderCustomProposalSidebar(reqData, proposal, booking);
  }

  /* ==========================================================
     trip.html's two modes — everything below reuses this exact same page
     (renderTourHeader, the day-by-day route/elevation chart, guides,
     inclusions, equipment, safety, cancellation, reviews) verbatim; only
     the sidebar (real booking/payment status instead of "pick a date and
     book") and a couple of hero details differ. ?booking=<id> is always
     "manage" mode for that exact booking; ?departure=<id> looks up whether
     the signed-in rider already holds a non-cancelled booking on it
     (switches to manage mode if so — same as calendar.html linking here
     after they've already booked) or shows a "view & book" sidebar instead.
     ========================================================== */
  const tripDateFmt = s => new Date(s).toLocaleDateString(undefined, { day:'numeric', month:'long', year:'numeric' });
  const tripMoney = c => '€' + (c/100).toLocaleString(undefined, { minimumFractionDigits:0 });

  function showTripApp(){
    const gate = document.getElementById('trip-gate'), notFound = document.getElementById('trip-notfound'), app = document.getElementById('trip-app');
    if(gate) gate.classList.add('hidden');
    if(notFound) notFound.classList.add('hidden');
    if(app) app.classList.remove('hidden');
  }
  function showTripNotFound(message){
    const gate = document.getElementById('trip-gate'), notFound = document.getElementById('trip-notfound'), app = document.getElementById('trip-app');
    if(gate) gate.classList.add('hidden');
    if(app) app.classList.add('hidden');
    if(notFound){
      notFound.classList.remove('hidden');
      const msgEl = document.getElementById('trip-notfound-msg');
      if(msgEl && message) msgEl.textContent = message;
    }
  }

  function renderTripRiders(riders){
    const el = document.getElementById('trip-riders');
    if(!el) return;
    el.innerHTML = (riders || []).map(r => `
      <div class="dash-item">
        <div class="dash-item-head">
          <div><h4>${escapeHtml(r.name)}</h4>
            <div class="dash-meta">${r.riding_experience ? '<span>' + escapeHtml(r.riding_experience) + '</span>' : ''}${r.is_lead ? '<span>Lead rider</span>' : ''}</div>
          </div>
        </div>
      </div>`).join('') || '<p class="dash-empty">No rider details on file.</p>';
  }

  const TRIP_BOOKING_STATUS = {
    pending: { label:'Awaiting payment', color:'#E8B33D' }, deposit_paid: { label:'Deposit paid', color:'#6FA0B8' },
    completed: { label:'Fully paid', color:'#7FBF6B' }, cancelled: { label:'Cancelled', color:'#D9534F' },
  };
  function renderTripSidebarBooking(booking){
    const el = document.getElementById('trip-sidebar-content');
    if(!el) return;
    const st = TRIP_BOOKING_STATUS[booking.status] || { label: booking.status, color:'#C9C4B2' };
    const pct = booking.total_cents ? Math.min(100, Math.round((booking.amount_paid_cents / booking.total_cents) * 100)) : 0;
    el.innerHTML = `
      <div class="price">${tripMoney(booking.total_cents)} <span>total</span></div>
      <div class="bc-row"><span>Status</span><b style="color:${st.color};">${escapeHtml(st.label)}</b></div>
      <div class="bc-row"><span>Reference</span><b>${escapeHtml(booking.booking_reference || '')}</b></div>
      <div class="bc-row"><span>Paid so far</span><b>${tripMoney(booking.amount_paid_cents)} of ${tripMoney(booking.total_cents)}</b></div>
      <div class="dash-progress" style="margin:10px 0 4px;"><div class="dash-progress-fill" style="width:${pct}%;"></div></div>
      ${(booking.status === 'pending' || booking.status === 'deposit_paid') ? `<button class="btn btn-solid btn-block" style="margin-top:18px;" onclick="location.href='dashboard.html'">Pay from your dashboard</button>` : ''}
      <a href="invoice.html?booking=${booking.id}" class="btn btn-ghost btn-block" style="margin-top:12px;">View invoice</a>
      <a href="dashboard.html" class="btn btn-ghost btn-block" style="margin-top:10px;">Manage this booking</a>
      <p style="font-size:12px; color:var(--paper-dim); margin-top:18px; line-height:1.6;"><a href="cancellation-policy.html">Cancellation policy</a>.</p>`;
  }
  function renderTripSidebarDeparture(dep, tour){
    const el = document.getElementById('trip-sidebar-content');
    if(!el) return;
    const left = Math.max(0, dep.capacity - dep.seats_booked);
    const canBookNow = dep.status === 'open' || dep.status === 'few_spaces';
    const priceLabel = tour ? tripMoney(tour.price_from_cents) + ' / person' : 'Price on request';
    const availLabel = dep.status === 'full' ? 'Fully booked' : dep.status === 'request_only' ? 'Request-only'
      : dep.status === 'cancelled' ? 'This date has been cancelled' : left + (left === 1 ? ' spot left' : ' spots left');
    const btnLabel = canBookNow ? 'Book this departure' : dep.status === 'request_only' ? 'Request this date'
      : dep.status === 'full' ? 'Fully booked — ask about other dates' : 'Not bookable';
    el.innerHTML = `
      <div class="price">${priceLabel}</div>
      <div class="bc-row"><span>Availability</span><b style="color:${dep.status === 'full' ? '#D9534F' : '#7FBF6B'};">${escapeHtml(availLabel)}</b></div>
      <div class="bc-row"><span>Guide</span><b>${escapeHtml(dep.guide_name || 'To be confirmed')}</b></div>
      <button class="btn btn-solid btn-block" id="trip-book-btn" style="margin-top:20px;">${escapeHtml(btnLabel)}</button>
      <a href="build-adventure.html" class="btn btn-ghost btn-block" style="margin-top:12px;">Ask for a private departure instead</a>`;
    const btn = document.getElementById('trip-book-btn');
    if(dep.status === 'cancelled'){ btn.disabled = true; }
    else if(dep.status === 'full' || dep.status === 'request_only'){ btn.addEventListener('click', () => { location.href = 'build-adventure.html'; }); }
    else { btn.addEventListener('click', () => { window.location.href = 'checkout.html?departureId=' + dep.id; }); }
  }

  async function loadTripBookingView(bookingId){
    let booking;
    try { booking = await apiGet('/api/bookings/' + encodeURIComponent(bookingId)); }
    catch(err){ showTripNotFound(err.message); return; }
    const dep = booking.departure;
    showTripApp();
    if(new URLSearchParams(location.search).get('booked') === '1'){
      showToast('Booked! Deposit due: €' + (booking.deposit_cents/100).toLocaleString() + ' (demo only — no real payment was taken).', 'success');
      history.replaceState(null, '', location.pathname + '?booking=' + bookingId);
    }
    document.title = dep.tour_name + ' — My Trip | High Route MTB Nepal';
    document.getElementById('trip-dates').textContent = tripDateFmt(dep.start_date) + ' → ' + tripDateFmt(dep.end_date);
    const st = TRIP_BOOKING_STATUS[booking.status] || { label: booking.status, color:'#C9C4B2' };
    const statusEl = document.getElementById('trip-status');
    statusEl.textContent = st.label;
    statusEl.style.color = st.color;

    let tour;
    try { tour = await apiGet('/api/tours/' + encodeURIComponent(dep.tour_slug)); }
    catch(err){ showTripNotFound('Could not load this tour’s details. (' + err.message + ')'); return; }

    // Same override rule as loadCustomTripView above — an is_custom
    // departure's real negotiated length can differ from its base tour's
    // default, so the duration shown throughout this page must come from
    // the departure's own real dates, never the tour's listing default.
    const isCustom = dep.is_custom && dep.start_date && dep.end_date;
    const overrideTour = isCustom ? { ...tour, duration_days: Math.round((new Date(dep.end_date) - new Date(dep.start_date)) / 86400000) + 1 } : tour;
    renderTourHeader(overrideTour);
    document.getElementById('hero-title').innerHTML = isCustom ? 'Your custom trip<br>' + escapeHtml(tour.name) : escapeHtml(tour.name);
    document.getElementById('crumb-name').textContent = tour.name;

    renderSharedTourSections(tour);
    // Same rule as loadCustomTripView: a custom departure only ever shows the
    // guide actually appointed to it, never the base tour's generic roster.
    renderTourGuides(dep.guide_name ? [{
      id: dep.id, name: dep.guide_name, role: dep.guide_role, bio: dep.guide_bio, photo_url: dep.guide_photo_url,
      years_experience: dep.guide_years_experience, languages: dep.guide_languages, trips_led: dep.guide_trips_led, rating: dep.guide_rating,
    }] : (isCustom ? [] : (tour.guides || [])), isCustom ? 'Your dedicated guide will be assigned by our team ahead of departure.' : undefined);
    renderInclusionsExclusions(overrideTour);
    renderTripRiders(booking.riders);
    renderTripSidebarBooking(booking);
  }

  /** "View & book" mode — no booking yet: same page, built straight from
   *  the departure + tour, with a Book CTA in the sidebar in place of
   *  booking/payment status. No rider list (that's other people's booking
   *  data, not this visitor's) — there's nothing to manage yet. */
  async function loadTripDepartureView(departureId){
    let dep;
    try { dep = await apiGet('/api/departures/' + encodeURIComponent(departureId)); }
    catch(err){ showTripNotFound(err.message); return; }
    showTripApp();
    document.title = dep.tour_name + ' — My Trip | High Route MTB Nepal';
    document.getElementById('trip-dates').textContent = tripDateFmt(dep.start_date) + ' → ' + tripDateFmt(dep.end_date);
    const DEP_ST = { open:{label:'Open',color:'#7FBF6B'}, few_spaces:{label:'Few spaces left',color:'#E8B33D'}, full:{label:'Fully booked',color:'#D9534F'}, request_only:{label:'Request-only',color:'#6FA0B8'}, cancelled:{label:'Cancelled',color:'#8a8a8a'} };
    const st = DEP_ST[dep.status] || { label: dep.status_label || dep.status, color:'#C9C4B2' };
    const statusEl = document.getElementById('trip-status');
    statusEl.textContent = st.label;
    statusEl.style.color = st.color;

    let tour = null;
    try { tour = await apiGet('/api/tours/' + encodeURIComponent(dep.tour_slug)); } catch(err) { /* renderTourHeader below needs it — fall through to not-found */ }
    if(!tour){ showTripNotFound('Could not load this tour’s details.'); return; }

    renderTourHeader(tour);
    document.getElementById('hero-title').textContent = tour.name;
    document.getElementById('crumb-name').textContent = tour.name;
    renderSharedTourSections(tour);
    renderTourGuides(dep.guide_name ? [{
      id: dep.id, name: dep.guide_name, role: dep.guide_role, bio: dep.guide_bio, photo_url: dep.guide_photo_url,
      years_experience: dep.guide_years_experience, languages: dep.guide_languages, trips_led: dep.guide_trips_led, rating: dep.guide_rating,
    }] : (dep.is_custom ? [] : (tour.guides || [])), dep.is_custom ? 'Your dedicated guide will be assigned by our team ahead of departure.' : undefined);
    renderInclusionsExclusions(tour);
    const ridersHeading = document.getElementById('trip-riders-heading');
    if(ridersHeading) ridersHeading.classList.add('hidden');
    document.getElementById('trip-riders').classList.add('hidden');
    renderTripSidebarDeparture(dep, tour);
  }

  async function loadTripView(bookingId, departureId){
    if(bookingId){
      if(typeof Auth === 'undefined' || !Auth.isSignedIn()){
        const gate = document.getElementById('trip-gate');
        if(gate) gate.classList.remove('hidden');
        const btn = document.getElementById('trip-signin-btn');
        if(btn) btn.addEventListener('click', () => Auth.requireSignIn(() => location.reload()));
        return;
      }
      return loadTripBookingView(bookingId);
    }
    if(departureId){
      if(typeof Auth !== 'undefined' && Auth.isSignedIn()){
        try {
          const mine = await apiGet('/api/riders/me/bookings');
          const existing = mine.bookings.find(b => b.departure_id === Number(departureId) && b.status !== 'cancelled');
          if(existing) return loadTripBookingView(existing.id);
        } catch(err) { /* fall through to view/book mode */ }
      }
      return loadTripDepartureView(departureId);
    }
    showTripNotFound('No trip or departure specified.');
  }

  const bookingId = params.get('booking');
  const departureId = params.get('departure');

  if(bookingId || departureId){
    loadTripView(bookingId, departureId);
  } else if(requestId){
    loadCustomTripView(requestId);
  } else {
    apiGet('/api/tours/' + encodeURIComponent(slug)).then(tour => {
      renderTourHeader(tour);
      renderSharedTourSections(tour);
      renderBookingSidebar(tour);
      renderTourGuides(tour.guides || []);
      renderInclusionsExclusions(tour);
    }).catch(err => {
      if(slug === 'upper-mustang'){
        // Preserves the original offline-demo behaviour for the one tour that
        // ships hand-written fallback data, so the page still works with no
        // backend running at all.
        renderTourHeader(FALLBACK_TOUR_META);
        DAYS = FALLBACK_ROUTE_DAYS;
        if(dataSourceNote) dataSourceNote.innerHTML = 'Backend not reachable at <code>' + escapeHtml(API_BASE) + '</code> — showing offline preview data. (' + escapeHtml(err.message) + ')';
        buildTabs();
        renderRouteMap(DAYS);
        // The offline fallback has no gallery/guides/inclusions/equipment/
        // safety/cancellation data at all — render each section's real empty
        // state rather than leaving it stuck on "Loading…".
        renderTourGallery(FALLBACK_TOUR_META);
        renderTourGuides([]);
        renderInclusionsExclusions(FALLBACK_TOUR_META);
        renderTourEquipment(FALLBACK_TOUR_META);
        renderTourSafety(FALLBACK_TOUR_META);
        renderTourCancellation(FALLBACK_TOUR_META);
      } else {
        showLoadError('Backend not reachable at ' + API_BASE + ', or "' + slug + '" doesn\'t exist. (' + err.message + ')');
      }
    });
  }

  const panel = {
    title: document.getElementById('day-title'),
    desc: document.getElementById('day-desc'),
    dist: document.getElementById('day-dist'),
    gain: document.getElementById('day-gain'),
    loss: document.getElementById('day-loss'),
    high: document.getElementById('day-high'),
    hours: document.getElementById('day-hours'),
  };
  const canvas = document.getElementById('elev-chart');
  const tooltip = document.getElementById('elev-tooltip');
  const ctx = canvas.getContext('2d');

  function drawChart(profile){
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w*dpr; canvas.height = h*dpr;
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,w,h);

    const min = Math.min(...profile) - 100, max = Math.max(...profile) + 100;
    const pad = 20;
    const stepX = (w - pad*2) / (profile.length - 1);
    const yFor = v => h - pad - ((v-min)/(max-min)) * (h - pad*2);
    const pts = profile.map((v,i) => ({ x: pad + i*stepX, y: yFor(v) }));

    // Traces a smoothed terrain line through midpoints (quadratic curve
    // technique) instead of sharp straight-line segments between sampled
    // elevation points — reads as a natural silhouette. Shared by the fill
    // and the stroke below so their edges always line up exactly.
    function tracePath(){
      ctx.moveTo(pts[0].x, pts[0].y);
      for(let i=1;i<pts.length-1;i++){
        const mx = (pts[i].x + pts[i+1].x) / 2, my = (pts[i].y + pts[i+1].y) / 2;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      ctx.lineTo(pts[pts.length-1].x, pts[pts.length-1].y);
    }

    // filled area
    ctx.beginPath();
    tracePath();
    ctx.lineTo(pts[pts.length-1].x, h-pad);
    ctx.lineTo(pts[0].x, h-pad);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0,0,0,h);
    grad.addColorStop(0, 'rgba(44,110,116,0.32)');
    grad.addColorStop(1, 'rgba(44,110,116,0)');
    ctx.fillStyle = grad;
    ctx.fill();

    // line, with a soft glacier-teal glow
    ctx.beginPath();
    tracePath();
    ctx.strokeStyle = '#2C6E74';
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(44,110,116,0.45)';
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // points — a filled dot ringed in ink so it reads clearly against the fill
    pts.forEach(({x,y}) => {
      ctx.beginPath(); ctx.arc(x,y,5,0,Math.PI*2); ctx.fillStyle = 'rgba(36,32,26,0.92)'; ctx.fill();
      ctx.beginPath(); ctx.arc(x,y,2.5,0,Math.PI*2); ctx.fillStyle = '#FAF6EC'; ctx.fill();
    });

    canvas._chartMeta = { profile, min, max, pad, stepX, w, h, yFor };
  }

  function selectDay(i){
    const d = DAYS[i];
    if(!d) return;
    [...tabWrap.children].forEach((c,ci) => c.classList.toggle('active', ci===i));
    panel.title.textContent = 'DAY ' + d.day + ' — ' + d.title;
    panel.desc.textContent = d.terrain + '. Overnight near ' + d.place + '.';
    panel.dist.textContent = d.dist + ' km';
    panel.gain.textContent = '+' + d.gain.toLocaleString() + ' m';
    panel.loss.textContent = '−' + d.loss.toLocaleString() + ' m';
    panel.high.textContent = d.high.toLocaleString() + ' m';
    panel.hours.textContent = d.hours + ' hrs';
    drawChart(d.profile);
  }

  window.addEventListener('resize', () => {
    const active = tabWrap.querySelector('.active');
    const idx = active ? [...tabWrap.children].indexOf(active) : 0;
    if(DAYS[idx]) drawChart(DAYS[idx].profile);
  });

  canvas.addEventListener('mousemove', e => {
    const meta = canvas._chartMeta;
    if(!meta) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const idx = Math.round((mx - meta.pad) / meta.stepX);
    const clamped = Math.max(0, Math.min(meta.profile.length-1, idx));
    const val = meta.profile[clamped];
    const x = meta.pad + clamped*meta.stepX;
    const y = meta.yFor(val);
    tooltip.style.opacity = '1';
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
    tooltip.innerHTML = '<b>' + val.toLocaleString() + ' m</b> · ' + (clamped+1) + 'h in';
  });
  canvas.addEventListener('mouseleave', () => { tooltip.style.opacity = '0'; });
})();

/** Renders the live reviews list on tour-detail.html from /api/tours/:slug reviews[]. */
function renderReviews(reviews){
  const el = document.getElementById('tour-reviews');
  if(!el) return;
  if(!reviews.length){
    el.innerHTML = '<p style="color:var(--paper-dim); font-size:14px;">No reviews yet for this departure — be the first to ride it and tell us how it went.</p>';
    return;
  }
  const bar = (label, score) => `<div class="review-bar">${label}<div class="track"><div class="fill" style="width:${(score||0)*20}%"></div></div></div>`;
  el.innerHTML = reviews.map(r => `
    <div class="review-card" style="min-width:0; margin-bottom:16px;">
      <div class="review-bars">
        ${bar('Riding', r.riding_score)}${bar('Guide', r.guide_score)}${bar('Scenery', r.scenery_score)}${bar('Organisation', r.organization_score)}
      </div>
      <p class="review-quote">${escapeHtml(r.quote || '')}</p>
      <span class="review-who">${escapeHtml(r.rider_name)}</span>
    </div>`).join('');
}

/** Fills in the sticky booking sidebar on tour-detail.html with live price and
 *  a real date picker built from every one of this tour's admin-created
 *  departures — not just whichever one happens to sort first. Only future,
 *  non-cancelled departures are offered (a departure whose dates have already
 *  passed can't be booked, matching the same cutoff bookings.js enforces
 *  server-side), so what a rider sees here always matches what's actually
 *  bookable, no matter how many dates the admin has scheduled for this tour. */
function renderBookingSidebar(tour){
  const now = new Date();
  const futureDeps = (tour.departures || [])
    .filter(d => d.status !== 'cancelled' && new Date(d.end_date) >= now)
    .sort((a, b) => new Date(a.start_date) - new Date(b.start_date));

  const priceEl = document.getElementById('bc-price');
  const selectEl = document.getElementById('bc-date-select');
  const availEl = document.getElementById('bc-avail');
  const guideEl = document.getElementById('bc-guide');
  const bookBtn = document.getElementById('bc-book-btn');
  if(priceEl) priceEl.innerHTML = '€' + (tour.price_from_cents/100).toLocaleString() + ' <span>/ person</span>';

  function currentDep(){
    return selectEl ? futureDeps.find(d => d.id === Number(selectEl.value)) : null;
  }
  function refreshAvailability(){
    const dep = currentDep();
    if(!dep) return;
    const left = dep.capacity - dep.seats_booked;
    const label = dep.status === 'full' ? 'Fully booked' : dep.status === 'request_only' ? 'Request-only' : left + ' spaces left';
    const color = dep.status === 'full' ? '#D9534F' : dep.status === 'request_only' ? '#6FA0B8' : '#7FBF6B';
    if(availEl){ availEl.textContent = label; availEl.style.color = color; }
    if(guideEl) guideEl.textContent = dep.guide_name || 'To be confirmed';
    if(bookBtn){
      if(dep.status === 'open' || dep.status === 'few_spaces'){
        bookBtn.textContent = 'Book this adventure';
        bookBtn.href = '#';
      } else {
        bookBtn.textContent = dep.status === 'full' ? 'Fully booked — ask about other dates' : 'Request this date';
        bookBtn.href = 'build-adventure.html';
      }
    }
  }

  if(selectEl){
    if(futureDeps.length){
      selectEl.innerHTML = futureDeps.map(d => {
        const dateLabel = new Date(d.start_date).toLocaleDateString(undefined, { day:'numeric', month:'short', year:'numeric' });
        const left = d.capacity - d.seats_booked;
        const tag = d.status === 'full' ? 'Full' : d.status === 'request_only' ? 'Request-only' : left + ' left';
        return `<option value="${d.id}">${dateLabel} — ${tag}</option>`;
      }).join('');
      selectEl.disabled = false;
      selectEl.onchange = refreshAvailability;
      refreshAvailability();
    } else {
      selectEl.innerHTML = '<option>None scheduled yet</option>';
      selectEl.disabled = true;
      if(availEl){ availEl.textContent = 'Ask us about dates'; availEl.style.color = '#6FA0B8'; }
      if(guideEl) guideEl.textContent = '—';
      if(bookBtn){ bookBtn.textContent = 'Ask for a private departure'; bookBtn.href = 'build-adventure.html'; }
    }
  }

  if(bookBtn){
    bookBtn.onclick = (e) => {
      const dep = currentDep();
      if(!dep) return; // no future departures — let the href navigate to build-adventure.html
      e.preventDefault();
      if(dep.status === 'full' || dep.status === 'request_only'){ window.location.href = 'build-adventure.html'; return; }
      // The real checkout flow (rider count, rider details, add-ons, promo
      // code, review) lives on its own page — this button just hands off
      // the chosen departure to it. Booking is tied to a rider account, so
      // checkout.html itself gates on sign-in before showing any steps.
      window.location.href = 'checkout.html?departureId=' + dep.id;
    };
  }
}

/** Replaces the sticky booking sidebar with a proposal summary when
 *  tour-detail.html is opened as ?request=<id> (see the boot IIFE below) —
 *  the base tour's default listed price/duration/departures never apply to
 *  a custom trip, so this always shows the SPECIFIC terms this rider's own
 *  proposal actually carries, plus real payment/booking/guide status once
 *  they exist. Approve/decline/pay stay on the dashboard, which already
 *  owns those flows — this page only links back to it, never duplicates them. */
function renderCustomProposalSidebar(reqData, proposal, booking){
  const aside = document.getElementById('book');
  if(!aside) return;
  const money = c => '€' + (c/100).toLocaleString(undefined, { minimumFractionDigits:0 });
  const dateFmt = s => new Date(s).toLocaleDateString(undefined, { day:'numeric', month:'long', year:'numeric' });
  const STATUS_LABEL = {
    sent: 'Awaiting your review', approved: 'Approved', declined: 'Declined',
    changes_requested: 'Changes requested', expired: 'Expired', withdrawn: 'Withdrawn',
  };
  const BOOKING_STATUS_LABEL = { pending: 'Awaiting payment', deposit_paid: 'Deposit paid', completed: 'Fully paid', cancelled: 'Cancelled' };

  let statusLine, cta;
  if(booking){
    statusLine = 'Trip confirmed — ' + escapeHtml(BOOKING_STATUS_LABEL[booking.status] || booking.status);
    cta = `<a href="invoice.html?booking=${reqData.booking_id}" class="btn btn-solid btn-block" style="margin-top:20px;">View invoice</a>
           <a href="dashboard.html" class="btn btn-ghost btn-block" style="margin-top:10px;">Manage from your dashboard</a>`;
  } else {
    statusLine = escapeHtml(STATUS_LABEL[proposal.status] || proposal.status);
    cta = `<a href="dashboard.html" class="btn btn-solid btn-block" style="margin-top:20px;">Respond from your dashboard</a>`;
  }
  const amountPaid = reqData.amount_paid_cents || 0;
  const dep = booking && booking.departure;

  aside.innerHTML = `
    <div class="price">${money(proposal.price_cents)} <span>/ trip</span></div>
    <div class="bc-row"><span>Status</span><b>${statusLine}</b></div>
    <div class="bc-row"><span>Departure date</span><b>${proposal.start_date ? dateFmt(proposal.start_date) : 'To be confirmed'}</b></div>
    <div class="bc-row"><span>Duration</span><b>${proposal.duration_days ? proposal.duration_days + ' days' : '—'}</b></div>
    <div class="bc-row"><span>Deposit</span><b>${money(proposal.deposit_cents)} (${proposal.deposit_percent}%)</b></div>
    ${amountPaid > 0 ? `<div class="bc-row"><span>Paid so far</span><b>${money(amountPaid)} of ${money(proposal.price_cents)}</b></div>` : ''}
    ${dep && dep.guide_name ? `<div class="bc-row"><span>Guide</span><b>${escapeHtml(dep.guide_name)}</b></div>` : ''}
    ${cta}
    <p style="font-size:12px; color:var(--paper-dim); margin-top:18px; line-height:1.6;">Priced and scheduled exactly as agreed in your proposal — not this tour's standard listing. <a href="cancellation-policy.html">Cancellation policy</a>.</p>
  `;
}

/* ============================================================
   TOUR-DETAIL PAGE — route map, gallery, guides, inclusions/exclusions,
   equipment, safety and cancellation sections. Each function below no-ops
   if its target element isn't on the page (so this file stays safe to
   include everywhere), and each renders an honest empty state — never
   placeholder copy — when the admin hasn't filled that content in yet.
   ============================================================ */

/** Plots a tour's day-by-day route from whatever REAL overnight_lat/lng the
 *  admin has actually entered (see tour_days in schema.sql) — never
 *  fabricated or interpolated. Reuses the exact same fixed-bounding-box
 *  linear projection technique as the homepage Nepal map (see the
 *  DYNAMIC MAP PINS block below), just rescaled to this tour's own
 *  coordinate range instead of the whole country. Days without coordinates
 *  are skipped in the plotted line (never bridged across a gap) and called
 *  out by name in the note underneath, so missing data is visible rather
 *  than silently smoothed over. */
function renderRouteMap(days){
  const svg = document.getElementById('route-map');
  const note = document.getElementById('route-map-note');
  if(!svg) return;

  const withCoords = days.filter(d => d.lat != null && d.lng != null);
  const withoutCoords = days.filter(d => d.lat == null || d.lng == null);

  if(!withCoords.length){
    svg.classList.add('hidden');
    svg.innerHTML = '';
    if(note) note.textContent = 'No GPS coordinates have been recorded for this itinerary yet — a map isn\'t available for this tour.';
    return;
  }

  const lats = withCoords.map(d => d.lat), lngs = withCoords.map(d => d.lng);
  const padLat = Math.max((Math.max(...lats) - Math.min(...lats)) * 0.15, 0.03);
  const padLng = Math.max((Math.max(...lngs) - Math.min(...lngs)) * 0.15, 0.03);
  const latMin = Math.min(...lats) - padLat, latMax = Math.max(...lats) + padLat;
  const lngMin = Math.min(...lngs) - padLng, lngMax = Math.max(...lngs) + padLng;
  const W = 600, H = 400;
  const project = (lat, lng) => ({
    x: ((lng - lngMin) / (lngMax - lngMin)) * W,
    y: H - ((lat - latMin) / (latMax - latMin)) * H, // north = up
  });

  // Consecutive days that both have coordinates are joined by a line;
  // a day missing coordinates breaks the line into a new segment rather
  // than being bridged over (that would imply a route position we don't
  // actually have).
  const segments = [];
  let current = [];
  days.forEach(d => {
    if(d.lat != null && d.lng != null){ current.push(d); }
    else if(current.length){ segments.push(current); current = []; }
  });
  if(current.length) segments.push(current);

  const polylines = segments.filter(seg => seg.length > 1).map(seg =>
    `<polyline class="route-map-line" points="${seg.map(d => { const p = project(d.lat, d.lng); return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' ')}"/>`
  ).join('');

  const firstDay = withCoords[0], lastDay = withCoords[withCoords.length - 1];
  const pins = withCoords.map(d => {
    const p = project(d.lat, d.lng);
    const isStart = d === firstDay, isEnd = d === lastDay && lastDay !== firstDay;
    const variant = isStart ? 'route-pin route-pin-start' : isEnd ? 'route-pin route-pin-end' : 'route-pin';
    const label = isStart ? 'Start' : isEnd ? 'Finish' : 'Day ' + d.day;
    return `<g class="${variant}">
      <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${isStart || isEnd ? 8 : 5}"/>
      <text x="${p.x.toFixed(1)}" y="${(p.y - 13).toFixed(1)}" text-anchor="middle">${escapeHtml(label)}</text>
    </g>`;
  }).join('');

  svg.innerHTML = polylines + pins;
  svg.classList.remove('hidden');

  const parts = ['Approximate overnight-stop positions for trip planning — not surveyed GPS data.'];
  if(withoutCoords.length){
    parts.push('No GPS position recorded for ' + withoutCoords.map(d => 'Day ' + d.day + ' (' + d.place + ')').join(', ') + ' — not plotted above.');
  }
  if(note) note.textContent = parts.join(' ');
}

/** Tour-specific photo gallery (category='tour', this tour's id) — same
 *  shape logic as the homepage gallery grid, wired to the shared lightbox. */
function renderTourGallery(tour){
  const grid = document.getElementById('tour-gallery');
  const status = document.getElementById('tour-gallery-status');
  if(!grid) return;
  if(!tour.id){ // offline-fallback tour object has no real id to query images for
    grid.innerHTML = '';
    if(status) status.textContent = 'No photos have been added for this tour yet.';
    return;
  }
  apiGet('/api/gallery?category=tour&tourId=' + tour.id).then(data => {
    if(!data.images.length){
      grid.innerHTML = '';
      if(status) status.textContent = 'No photos have been added for this tour yet.';
      return;
    }
    if(status) status.classList.add('hidden');
    grid.innerHTML = data.images.map((im, i) => {
      const shapeClass = i === 0 ? 'g-tall' : i === 3 ? 'g-wide' : '';
      return `<a href="#" class="${shapeClass}" data-index="${i}"><img src="${escapeHtml(im.image_url)}" alt="${escapeHtml(im.caption || tour.name + ' photo')}" loading="lazy"></a>`;
    }).join('');
    grid.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        openLightbox(data.images, Number(a.dataset.index));
      });
    });
  }).catch(() => {
    grid.innerHTML = '';
    if(status) status.textContent = 'Couldn\'t load photos for this tour right now.';
  });
}

/** Full guide profile(s) for every guide who has ever led a departure of
 *  this tour (deduped server-side — see GET /api/tours/:slug). Only
 *  verified qualifications are ever shown here, per the "if verified" rule
 *  — an admin can record an unverified claim without it appearing publicly. */
function renderTourGuides(guides, emptyMessage){
  const grid = document.getElementById('tour-guides');
  const status = document.getElementById('tour-guides-status');
  if(!grid) return;
  if(!guides.length){
    grid.innerHTML = '';
    if(status) status.textContent = emptyMessage || 'Guides are assigned once departures are scheduled for this tour — check the dates in the booking panel, or ask us directly.';
    return;
  }
  if(status) status.classList.add('hidden');
  grid.innerHTML = guides.map(g => {
    const verifiedQuals = (g.qualifications || []).filter(q => q.verified);
    return `<div class="guide-card">
      <div class="guide-photo"><img src="${escapeHtml(g.photo_url || 'https://images.unsplash.com/photo-1628182602283-8219f0e78a10?auto=format&fit=crop&w=800&q=80')}" alt="Portrait of ${escapeHtml(g.name)}"></div>
      <div class="guide-info">
        <h3>${escapeHtml(g.name)}</h3>
        <span class="guide-role">${escapeHtml(g.role)}</span>
        <div class="guide-stats">
          <div><b>${g.years_experience}</b>years experience</div>
          <div><b>${g.trips_led}+</b>trips led</div>
          <div><b>${g.rating}</b>rider rating</div>
        </div>
        <p>${escapeHtml(g.bio || '')}</p>
        <p style="font-size:13px;"><b style="color:var(--paper);">Languages:</b> ${escapeHtml(g.languages || 'Not specified')}</p>
        ${verifiedQuals.length ? `<p style="font-size:13px;"><b style="color:var(--paper);">Qualifications:</b> ${verifiedQuals.map(q => escapeHtml(q.title)).join(', ')}</p>` : ''}
      </div>
    </div>`;
  }).join('');
}

/** Structured inclusions/exclusions lists — [] renders as an honest
 *  "not yet specified" line rather than an empty, confusing blank list. */
function renderInclusionsExclusions(tour){
  const incEl = document.getElementById('tour-inclusions');
  const excEl = document.getElementById('tour-exclusions');
  if(!incEl || !excEl) return;
  const listOrEmpty = (items) => items && items.length
    ? items.map(i => `<li>${escapeHtml(i)}</li>`).join('')
    : '<li style="color:var(--paper-dim);">Not yet specified — ask us for details.</li>';
  incEl.innerHTML = listOrEmpty(tour.inclusions);
  excEl.innerHTML = listOrEmpty(tour.exclusions);
}

/** Essential vs. recommended equipment checklist — same empty-state rule. */
function renderTourEquipment(tour){
  const essEl = document.getElementById('tour-equipment-essential');
  const recEl = document.getElementById('tour-equipment-recommended');
  if(!essEl || !recEl) return;
  const listOrEmpty = (items) => items && items.length
    ? items.map(i => `<li>${escapeHtml(i)}</li>`).join('')
    : '<li style="color:var(--paper-dim);">Not yet specified — ask us for details.</li>';
  essEl.innerHTML = listOrEmpty(tour.equipment_essential);
  recEl.innerHTML = listOrEmpty(tour.equipment_recommended);
}

/** Tour-specific hazards/preparation/emergency info. Each of the three is
 *  shown only if the admin actually entered it — no fabricated "generic
 *  hazards" copy — and if none of the three are set, one honest empty-state
 *  line replaces the whole section (the "full safety policy" link next to
 *  this section always stays visible either way). */
function renderTourSafety(tour){
  const el = document.getElementById('tour-safety');
  if(!el) return;
  const rows = [
    ['Hazards', tour.safety_hazards],
    ['Preparation', tour.safety_preparation],
    ['Emergency information', tour.safety_emergency],
  ].filter(([, v]) => v);
  el.innerHTML = rows.length
    ? `<div class="ride-grid" style="grid-template-columns:1fr;">${rows.map(([h, v]) =>
        `<div class="ride-cell"><h5>${escapeHtml(h)}</h5><p style="margin:0; color:var(--paper-dim); font-size:14px;">${escapeHtml(v)}</p></div>`).join('')}</div>`
    : '<p style="color:var(--paper-dim); font-size:14px;">Tour-specific safety notes haven\'t been published for this trip yet — see our general safety policy below, or contact us with questions.</p>';
}

/** Tour-specific cancellation terms, if the admin has configured any —
 *  never presents unconfigured refund/cancellation terms as fact. The
 *  baseline mechanics quoted here (20% deposit, automatic tiered refund
 *  calculation on cancellation) describe what this booking system actually
 *  does, not a marketing claim — see computeRefundEntitlement() in
 *  routes/bookings.js and the admin-configurable cancellation_rules table. */
function renderTourCancellation(tour){
  const el = document.getElementById('tour-cancellation');
  if(!el) return;
  const specific = tour.cancellation_policy
    ? `<p>${escapeHtml(tour.cancellation_policy)}</p>`
    : '<p style="color:var(--paper-dim);">No tour-specific cancellation terms have been published for this trip.</p>';
  el.innerHTML = specific +
    '<p style="font-size:14px;">A 20% deposit secures your booking; the remaining balance is due before departure. ' +
    'If you cancel from your dashboard, any refund on what you\'ve already paid is calculated automatically from how far in advance you cancel — a refund still needs an admin to confirm the money has actually been sent back before it\'s marked paid out.</p>';
}

/* ============================================================
   LIGHTBOX — shared full-size image viewer for any gallery grid on the
   site (currently used by the tour-detail photo gallery). Keyboard
   (Escape / arrow keys), backdrop click, and a close button all dismiss
   or navigate it; built from scratch since this codebase deliberately
   ships no UI library.
   ============================================================ */
function openLightbox(images, startIndex){
  let index = startIndex;
  const overlay = document.createElement('div');
  overlay.className = 'auth-overlay lightbox-overlay';
  overlay.innerHTML = `
    <div class="lightbox-modal">
      <button type="button" class="auth-close lightbox-close" aria-label="Close">&times;</button>
      <button type="button" class="lightbox-nav lightbox-prev" aria-label="Previous photo">&#8249;</button>
      <img class="lightbox-img" src="" alt="">
      <button type="button" class="lightbox-nav lightbox-next" aria-label="Next photo">&#8250;</button>
      <p class="lightbox-caption"></p>
    </div>`;
  document.body.appendChild(overlay);
  document.body.classList.add('nav-open'); // reuses the existing body-scroll-lock class

  const img = overlay.querySelector('.lightbox-img');
  const caption = overlay.querySelector('.lightbox-caption');
  function show(i){
    index = (i + images.length) % images.length;
    const im = images[index];
    img.src = im.image_url;
    img.alt = im.caption || '';
    caption.textContent = im.caption || '';
  }
  function close(){
    document.body.classList.remove('nav-open');
    document.removeEventListener('keydown', onKeydown);
    overlay.remove();
  }
  function onKeydown(e){
    if(e.key === 'Escape') close();
    else if(e.key === 'ArrowLeft') show(index - 1);
    else if(e.key === 'ArrowRight') show(index + 1);
  }
  overlay.addEventListener('click', e => { if(e.target === overlay) close(); });
  overlay.querySelector('.lightbox-close').addEventListener('click', close);
  overlay.querySelector('.lightbox-prev').addEventListener('click', () => show(index - 1));
  overlay.querySelector('.lightbox-next').addEventListener('click', () => show(index + 1));
  document.addEventListener('keydown', onKeydown);
  show(index);
}

/* ============================================================
   DYNAMIC TOUR CARDS — fills any element with id="tour-grid"
   (used on index.html's featured section and tours.html's full
   catalogue) by fetching straight from /api/tours. Falls back to
   whatever static markup was already in the container if the very
   first request can't reach the API, so the page still works offline.

   On tours.html, the filters-panel sidebar (Duration/Difficulty/Riding
   style/Destination/Season/Group type/Budget/Max altitude) is read into
   real /api/tours query params and re-fetched on every change — filtering
   happens in the database, not in this file — and the current selection
   is mirrored into the URL so it's shareable/bookmarkable.
   ============================================================ */
(function(){
  const grid = document.getElementById('tour-grid');
  if(!grid) return;

  const SLUG_ANCHOR = {
    'upper-mustang':'tour-mustang', 'annapurna-epic':'tour-annapurna', 'kathmandu-valley-explorer':'tour-kathmandu',
    'langtang-forest-flow':'tour-langtang', 'manaslu-wilderness-traverse':'tour-manaslu', 'pokhara-lakeside-flow':'tour-pokhara',
  };
  const LEVEL_WORD = { 1:'Explorer', 2:'Trail Rider', 3:'Mountain Rider', 4:'Enduro', 5:'Expedition' };

  /** Availability pip/text for a tour card. Distinguishes three states the
   *  backend tells apart: a real upcoming departure (show its seats/status),
   *  a tour that HAS departures but none upcoming (all past/cancelled), and
   *  a tour that has never had a departure scheduled at all. */
  function availability(t){
    const dep = t.next_departure;
    if(dep){
      if(dep.status === 'full') return { pip:'pip-red', text:'Fully booked' };
      if(dep.status === 'request_only') return { pip:'pip-amber', text:'Request-only' };
      const left = dep.capacity - dep.seats_booked;
      return { pip: left <= 3 ? 'pip-amber' : 'pip-green', text: left + (left === 1 ? ' space left' : ' spaces left') };
    }
    return t.has_departures
      ? { pip:'pip-amber', text:'No upcoming dates' }
      : { pip:'pip-amber', text:'Dates on request' };
  }

  function nextDepartureLabel(t){
    if(!t.next_departure) return null;
    return new Date(t.next_departure.start_date).toLocaleDateString(undefined, { day:'numeric', month:'short', year:'numeric' });
  }

  function cardHtml(t){
    const avail = availability(t);
    const id = SLUG_ANCHOR[t.slug] || ('tour-' + t.slug);
    const img = t.image_url || 'https://images.unsplash.com/photo-1652361561822-b2aa3f30416a?auto=format&fit=crop&w=1200&q=80';
    const detailHref = 'tour-detail.html?slug=' + encodeURIComponent(t.slug);
    const nextDep = nextDepartureLabel(t);
    const metaBits = [`${t.duration_days} days`, escapeHtml(t.riding_style)];
    if(t.riding_hours_summary) metaBits.push(escapeHtml(t.riding_hours_summary));
    if(t.best_season) metaBits.push(escapeHtml(t.best_season));
    return `<article class="tour-card" id="${escapeHtml(id)}">
      <div class="tour-media"><img src="${escapeHtml(img)}" alt="${escapeHtml(t.name)}">
        <span class="tour-tag">Level ${t.difficulty_level} · ${escapeHtml(LEVEL_WORD[t.difficulty_level] || '')}</span>
        <span class="avail"><span class="pip ${avail.pip}"></span>${escapeHtml(avail.text)}</span>
        <span class="tour-loc">${escapeHtml(t.region)}</span></div>
      <div class="tour-body"><h3>${escapeHtml(t.name)}</h3>
        <div class="tour-meta"><span>${metaBits.join('</span><span>')}</span></div>
        <div class="tour-stats">
          <div><b>${t.distance_km}km</b><span>riding</span></div>
          <div><b>${t.elevation_gain_m.toLocaleString()}m</b><span>climbing</span></div>
          <div><b>${t.max_altitude_m.toLocaleString()}m</b><span>max alt.</span></div>
        </div>
        <div class="tour-foot">
          <div class="tour-price">From <b>€${(t.price_from_cents/100).toLocaleString()}</b></div>
          <a href="${detailHref}" class="tour-link">View adventure</a>
        </div>
      </div>
      ${nextDep ? `<p class="tour-next-dep">Next departure: ${escapeHtml(nextDep)}</p>` : ''}
    </article>`;
  }

  function renderGrid(tours){
    grid.innerHTML = tours.map(cardHtml).join('') || '<p class="tour-grid-status">No tours match these filters — try widening your search.</p>';
    const countEl = document.getElementById('tour-count');
    if(countEl) countEl.textContent = tours.length + (tours.length === 1 ? ' tour' : ' tours');
    window.initTourTilt();
  }

  /* tours.html only: reads the filters-panel sidebar into real /api/tours
     query params (server-side filtering), keeps the URL in sync with the
     current selection, and re-fetches on every change. */
  function setupFilters(){
    const panel = document.getElementById('filters-panel');
    if(!panel) return null;

    const checkboxes = [...panel.querySelectorAll('input[type=checkbox][data-filter]')];
    const budgetMin = document.getElementById('f-budget-min');
    const budgetMax = document.getElementById('f-budget-max');
    const maxAltitude = document.getElementById('f-max-altitude');

    function applyFromQuery(){
      const params = new URLSearchParams(location.search);
      checkboxes.forEach(cb => {
        const qVal = params.get(cb.dataset.filter);
        if(!qVal) return;
        const selected = qVal.split(',').map(v => v.trim().toLowerCase());
        const ownTokens = cb.value.split(',').map(v => v.trim().toLowerCase());
        if(ownTokens.some(t => selected.includes(t))) cb.checked = true;
      });
      if(budgetMin && params.get('minBudget')) budgetMin.value = params.get('minBudget');
      if(budgetMax && params.get('maxBudget')) budgetMax.value = params.get('maxBudget');
      if(maxAltitude && params.get('maxAltitude')) maxAltitude.value = params.get('maxAltitude');
    }

    function buildQueryParams(){
      const params = new URLSearchParams();
      const groups = {};
      checkboxes.forEach(cb => {
        if(!cb.checked) return;
        (groups[cb.dataset.filter] ||= []).push(cb.value);
      });
      Object.entries(groups).forEach(([key, values]) => { if(values.length) params.set(key, values.join(',')); });
      if(budgetMin && budgetMin.value) params.set('minBudget', budgetMin.value);
      if(budgetMax && budgetMax.value) params.set('maxBudget', budgetMax.value);
      if(maxAltitude && maxAltitude.value) params.set('maxAltitude', maxAltitude.value);
      return params;
    }

    let requestSeq = 0;
    let loadedOnce = false;
    function refresh(){
      const params = buildQueryParams();
      const qs = params.toString();
      history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));

      const countEl = document.getElementById('tour-count');
      // The very first load keeps whatever static fallback markup is already
      // in the grid until we know the API answered — later refreshes (the
      // rider actively changing filters) show a real loading state.
      if(loadedOnce){
        grid.innerHTML = '<p class="tour-grid-status">Loading tours…</p>';
        if(countEl) countEl.textContent = 'Loading…';
      }

      const seq = ++requestSeq;
      apiGet('/api/tours' + (qs ? '?' + qs : '')).then(data => {
        if(seq !== requestSeq) return; // a newer filter change already superseded this request
        loadedOnce = true;
        renderGrid(data.tours);
      }).catch(err => {
        if(seq !== requestSeq) return;
        if(!loadedOnce){
          const note = document.createElement('p');
          note.className = 'tour-grid-status';
          note.textContent = 'Backend not reachable at ' + API_BASE + ' — showing offline preview cards. (' + err.message + ')';
          grid.parentElement.insertBefore(note, grid);
          return;
        }
        grid.innerHTML = `<p class="tour-grid-status tour-grid-error">Couldn't load tours (${escapeHtml(err.message)}).<button type="button" id="tour-retry">Retry</button></p>`;
        if(countEl) countEl.textContent = 'Error';
        const retry = document.getElementById('tour-retry');
        if(retry) retry.addEventListener('click', refresh);
      });
    }

    applyFromQuery();
    checkboxes.forEach(cb => cb.addEventListener('change', refresh));
    if(maxAltitude) maxAltitude.addEventListener('change', refresh);
    // Number inputs debounce so refresh doesn't fire on every keystroke.
    let debounceTimer;
    [budgetMin, budgetMax].forEach(input => {
      if(!input) return;
      input.addEventListener('input', () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(refresh, 450); });
    });
    const clearBtn = document.getElementById('filters-clear');
    if(clearBtn) clearBtn.addEventListener('click', () => {
      checkboxes.forEach(cb => cb.checked = false);
      if(budgetMin) budgetMin.value = '';
      if(budgetMax) budgetMax.value = '';
      if(maxAltitude) maxAltitude.value = '';
      refresh();
    });

    // Mobile-only collapse toggle for the whole filters panel.
    const toggleBtn = document.getElementById('filters-toggle');
    if(toggleBtn){
      toggleBtn.addEventListener('click', () => {
        const collapsed = panel.classList.toggle('filters-collapsed');
        toggleBtn.setAttribute('aria-expanded', String(!collapsed));
        toggleBtn.textContent = collapsed ? 'Show filters' : 'Hide filters';
      });
    }

    return refresh;
  }

  const runFilteredLoad = setupFilters();
  if(runFilteredLoad){
    runFilteredLoad();
  } else {
    // index.html's featured strip: no filters, just show whatever the API returns.
    apiGet('/api/tours').then(data => {
      renderGrid(data.tours);
    }).catch(err => {
      const note = document.createElement('p');
      note.style.cssText = 'color:var(--paper-dim); font-family:var(--f-mono); font-size:12px; padding:16px 0;';
      note.textContent = 'Backend not reachable at ' + API_BASE + ' — showing offline preview cards. (' + err.message + ')';
      grid.parentElement.insertBefore(note, grid);
    });
  }
})();

/* ============================================================
   HOMEPAGE "RIDER STORIES" — fills #home-review-strip from /api/reviews,
   the same reviews riders leave from their dashboard (see tour-detail.html's
   renderReviews for the per-tour equivalent) and admins moderate in the
   admin panel's Reviews tab. No fixed/sample testimonials.
   ============================================================ */
(function(){
  const strip = document.getElementById('home-review-strip');
  if(!strip) return;

  const SCORE_FIELDS = [
    ['riding_score','Riding'], ['guide_score','Guide'], ['scenery_score','Scenery'],
    ['organization_score','Organisation'], ['accommodation_score','Accommodation'],
  ];
  function reviewCardHtml(r){
    const bars = SCORE_FIELDS.filter(([f]) => r[f] != null)
      .map(([f, label]) => `<div class="review-bar">${label}<div class="track"><div class="fill" style="width:${r[f]*20}%"></div></div></div>`)
      .join('');
    const when = r.departure_start_date || r.created_at;
    const monthYear = when ? new Date(when).toLocaleDateString(undefined, { month:'long', year:'numeric' }) : '';
    return `<div class="review-card">
      <div class="review-bars">${bars}</div>
      <p class="review-quote">${escapeHtml(r.quote)}</p>
      <span class="review-who">${escapeHtml(r.rider_name)} — ${escapeHtml(r.tour_name)}${monthYear ? ', ' + monthYear : ''}</span>
    </div>`;
  }

  apiGet('/api/reviews?limit=6').then(data => {
    strip.innerHTML = data.reviews.length
      ? data.reviews.map(reviewCardHtml).join('')
      : `<p style="color:var(--paper-dim); padding:20px 0;">No rider stories yet — book a ride and be the first to leave one.</p>`;
  }).catch(err => {
    strip.innerHTML = `<p style="color:var(--paper-dim); padding:20px 0;">Couldn't load rider stories (${escapeHtml(err.message)}).</p>`;
  });
})();

/* ============================================================
   HOMEPAGE "UPCOMING DEPARTURES" TABLE — fills #dep-table-body from
   /api/departures?upcoming=1, the same live, admin-entered departures
   the calendar and tour-detail pages use. Only real, currently-bookable
   dates are ever shown here — nothing hardcoded, nothing stale.
   ============================================================ */
(function(){
  const tbody = document.getElementById('dep-table-body');
  if(!tbody) return;

  function depRowHtml(d){
    const left = Math.max(0, d.capacity - d.seats_booked);
    let pip, label, ctaText;
    if(d.status === 'full'){ pip = 'pip-red'; label = 'Full'; ctaText = 'Join waitlist'; }
    else if(d.status === 'request_only'){ pip = 'pip-amber'; label = 'Request-only'; ctaText = 'Request dates'; }
    else { pip = left <= 3 ? 'pip-amber' : 'pip-green'; label = left + (left === 1 ? ' spot' : ' spots'); ctaText = 'View · Book'; }
    const dateLabel = new Date(d.start_date).toLocaleDateString(undefined, { day:'numeric', month:'short', year:'numeric' });
    const href = 'tour-detail.html?slug=' + encodeURIComponent(d.tour_slug);
    return `<tr>
      <td><span class="dep-name">${escapeHtml(d.tour_name)}</span></td>
      <td class="mono">${dateLabel}</td>
      <td class="mono">${d.duration_days} days</td>
      <td><span class="status"><span class="pip ${pip}"></span>${escapeHtml(label)}</span></td>
      <td><a href="${href}" class="dep-cta">${ctaText}</a></td>
    </tr>`;
  }

  apiGet('/api/departures?upcoming=1&limit=6').then(data => {
    tbody.innerHTML = data.departures.length
      ? data.departures.map(depRowHtml).join('')
      : `<tr><td colspan="5" style="padding:20px; color:var(--paper-dim);">No upcoming departures scheduled right now — <a href="build-adventure.html">build a custom trip</a> instead.</td></tr>`;
  }).catch(err => {
    tbody.innerHTML = `<tr><td colspan="5" style="padding:20px; color:var(--paper-dim);">Couldn't load live departures (${escapeHtml(err.message)}) — try the <a href="calendar.html">full calendar</a> instead.</td></tr>`;
  });
})();

/* ---------- Newsletter signup ---------- */
(function(){
  const form = document.getElementById('news-form');
  if(!form) return;
  const note = document.getElementById('news-note');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const email = document.getElementById('news-email').value;
    const btn = form.querySelector('button');
    const original = btn.textContent;
    btn.disabled = true; btn.textContent = 'Subscribing...';
    try {
      await apiPost('/api/newsletter', { email });
      form.reset();
      note.textContent = 'You\'re on the list — we\'ll email you when new departures open.';
      note.style.color = '#7FBF6B';
      showToast('Subscribed! We\'ll email you when new departures open.', 'success');
    } catch(err) {
      note.textContent = 'Could not subscribe: ' + err.message;
      note.style.color = '#D9534F';
      showToast('Could not subscribe: ' + err.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = original;
    }
  });
})();

/* ============================================================
   HOMEPAGE "FIND YOUR RIDE" FINDER — redirects to tours.html with
   query params the filters-panel above reads back out (applyFromQuery).
   ============================================================ */
(function(){
  const form = document.querySelector('.finder');
  if(!form) return;
  const DIFF_TO_LEVELS = { Beginner:'1', Intermediate:'2,3', Advanced:'4', Expert:'5' };
  const DUR_TO_RANGE = { '1–3 days':'1-3', '4–7 days':'4-7', '8–14 days':'8-14', '15+ days':'15-999' };
  form.addEventListener('submit', e => {
    e.preventDefault();
    const duration = document.getElementById('f-duration').value;
    const difficulty = document.getElementById('f-diff').value;
    const style = document.getElementById('f-style').value;
    const params = new URLSearchParams();
    if(DUR_TO_RANGE[duration]) params.set('duration', DUR_TO_RANGE[duration]);
    if(DIFF_TO_LEVELS[difficulty]) params.set('difficulty', DIFF_TO_LEVELS[difficulty]);
    if(style && !style.startsWith('Any')) params.set('style', style);
    location.href = 'tours.html' + (params.toString() ? '?' + params.toString() : '');
  });
})();

/* ============================================================
   DYNAMIC GUIDES + GALLERY — same pattern as tour cards: fetch
   from the API, replace the container's innerHTML on success,
   leave the static fallback markup alone on failure.
   ============================================================ */
(function(){
  const grid = document.getElementById('guide-grid');
  if(!grid) return;
  apiGet('/api/guides').then(data => {
    grid.innerHTML = data.guides.map(g => `
      <div class="guide-card">
        <div class="guide-photo"><img src="${escapeHtml(g.photo_url || 'https://images.unsplash.com/photo-1628182602283-8219f0e78a10?auto=format&fit=crop&w=800&q=80')}" alt="Portrait of ${escapeHtml(g.name)}"></div>
        <div class="guide-info">
          <h3>${escapeHtml(g.name)}</h3>
          <span class="guide-role">${escapeHtml(g.role)}</span>
          <div class="guide-stats"><div><b>${g.years_experience}</b>years riding Nepal</div><div><b>${g.trips_led}+</b>trips led</div><div><b>${g.rating}</b>rider rating</div></div>
          <p>${escapeHtml(g.bio || '')}</p>
        </div>
      </div>`).join('') || '<p style="color:var(--paper-dim);">No guide profiles published yet.</p>';
  }).catch(() => { /* keep static fallback cards already in the HTML */ });
})();

(function(){
  const grid = document.getElementById('gallery-grid');
  if(!grid) return;
  apiGet('/api/gallery?category=gallery').then(data => {
    if(!data.images.length) return; // keep static fallback rather than show an empty grid
    grid.innerHTML = data.images.map((im, i) => {
      const shapeClass = i === 0 ? 'g-tall' : i === 2 ? 'g-wide' : i === 5 ? 'g-tall' : i === 6 ? 'g-wide' : '';
      return `<a href="#" class="${shapeClass}"><img src="${escapeHtml(im.image_url)}" alt="${escapeHtml(im.caption || '')}"></a>`;
    }).join('');
  }).catch(() => { /* keep static fallback images already in the HTML */ });
})();

/* ============================================================
   DYNAMIC MAP PINS — projects real lat/lng from /api/destinations
   onto the Nepal province map's SVG coordinate space. The projection
   constants below are the exact same fixed lng/lat bounding box used
   to build the province <path> outlines in index.html (source:
   amCharts' nepal2020Low geodata, which includes the Kalapani/
   Limpiyadhura frontier) — using the same fixed box, rather than
   re-fitting to whatever destinations happen to be loaded, is what
   keeps pins landing in the right place ON the country shape instead
   of drifting once live data replaces the static hand-placed pins.
   ============================================================ */
(function(){
  const pinGroup = document.getElementById('map-pins');
  if(!pinGroup) return;
  const LNG_MIN = 80.0517, LNG_MAX = 88.1931, LAT_MIN = 26.3487, LAT_MAX = 30.4852;
  const SCALE = 1000 / (LNG_MAX - LNG_MIN);

  const project = (lat, lng) => ({
    x: (lng - LNG_MIN) * SCALE,
    y: (LAT_MAX - lat) * SCALE, // north = up = smaller y
  });

  apiGet('/api/destinations').then(data => {
    const dests = data.destinations.filter(d => d.lat != null && d.lng != null);
    if(!dests.length) return; // keep static pins

    pinGroup.innerHTML = dests.map(d => {
      const p = project(d.lat, d.lng);
      const isFeatured = d.slug === 'mustang';
      const r = isFeatured ? 8 : 6;
      const variant = 'np-pin tour' + (isFeatured ? ' tour-flagship' : '');
      return `<a href="#tour-${escapeHtml(d.slug)}" class="${variant}">
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}"/>
        <text x="${p.x.toFixed(1)}" y="${(p.y-14).toFixed(1)}" text-anchor="middle">${escapeHtml(d.name)}</text>
      </a>`;
    }).join('');
  }).catch(() => { /* keep the static hand-placed pins already in the HTML */ });
})();

/* ---------- Sustainability "where your money goes" bar ---------- */
(function(){
  const bar = document.getElementById('money-bar');
  if(!bar) return;
  const segs = [
    { label:'Local guides & staff', pct:34, color:'#C1461E' },
    { label:'Accommodation & food', pct:24, color:'#2C6E74' },
    { label:'Community & trail fund', pct:12, color:'#5B7A45' },
    { label:'Logistics & permits', pct:18, color:'#9C8B63' },
    { label:'Operations', pct:12, color:'#4A4335' },
  ];
  segs.forEach(s => {
    const el = document.createElement('div');
    el.className = 'money-seg';
    el.style.width = s.pct + '%';
    el.style.background = s.color;
    el.textContent = s.pct + '%';
    bar.appendChild(el);
  });
  const legend = document.getElementById('money-legend');
  if(legend){
    legend.innerHTML = segs.map(s => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('');
  }
})();

/* ============================================================
   BUILD YOUR ADVENTURE — multi-step wizard
   ============================================================ */
(function(){
  const frame = document.querySelector('.wizard-frame');
  if(!frame) return;

  const steps = [...document.querySelectorAll('.wizard-step')];
  const pips = [...document.querySelectorAll('.step-pip')];
  let current = 0;
  const state = { destination:null, tourId:null, preferredDate:'', duration:null, style:null, experience:null, groupsize:'', budget:'', preferences:[], name:'', email:'' };

  /* ---------- Question 1: base tour (real catalogue only) + preferred date ----------
     The destination is always picked from GET /api/tours, never typed free
     text, so a proposal always starts from an itinerary that actually
     exists — see routes/customRequests.js's tourId validation. */
  const tourSelect = document.getElementById('w-tour');
  const tourPreview = document.getElementById('w-tour-preview');
  let toursForWizard = [];
  if(tourSelect){
    apiGet('/api/tours').then(data => {
      toursForWizard = data.tours;
      tourSelect.innerHTML = '<option value="">Not sure yet — recommend something</option>' +
        toursForWizard.map(t => `<option value="${t.id}">${escapeHtml(t.name)}${t.region ? ' — ' + escapeHtml(t.region) : ''}</option>`).join('');
    }).catch(() => {
      tourSelect.innerHTML = '<option value="">Not sure yet — recommend something</option>';
    });
    tourSelect.addEventListener('change', () => {
      const tour = toursForWizard.find(t => t.id === Number(tourSelect.value));
      state.tourId = tour ? tour.id : null;
      state.destination = tour ? tour.name : 'Not sure yet';
      if(tour){
        const money = c => '€' + (c/100).toLocaleString(undefined, { minimumFractionDigits:0 });
        tourPreview.innerHTML = `
          <div class="tour-preview-head">
            ${tour.image_url ? `<img src="${escapeHtml(tour.image_url)}" alt="">` : ''}
            <div>
              <h5>${escapeHtml(tour.name)}</h5>
              <div class="tour-preview-meta">
                <span>${tour.duration_days} days</span><span>Level ${tour.difficulty_level}/5</span>
                <span>${tour.distance_km} km</span><span>From ${money(tour.price_from_cents)}</span>
              </div>
            </div>
          </div>
          <p>${escapeHtml(tour.summary || '')}</p>
          <a href="tour-detail.html?slug=${encodeURIComponent(tour.slug)}" target="_blank" rel="noopener">View full tour details &rarr;</a>`;
        tourPreview.classList.remove('hidden');
      } else {
        tourPreview.classList.add('hidden');
        tourPreview.innerHTML = '';
      }
      updateSummary();
    });
  }

  function showStep(i){
    steps.forEach((s,si) => s.classList.toggle('active', si===i));
    pips.forEach((p,pi) => {
      p.classList.toggle('done', pi < i);
      p.classList.toggle('active', pi === i);
    });
    current = i;
    const top = frame.getBoundingClientRect().top + window.scrollY - 130;
    window.scrollTo({ top, behavior:'smooth' });
  }

  document.querySelectorAll('.opt-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      const field = btn.dataset.field;
      const value = btn.dataset.value;
      const multi = btn.dataset.multi === 'true';
      if(multi){
        btn.classList.toggle('selected');
        const idx = state.preferences.indexOf(value);
        if(btn.classList.contains('selected') && idx === -1) state.preferences.push(value);
        if(!btn.classList.contains('selected') && idx > -1) state.preferences.splice(idx,1);
      } else {
        document.querySelectorAll('.opt-pill[data-field="'+field+'"]').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        state[field] = value;
      }
      updateSummary();
    });
  });

  const bind = (name, key) => document.querySelectorAll('[name="'+name+'"]').forEach(el =>
    el.addEventListener('input', e => { state[key] = e.target.value; updateSummary(); }));
  bind('groupsize','groupsize'); bind('budget','budget'); bind('name','name'); bind('email','email'); bind('preferredDate','preferredDate');

  // Prefill (and lock) name/email from the signed-in account, if any — a
  // signed-in rider's request gets linked to their account automatically on
  // submit (see apiPost's Authorization header), so these should match.
  if(Auth.isSignedIn()){
    state.name = Auth.name(); state.email = Auth.email();
    document.querySelectorAll('[name="name"]').forEach(el => { el.value = Auth.name(); });
    document.querySelectorAll('[name="email"]').forEach(el => { el.value = Auth.email(); });
  }

  function updateSummary(){
    const map = {
      destination: 'ws-destination', preferredDate: 'ws-preferreddate', duration: 'ws-duration', style: 'ws-style',
      experience: 'ws-experience', groupsize: 'ws-groupsize', budget: 'ws-budget',
    };
    Object.keys(map).forEach(k => {
      const el = document.getElementById(map[k]);
      if(!el) return;
      const val = state[k];
      el.textContent = val ? val : 'Not set yet';
      el.closest('.ws-row').classList.toggle('empty', !val);
    });
    const prefEl = document.getElementById('ws-preferences');
    if(prefEl){
      prefEl.textContent = state.preferences.length ? state.preferences.join(', ') : 'Not set yet';
      prefEl.closest('.ws-row').classList.toggle('empty', !state.preferences.length);
    }
  }

  document.querySelectorAll('[data-next]').forEach(btn => btn.addEventListener('click', () => {
    if(current < steps.length - 1) showStep(current + 1);
  }));
  document.querySelectorAll('[data-back]').forEach(btn => btn.addEventListener('click', () => {
    if(current > 0) showStep(current - 1);
  }));

  const submitBtn = document.getElementById('wizard-submit');
  if(submitBtn){
    // Signing in is required to submit (an account is what ties this lead —
    // and any proposal a guide later builds on it — to a real rider). Gated
    // at click time rather than on page load so the wizard itself stays
    // freely browsable; Auth.requireSignIn pops the sign-in modal and resumes
    // this exact function, with the already-filled-out `state`, the instant
    // sign-in succeeds — nothing the visitor entered is lost.
    async function doSubmit(){
      const main = document.querySelector('.wizard-main');
      const originalLabel = submitBtn.textContent;
      submitBtn.textContent = 'Sending...';
      submitBtn.disabled = true;
      try {
        await apiPost('/api/custom-requests', {
          name: state.name, email: state.email, destination: state.destination, tourId: state.tourId,
          preferredDate: state.preferredDate || null, duration: state.duration,
          style: state.style, experience: state.experience, groupSize: state.groupsize, budget: state.budget,
          preferences: state.preferences,
        });
        main.innerHTML =
          '<div style="padding:40px 0;">' +
            '<span class="q-num">Request received</span>' +
            '<h2>We\'re on it' + (state.name ? ', ' + escapeHtml(state.name) : '') + '.</h2>' +
            '<p style="color:var(--paper-dim); font-size:15px; max-width:52ch; margin-bottom:28px; line-height:1.7;">' +
              'A guide will review your ' + escapeHtml(state.duration || 'trip') + ' ' + escapeHtml(state.style || '') + ' request for ' +
              escapeHtml(state.destination || 'Nepal') + ' and reply with a proposed itinerary within two working days' +
              (state.email ? ' at ' + escapeHtml(state.email) : '') + '. This has been saved to our team\u2019s request queue.' +
            '</p>' +
            '<a href="index.html" class="btn btn-solid">Back to the homepage</a>' +
          '</div>';
      } catch (err) {
        submitBtn.textContent = originalLabel;
        submitBtn.disabled = false;
        let note = document.getElementById('wizard-error');
        if(!note){
          note = document.createElement('p');
          note.id = 'wizard-error';
          note.style.cssText = 'color:#E39B95; font-size:13px; margin-top:14px;';
          submitBtn.closest('.wizard-nav').after(note);
        }
        note.textContent = 'Could not reach the booking system (' + err.message + '). Is the backend running at ' + API_BASE + '?';
      }
    }
    submitBtn.addEventListener('click', () => Auth.requireSignIn(doSubmit));
  }

  showStep(0);
  updateSummary();
})();

/* ============================================================
   RIDER DASHBOARD (dashboard.html) — profile editing, booking history
   with cancel, and custom-request history with cancel. Everything here
   requires a signed-in rider; #dash-gate is shown instead if not.
   ============================================================ */
(function(){
  const dashApp = document.getElementById('dash-app');
  if(!dashApp) return;
  const gate = document.getElementById('dash-gate');

  const money = c => '€' + (c/100).toLocaleString(undefined, { minimumFractionDigits:0 });
  const dateFmt = s => new Date(s).toLocaleDateString(undefined, { day:'numeric', month:'short', year:'numeric' });

  const BOOKING_STATUS = {
    pending:      { label:'Awaiting payment', color:'#E8B33D' },
    deposit_paid: { label:'Deposit paid',     color:'#6FA0B8' },
    paid:         { label:'Fully paid',       color:'#7FBF6B' },
    balance_due:  { label:'Balance due',      color:'#E8B33D' },
    completed:    { label:'Fully paid',       color:'#7FBF6B' },
    cancelled:    { label:'Cancelled',        color:'#D9534F' },
  };
  const REQUEST_STATUS = {
    new:            { label:'New',            color:'#E8B33D' },
    contacted:      { label:'Contacted',       color:'#6FA0B8' },
    proposal_sent:  { label:'Proposal sent',   color:'#6FA0B8' },
    approved:       { label:'Approved',        color:'#7FBF6B' },
    deposit:        { label:'Deposit paid',    color:'#6FA0B8' },
    confirmed:      { label:'Confirmed',       color:'#7FBF6B' },
    completed:      { label:'Completed',       color:'#7FBF6B' },
    declined:       { label:'Declined',        color:'#D9534F' },
    cancelled:      { label:'Cancelled',       color:'#D9534F' },
  };

  async function loadProfile(){
    const data = await apiGet('/api/riders/me');
    const r = data.rider;
    document.getElementById('p-name').value = r.name || '';
    document.getElementById('p-email').value = r.email || '';
    document.getElementById('p-phone').value = r.phone || '';
    document.getElementById('p-country').value = r.country || '';
    document.getElementById('p-experience').value = r.riding_experience || '';
    document.getElementById('p-style').value = r.preferred_style || '';
    document.getElementById('p-bike').value = r.bike_info || '';
    document.getElementById('p-ec-name').value = r.emergency_contact_name || '';
    document.getElementById('p-ec-phone').value = r.emergency_contact_phone || '';
    document.getElementById('dash-welcome').textContent =
      'Welcome back, ' + r.name + (data.upcoming_adventure ? ' — your next adventure is ' + data.upcoming_adventure.tour_name + ' on ' + dateFmt(data.upcoming_adventure.start_date) + '.' : '.');
  }

  let lastBookings = []; // cached so openReviewModal(id) can look a booking back up without another round trip
  async function loadBookings(){
    const list = document.getElementById('bookings-list');
    try {
      const data = await apiGet('/api/riders/me/bookings');
      lastBookings = data.bookings;
      if(!data.bookings.length){ list.innerHTML = '<p class="dash-empty">No bookings yet — <a href="tours.html">browse tours</a>.</p>'; return; }
      list.innerHTML = data.bookings.map(b => {
        const st = BOOKING_STATUS[b.status] || { label:b.status, color:'#C9C4B2' };
        const pct = b.total_cents ? Math.min(100, Math.round((b.amount_paid_cents / b.total_cents) * 100)) : 0;
        const refundNote = b.refund_status === 'pending'
          ? `<div class="dash-meta" style="margin-top:4px;"><span style="color:#E8B33D;">Refund pending admin confirmation</span></div>`
          : b.refund_status === 'processed'
          ? `<div class="dash-meta" style="margin-top:4px;"><span style="color:#7FBF6B;">Refunded</span></div>`
          : '';
        return `<div class="dash-item">
          <div class="dash-item-head">
            <div><h4>${escapeHtml(b.tour_name)}</h4>
              <div class="dash-meta"><span>${dateFmt(b.start_date)} &rarr; ${dateFmt(b.end_date)}</span><span>${b.riders.length} rider(s)</span><span>${escapeHtml(b.booking_reference)}</span></div>
              ${refundNote}
            </div>
            <span class="dash-status" style="color:${st.color};">${escapeHtml(st.label)}</span>
          </div>
          <div class="dash-progress"><div class="dash-progress-fill" style="width:${pct}%;"></div></div>
          <div class="dash-item-foot">
            <span style="font-size:12.5px; color:var(--paper-dim);">${money(b.amount_paid_cents)} of ${money(b.total_cents)} paid</span>
            <span>
              <a class="btn btn-ghost btn-small" href="trip.html?booking=${b.id}">View trip &amp; guide</a>
              <a class="btn btn-ghost btn-small" href="invoice.html?booking=${b.id}">Invoice</a>
              ${(b.status === 'pending' || b.status === 'deposit_paid') ? `<button class="btn btn-solid btn-small" onclick="openPayModal(${b.id})">Pay now</button>` : ''}
              ${b.can_cancel ? `<button class="btn btn-ghost btn-small" onclick="dashCancelBooking(${b.id})">Cancel booking</button>` : ''}
              ${b.can_review ? `<button class="btn btn-ghost btn-small" onclick="openReviewModal(${b.id})">Leave a review</button>` : ''}
              ${b.already_reviewed ? `<span style="font-size:12px; color:#7FBF6B;">&#10003; Reviewed</span>` : ''}
            </span>
          </div>
        </div>`;
      }).join('');
    } catch(err) { list.innerHTML = '<p class="dash-empty">Could not load bookings: ' + escapeHtml(err.message) + '</p>'; }
  }

  /* ---------- leave a review (only shown for a booking the backend has
     already confirmed is eligible — can_review on /api/riders/me/bookings) --------- */
  function ensureReviewModal(){
    if(document.getElementById('review-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'review-overlay';
    overlay.className = 'auth-overlay hidden';
    overlay.innerHTML = `
      <div class="auth-modal" style="max-width:440px;">
        <button class="auth-close" type="button" aria-label="Close">&times;</button>
        <h2 id="review-modal-title">Leave a review</h2>
        <p class="auth-sub">Rate the ride out of 5 on whatever mattered to you — leave any blank you'd rather skip.</p>
        <form id="review-form">
          <div class="dash-row">
            <div class="dash-field"><label>Riding</label><select id="rv-riding"><option value="">&mdash;</option>${[5,4,3,2,1].map(n=>`<option value="${n}">${n}</option>`).join('')}</select></div>
            <div class="dash-field"><label>Guide</label><select id="rv-guide"><option value="">&mdash;</option>${[5,4,3,2,1].map(n=>`<option value="${n}">${n}</option>`).join('')}</select></div>
          </div>
          <div class="dash-row">
            <div class="dash-field"><label>Scenery</label><select id="rv-scenery"><option value="">&mdash;</option>${[5,4,3,2,1].map(n=>`<option value="${n}">${n}</option>`).join('')}</select></div>
            <div class="dash-field"><label>Organisation</label><select id="rv-org"><option value="">&mdash;</option>${[5,4,3,2,1].map(n=>`<option value="${n}">${n}</option>`).join('')}</select></div>
          </div>
          <div class="dash-field"><label>Accommodation</label><select id="rv-accom"><option value="">&mdash;</option>${[5,4,3,2,1].map(n=>`<option value="${n}">${n}</option>`).join('')}</select></div>
          <div class="dash-field"><label>Your review</label><textarea id="rv-quote" rows="4" placeholder="What stood out about this ride?" style="resize:vertical;"></textarea></div>
          <div class="filter-opt" style="margin-bottom:14px;"><label style="display:flex; align-items:center; gap:8px; cursor:pointer; color:var(--paper-dim); font-size:13px;"><input type="checkbox" id="rv-recommend" checked style="width:auto;"> I'd recommend this ride to another rider</label></div>
          <div class="auth-error" id="review-error"></div>
          <button type="submit" class="btn btn-solid btn-block">Submit review</button>
        </form>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if(e.target === overlay) closeReviewModal(); });
    overlay.querySelector('.auth-close').addEventListener('click', closeReviewModal);
    overlay.querySelector('#review-form').addEventListener('submit', async e => {
      e.preventDefault();
      const errEl = document.getElementById('review-error');
      errEl.textContent = '';
      const booking = lastBookings.find(b => b.id === reviewingBookingId);
      if(!booking) { errEl.textContent = 'Could not find that booking — refresh and try again.'; return; }
      const scoreOf = id => { const v = document.getElementById(id).value; return v ? Number(v) : null; };
      try {
        await apiPost('/api/tours/' + encodeURIComponent(booking.tour_slug) + '/reviews', {
          departureId: booking.departure_id,
          ridingScore: scoreOf('rv-riding'), guideScore: scoreOf('rv-guide'), sceneryScore: scoreOf('rv-scenery'),
          organizationScore: scoreOf('rv-org'), accommodationScore: scoreOf('rv-accom'),
          wouldRecommend: document.getElementById('rv-recommend').checked,
          quote: document.getElementById('rv-quote').value.trim() || null,
        });
        closeReviewModal();
        showToast('Review submitted — thanks for the feedback!', 'success');
        loadBookings();
      } catch(err) { errEl.textContent = err.message; }
    });
  }
  let reviewingBookingId = null;
  window.openReviewModal = function(bookingId){
    ensureReviewModal();
    reviewingBookingId = bookingId;
    const booking = lastBookings.find(b => b.id === bookingId);
    document.getElementById('review-modal-title').textContent = booking ? 'Review: ' + booking.tour_name : 'Leave a review';
    document.getElementById('review-form').reset();
    document.getElementById('review-error').textContent = '';
    document.getElementById('review-overlay').classList.remove('hidden');
  };
  function closeReviewModal(){
    const overlay = document.getElementById('review-overlay');
    if(overlay) overlay.classList.add('hidden');
  }

  /* ---------- pay for a booking (deposit or remaining balance) from the
     dashboard — no real payment gateway is wired up in this demo, see the
     note in the booking-confirmation response; any well-formed card is
     accepted and the backend updates amount_paid_cents/status right away,
     no admin step needed. --------- */
  function ensurePayModal(){
    if(document.getElementById('pay-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'pay-overlay';
    overlay.className = 'auth-overlay hidden';
    overlay.innerHTML = `
      <div class="auth-modal" style="max-width:440px;">
        <button class="auth-close" type="button" aria-label="Close">&times;</button>
        <h2 id="pay-modal-title">Pay for your booking</h2>
        <p class="auth-sub" id="pay-modal-sub">Demo checkout — no real card is charged.</p>
        <form id="pay-form">
          <div class="dash-field"><label>Amount</label>
            <select id="pay-amount"></select>
          </div>
          <div class="dash-field"><label>Name on card</label><input id="pay-name" required autocomplete="cc-name"></div>
          <div class="dash-field"><label>Card number</label><input id="pay-number" required inputmode="numeric" autocomplete="cc-number" placeholder="4242 4242 4242 4242"></div>
          <div class="dash-row">
            <div class="dash-field"><label>Expiry (MM/YY)</label><input id="pay-expiry" required autocomplete="cc-exp" placeholder="12/28"></div>
            <div class="dash-field"><label>CVV</label><input id="pay-cvv" required inputmode="numeric" autocomplete="cc-csc" placeholder="123"></div>
          </div>
          <div class="auth-error" id="pay-error"></div>
          <button type="submit" class="btn btn-solid btn-block">Pay now</button>
        </form>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if(e.target === overlay) closePayModal(); });
    overlay.querySelector('.auth-close').addEventListener('click', closePayModal);
    overlay.querySelector('#pay-form').addEventListener('submit', async e => {
      e.preventDefault();
      const errEl = document.getElementById('pay-error');
      errEl.textContent = '';
      const booking = lastBookings.find(b => b.id === payingBookingId);
      if(!booking) { errEl.textContent = 'Could not find that booking — refresh and try again.'; return; }
      const amountCents = Number(document.getElementById('pay-amount').value);
      try {
        await apiPost('/api/bookings/' + booking.id + '/pay', {
          amountCents,
          card: {
            name: document.getElementById('pay-name').value.trim(),
            number: document.getElementById('pay-number').value.trim(),
            expiry: document.getElementById('pay-expiry').value.trim(),
            cvv: document.getElementById('pay-cvv').value.trim(),
          },
        });
        closePayModal();
        showToast('Payment recorded — thanks!', 'success');
        loadBookings();
      } catch(err) { errEl.textContent = err.message; }
    });
  }
  let payingBookingId = null;
  window.openPayModal = function(bookingId){
    ensurePayModal();
    payingBookingId = bookingId;
    const booking = lastBookings.find(b => b.id === bookingId);
    if(!booking) return;
    const balanceDue = booking.total_cents - booking.amount_paid_cents;
    const depositDue = Math.max(0, booking.deposit_cents - booking.amount_paid_cents);
    const amountSelect = document.getElementById('pay-amount');
    const options = [];
    if(depositDue > 0 && depositDue < balanceDue) options.push({ label: 'Deposit — ' + money(depositDue), value: depositDue });
    options.push({ label: (options.length ? 'Full balance — ' : 'Full amount due — ') + money(balanceDue), value: balanceDue });
    amountSelect.innerHTML = options.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
    document.getElementById('pay-modal-title').textContent = 'Pay for ' + booking.tour_name;
    document.getElementById('pay-modal-sub').textContent = 'Demo checkout — no real card is charged. ' + money(booking.amount_paid_cents) + ' of ' + money(booking.total_cents) + ' paid so far.';
    document.getElementById('pay-form').reset();
    document.getElementById('pay-error').textContent = '';
    document.getElementById('pay-overlay').classList.remove('hidden');
  };
  function closePayModal(){
    const overlay = document.getElementById('pay-overlay');
    if(overlay) overlay.classList.add('hidden');
  }

  const PROPOSAL_STATUS_LABEL = {
    sent: 'Awaiting your review', declined: 'You declined this',
    changes_requested: 'Changes requested', expired: 'Expired', withdrawn: 'Withdrawn by our team', superseded: 'Superseded',
  };
  let lastRequests = []; // cached so the pay modal can look a request/proposal back up without another round trip
  function renderProposalBox(r){
    // Once a real booking exists (created the moment the deposit was paid —
    // see routes/proposals.js), that booking is what owns the trip view and
    // any further payment — it already renders in full under "Your
    // bookings" above (guide, dates, Pay now, invoice, cancel). Showing the
    // old proposal payment box here too would just be a stale, confusing
    // duplicate of something the real booking card already does better.
    if(r.booking_id){
      return `<div class="proposal-box">
        <div class="proposal-box-head"><h5>Trip confirmed — ${escapeHtml(r.booking_reference || '')}</h5></div>
        <p style="font-size:13px; color:var(--paper-dim); line-height:1.6; margin:0 0 10px;">Your custom trip is booked. Find your dates, assigned guide, payment status and invoice under <b>Your bookings</b> above, or view the full trip details below.</p>
      </div>`;
    }
    const p = r.active_proposal;
    if(!p) return '';
    const amountPaid = r.amount_paid_cents || 0;
    const balanceDue = Math.max(0, p.price_cents - amountPaid);
    const incl = (p.inclusions || []).map(i => `<li>${escapeHtml(i)}</li>`).join('');
    const excl = (p.exclusions || []).map(i => `<li>${escapeHtml(i)}</li>`).join('');
    let actions = '';
    if(p.status === 'sent'){
      actions = `<div class="proposal-actions">
        <button class="btn btn-solid btn-small" onclick="approveProposal(${p.id})">Approve proposal</button>
        <button class="btn btn-ghost btn-small" onclick="requestProposalChanges(${p.id})">Request changes</button>
        <button class="btn btn-ghost btn-small" onclick="declineProposal(${p.id})">Decline</button>
      </div>`;
    } else if(p.status === 'approved' && balanceDue > 0){
      const label = amountPaid >= p.deposit_cents ? 'Pay remaining balance (' + money(balanceDue) + ')' : 'Make a payment (' + money(balanceDue) + ' due)';
      actions = `<div class="proposal-actions"><button class="btn btn-solid btn-small" onclick="openProposalPayModal(${r.id})">${label}</button></div>`;
    }
    const responseNote = (p.status === 'declined' || p.status === 'changes_requested') && p.customer_response_message
      ? `<div class="proposal-note">Your message: &ldquo;${escapeHtml(p.customer_response_message)}&rdquo;</div>` : '';
    let statusLabel;
    if(p.status === 'approved'){
      statusLabel = balanceDue <= 0 ? 'Paid in full' : amountPaid >= p.deposit_cents ? 'Deposit paid — balance due' : 'Approved — deposit due';
    } else statusLabel = PROPOSAL_STATUS_LABEL[p.status];
    return `<div class="proposal-box">
      <div class="proposal-box-head">
        <h5>Proposal v${p.version}${statusLabel ? ' — ' + escapeHtml(statusLabel) : ''}</h5>
        <span class="proposal-price">${money(p.price_cents)}</span>
      </div>
      <div class="proposal-grid">
        <div>Destination: <b>${p.tour ? `<a href="tour-detail.html?slug=${encodeURIComponent(p.tour.slug)}" target="_blank" rel="noopener">${escapeHtml(p.destination)}</a>` : escapeHtml(p.destination)}</b></div>
        <div>Duration: <b>${p.duration_days ? p.duration_days + ' days' : 'To be confirmed'}</b></div>
        <div>Proposed dates: <b>${p.start_date ? dateFmt(p.start_date) : 'To be confirmed'}</b></div>
        <div>Deposit required: <b>${money(p.deposit_cents)} (${p.deposit_percent}%)</b></div>
        ${p.accommodation ? `<div>Accommodation: <b>${escapeHtml(p.accommodation)}</b></div>` : ''}
        ${p.transport ? `<div>Transport: <b>${escapeHtml(p.transport)}</b></div>` : ''}
        ${p.expires_at && p.status === 'sent' ? `<div>Offer expires: <b>${dateFmt(p.expires_at)}</b></div>` : ''}
        ${amountPaid > 0 ? `<div>Paid so far: <b>${money(amountPaid)} of ${money(p.price_cents)}</b></div>` : ''}
        ${p.status === 'approved' && balanceDue > 0 && amountPaid > 0 ? `<div>Balance due: <b>${money(balanceDue)}</b></div>` : ''}
      </div>
      ${p.riding_details ? `<div class="proposal-note" style="border-left-color:var(--glacier);">${escapeHtml(p.riding_details)}</div>` : ''}
      ${(incl || excl) ? `<div class="proposal-cols">
        <div><h6>Included</h6><ul>${incl || '<li>Not yet specified</li>'}</ul></div>
        <div><h6>Not included</h6><ul>${excl || '<li>Not yet specified</li>'}</ul></div>
      </div>` : ''}
      ${p.notes ? `<div class="proposal-note">${escapeHtml(p.notes)}</div>` : ''}
      ${responseNote}
      ${actions}
    </div>`;
  }
  function renderBasedOnTour(r){
    const t = r.based_on_tour;
    if(!t) return '';
    return `<div class="dash-meta" style="margin-top:2px;">Based on: <a href="tour-detail.html?slug=${encodeURIComponent(t.slug)}" target="_blank" rel="noopener">${escapeHtml(t.name)}</a></div>`;
  }
  /** Everything the card header shows — destination, duration, date — has
   *  two possible sources: what the customer originally typed into the
   *  Build Your Adventure wizard (r.destination / r.duration_bucket /
   *  r.preferred_date, all rough and possibly "Not sure yet"), and what the
   *  admin's proposal actually specifies once one exists (p.destination /
   *  p.duration_days / p.start_date, concrete and tour-linked). The moment a
   *  proposal exists the card must show the proposal's numbers, not the
   *  stale original ask — otherwise a customer who accepted a 12-day Upper
   *  Mustang trip keeps seeing their original "15+ days / Not sure yet"
   *  answers forever, which reads as if nothing they agreed to took effect. */
  function requestCardHeader(r){
    const p = r.active_proposal;
    const tour = (p && p.tour) || r.based_on_tour || null;
    const title = p ? p.destination : (r.destination || 'Custom trip');
    // Once a proposal exists, the title links to the dedicated custom-trip
    // page (real tour content overlaid with this request's actual proposed
    // terms) rather than the plain public tour-detail.html, which would show
    // that tour's default listed price/duration/dates — not what was agreed.
    const titleHtml = p && tour
      ? `<a href="tour-detail.html?request=${r.id}" target="_blank" rel="noopener">${escapeHtml(title)}</a>`
      : tour
      ? `<a href="tour-detail.html?slug=${encodeURIComponent(tour.slug)}" target="_blank" rel="noopener">${escapeHtml(title)}</a>`
      : escapeHtml(title);
    const duration = p && p.duration_days ? p.duration_days + ' days' : (r.duration_bucket || '');
    let dateSpan = '';
    if(p && p.start_date){
      const label = p.status === 'approved' || r.booking_id ? 'Confirmed date' : 'Proposed date';
      dateSpan = `<span>${label}: ${escapeHtml(dateFmt(p.start_date))}</span>`;
    } else if(r.preferred_date){
      dateSpan = `<span>Preferred date: ${escapeHtml(dateFmt(r.preferred_date))}</span>`;
    }
    return `<h4>${titleHtml}</h4>
      <div class="dash-meta"><span>${escapeHtml(duration)}</span><span>${escapeHtml(r.riding_style || '')}</span><span>Submitted ${escapeHtml((r.created_at || '').slice(0, 10))}</span>${dateSpan}</div>
      ${!p ? renderBasedOnTour(r) : ''}`;
  }
  async function loadRequests(){
    const list = document.getElementById('requests-list');
    try {
      const data = await apiGet('/api/riders/me/requests');
      lastRequests = data.requests;
      if(!data.requests.length){ list.innerHTML = '<p class="dash-empty">No custom requests yet — <a href="build-adventure.html">build one</a>.</p>'; return; }
      list.innerHTML = data.requests.map(r => {
        const st = REQUEST_STATUS[r.status] || { label:r.status, color:'#C9C4B2' };
        return `<div class="dash-item">
          <div class="dash-item-head">
            <div>${requestCardHeader(r)}</div>
            <span class="dash-status" style="color:${st.color};">${escapeHtml(st.label)}</span>
          </div>
          ${renderProposalBox(r)}
          <div class="dash-item-foot">
            <span style="font-size:12.5px; color:var(--paper-dim);">${r.budget ? 'Budget: ' + escapeHtml(r.budget) : ''}</span>
            <span>
              ${r.active_proposal ? `<a class="btn btn-ghost btn-small" href="tour-detail.html?request=${r.id}" target="_blank" rel="noopener">View trip &amp; guide</a>` : ''}
              ${r.booking_id ? `<a class="btn btn-ghost btn-small" href="invoice.html?booking=${r.booking_id}">Invoice</a>` : ''}
              ${r.can_cancel ? `<button class="btn btn-ghost btn-small" onclick="dashCancelRequest(${r.id})">Cancel request</button>` : ''}
            </span>
          </div>
        </div>`;
      }).join('');
    } catch(err) { list.innerHTML = '<p class="dash-empty">Could not load requests: ' + escapeHtml(err.message) + '</p>'; }
  }

  window.approveProposal = async function(proposalId){
    if(!confirm('Approve this proposal? You\'ll be asked to pay the deposit next.')) return;
    try { await apiPost('/api/proposals/' + proposalId + '/approve', {}); showToast('Proposal approved — pay the deposit to confirm your spot.', 'success'); loadRequests(); }
    catch(err){ showToast('Could not approve: ' + err.message, 'error'); }
  };
  window.declineProposal = async function(proposalId){
    const reason = prompt('Let us know why you\'re declining (optional):');
    if(reason === null) return; // cancelled the prompt
    try { await apiPost('/api/proposals/' + proposalId + '/decline', { reason }); showToast('Proposal declined.', 'success'); loadRequests(); }
    catch(err){ showToast('Could not decline: ' + err.message, 'error'); }
  };
  window.requestProposalChanges = async function(proposalId){
    const message = prompt('What would you like changed about this proposal?');
    if(!message) return;
    try { await apiPost('/api/proposals/' + proposalId + '/request-changes', { message }); showToast('Change request sent — we\'ll follow up with a revised proposal.', 'success'); loadRequests(); }
    catch(err){ showToast('Could not send: ' + err.message, 'error'); }
  };

  /* ---------- pay a proposal's deposit — hands off to custom-checkout.html
     instead of a bare card-entry modal, since paying the deposit is also
     the one moment a custom trip's real rider count/details/add-ons get
     collected (see that page). This is only ever reached pre-booking —
     renderProposalBox above shows the "Trip confirmed" box, not this button,
     the moment booking_id exists. --------- */
  window.openProposalPayModal = function(requestId){
    location.href = 'custom-checkout.html?request=' + requestId;
  };

  window.dashCancelBooking = async function(id){
    if(!confirm('Cancel this booking? This can\'t be undone.')) return;
    try {
      const result = await apiPost('/api/bookings/' + id + '/cancel', {});
      showToast(
        result.refund_eligible_cents > 0
          ? `Booking cancelled. You're entitled to a ${result.refund_percent}% refund (${money(result.refund_eligible_cents)}) — an admin will confirm it once processed.`
          : 'Booking cancelled.',
        'success'
      );
      loadBookings();
    } catch(err){ showToast('Could not cancel: ' + err.message, 'error'); }
  };
  window.dashCancelRequest = async function(id){
    if(!confirm('Cancel this request?')) return;
    try { await apiPost('/api/custom-requests/' + id + '/cancel', {}); showToast('Request cancelled.', 'success'); loadRequests(); }
    catch(err){ showToast('Could not cancel: ' + err.message, 'error'); }
  };

  document.getElementById('profile-form').addEventListener('submit', async e => {
    e.preventDefault();
    const note = document.getElementById('profile-note');
    note.textContent = ''; note.style.color = 'var(--paper-dim)';
    try {
      const updated = await apiPatch('/api/riders/me', {
        name: document.getElementById('p-name').value.trim(),
        phone: document.getElementById('p-phone').value.trim(),
        country: document.getElementById('p-country').value.trim(),
        ridingExperience: document.getElementById('p-experience').value,
        preferredStyle: document.getElementById('p-style').value.trim(),
        bikeInfo: document.getElementById('p-bike').value.trim(),
        emergencyContactName: document.getElementById('p-ec-name').value.trim(),
        emergencyContactPhone: document.getElementById('p-ec-phone').value.trim(),
      });
      note.textContent = 'Saved.'; note.style.color = '#7FBF6B';
      showToast('Profile updated.', 'success');
      localStorage.setItem('hr_rider_name', updated.name); // keep the header control in sync
      mountAccountControl();
    } catch(err) { note.textContent = err.message; note.style.color = '#D9534F'; showToast(err.message, 'error'); }
  });

  document.getElementById('password-form').addEventListener('submit', async e => {
    e.preventDefault();
    const note = document.getElementById('password-note');
    note.textContent = ''; note.style.color = 'var(--paper-dim)';
    try {
      await apiPatch('/api/riders/me/password', {
        currentPassword: document.getElementById('p-current-pw').value,
        newPassword: document.getElementById('p-new-pw').value,
      });
      note.textContent = 'Password updated.'; note.style.color = '#7FBF6B';
      showToast('Password updated.', 'success');
      document.getElementById('password-form').reset();
    } catch(err) { note.textContent = err.message; note.style.color = '#D9534F'; showToast(err.message, 'error'); }
  });

  function boot(){
    if(!Auth.isSignedIn()){
      gate.classList.remove('hidden');
      dashApp.classList.add('hidden');
      document.getElementById('dash-signin-btn').addEventListener('click', () => Auth.requireSignIn(() => location.reload()));
      return;
    }
    gate.classList.add('hidden');
    dashApp.classList.remove('hidden');
    loadProfile();
    loadBookings();
    loadRequests();
  }
  boot();
})();

/* ============================================================
   CHECKOUT (checkout.html) — the real multi-step booking flow that
   replaces the old one-click "book with a hardcoded single rider" stub.
   Steps: departure summary -> rider count -> rider details -> add-ons
   (+ promo code) -> review -> confirm. Payment itself is out of scope for
   now (see routes/bookings.js) — confirming here creates the same
   'pending' + 72h-deposit-hold booking the backend has always made; no
   money moves in this step.
   ============================================================ */
(function(){
  const app = document.getElementById('checkout-app');
  if(!app) return;

  const params = new URLSearchParams(location.search);
  const departureId = Number(params.get('departureId'));
  const money = c => '€' + (c/100).toLocaleString(undefined, { minimumFractionDigits:0 });
  const dateFmt = s => new Date(s).toLocaleDateString(undefined, { day:'numeric', month:'long', year:'numeric' });
  const RIDING_EXPERIENCE_OPTIONS = ['Beginner', 'Intermediate', 'Advanced', 'Expert'];

  function showGate(){
    document.querySelector('.page-hero').classList.add('hidden');
    app.classList.add('hidden');
    document.getElementById('checkout-gate').classList.remove('hidden');
  }
  function showError(msg){
    document.querySelector('.page-hero').classList.add('hidden');
    app.classList.add('hidden');
    document.getElementById('checkout-gate').classList.add('hidden');
    document.getElementById('checkout-error-msg').textContent = msg;
    document.getElementById('checkout-error-view').classList.remove('hidden');
  }

  if(!departureId){ showError('No departure was specified.'); return; }
  showGate(); // shown until Auth.requireSignIn resolves (instantly if already signed in)

  let dep = null, tour = null, addonCatalog = [], profile = null;
  let riderCount = 1;
  let riderData = [];
  const selectedAddons = new Set();
  let appliedPromo = null; // { code, discount_cents, description } | null

  function computePricing(){
    const baseCents = tour ? tour.price_from_cents * riderCount : 0;
    const addonItems = [...selectedAddons].map(key => {
      const a = addonCatalog.find(x => x.key === key);
      if(!a) return null;
      const quantity = a.unit === 'per_booking' ? 1 : riderCount;
      return { ...a, quantity, line_total_cents: a.price_cents * quantity };
    }).filter(Boolean);
    const addonsCents = addonItems.reduce((s, i) => s + i.line_total_cents, 0);
    const subtotalCents = baseCents + addonsCents;
    const discountCents = appliedPromo ? Math.min(appliedPromo.discount_cents, subtotalCents) : 0;
    const taxCents = 0; // no tax rule configured for this business — never fabricated, see routes/bookings.js
    const totalCents = Math.max(0, subtotalCents - discountCents) + taxCents;
    const depositCents = Math.round(totalCents * 0.2);
    return { baseCents, addonItems, addonsCents, subtotalCents, discountCents, taxCents, totalCents, depositCents, balanceCents: totalCents - depositCents };
  }

  function updatePricingSidebar(){
    const p = computePricing();
    const setRow = (id, text, empty) => {
      const el = document.getElementById(id);
      el.textContent = text;
      el.closest('.ws-row').classList.toggle('empty', !!empty);
    };
    setRow('cs-base', money(p.baseCents), false);
    setRow('cs-addons', p.addonItems.length ? money(p.addonsCents) : 'None selected', !p.addonItems.length);
    document.getElementById('cs-discount-row').classList.toggle('hidden', p.discountCents <= 0);
    if(p.discountCents > 0) setRow('cs-discount', '−' + money(p.discountCents), false);
    setRow('cs-tax', p.taxCents > 0 ? money(p.taxCents) : 'None applicable', p.taxCents <= 0);
    document.getElementById('cs-total').textContent = money(p.totalCents);
    document.getElementById('cs-deposit').textContent = money(p.depositCents);
    document.getElementById('cs-balance').textContent = money(p.balanceCents);
    return p;
  }

  function renderDepartureSummary(spacesLeft){
    const availLabel = dep.status === 'request_only' ? 'Request-only' : spacesLeft + (spacesLeft === 1 ? ' space left' : ' spaces left');
    document.getElementById('co-departure-summary').innerHTML = `
      <div class="ride-grid ride-grid-2col" style="margin-top:0;">
        <div class="ride-cell"><h5>Tour</h5><ul><li>${escapeHtml(dep.tour_name)}</li></ul></div>
        <div class="ride-cell"><h5>Dates</h5><ul><li>${dateFmt(dep.start_date)} &rarr; ${dateFmt(dep.end_date)}</li></ul></div>
        <div class="ride-cell"><h5>Price per person</h5><ul><li>${tour ? money(tour.price_from_cents) : 'Loading…'}</li></ul></div>
        <div class="ride-cell"><h5>Availability</h5><ul><li>${escapeHtml(availLabel)}</li></ul></div>
      </div>`;
  }

  function setupRiderStepper(spacesLeft){
    const maxRiders = Math.max(1, Math.min(spacesLeft, 10));
    const countEl = document.getElementById('co-riders-count');
    const minusBtn = document.getElementById('co-riders-minus');
    const plusBtn = document.getElementById('co-riders-plus');
    const note = document.getElementById('co-spaces-note');
    function refresh(){
      countEl.textContent = riderCount;
      minusBtn.disabled = riderCount <= 1;
      plusBtn.disabled = riderCount >= maxRiders;
      note.textContent = spacesLeft + (spacesLeft === 1 ? ' space' : ' spaces') + ' available on this departure' +
        (maxRiders < spacesLeft ? ' — checkout supports up to 10 riders per booking; contact us directly for a larger group' : '') + '.';
      updatePricingSidebar();
    }
    minusBtn.addEventListener('click', () => { if(riderCount > 1){ riderCount--; refresh(); } });
    plusBtn.addEventListener('click', () => { if(riderCount < maxRiders){ riderCount++; refresh(); } });
    refresh();
  }

  function riderCardHtml(i){
    const d = riderData[i] || {};
    return `<div class="rider-card" data-rider-index="${i}">
      <h3>${i === 0 ? 'Rider 1 (you)' : 'Rider ' + (i + 1)}</h3>
      <div class="rider-grid">
        <div class="checkout-field"><label>Full name</label><input class="checkout-input" data-field="name" value="${escapeHtml(d.name || '')}"></div>
        <div class="checkout-field"><label>Age</label><input class="checkout-input" type="number" min="1" max="120" data-field="age" value="${escapeHtml(d.age || '')}"></div>
        <div class="checkout-field"><label>Country</label><input class="checkout-input" data-field="country" value="${escapeHtml(d.country || '')}"></div>
        <div class="checkout-field"><label>Riding experience</label>
          <select class="checkout-input" data-field="ridingExperience">
            <option value="">Select…</option>
            ${RIDING_EXPERIENCE_OPTIONS.map(o => `<option ${d.ridingExperience === o ? 'selected' : ''}>${o}</option>`).join('')}
          </select>
        </div>
        <div class="checkout-field" style="grid-column:1/-1;"><label>Bike information</label>
          <input class="checkout-input" placeholder="Own bike make/model/size, or &quot;Renting&quot;" data-field="bikeInfo" value="${escapeHtml(d.bikeInfo || '')}"></div>
        <div class="checkout-field"><label>Emergency contact name</label><input class="checkout-input" data-field="emergencyContactName" value="${escapeHtml(d.emergencyContactName || '')}"></div>
        <div class="checkout-field"><label>Emergency contact phone</label><input class="checkout-input" data-field="emergencyContactPhone" value="${escapeHtml(d.emergencyContactPhone || '')}"></div>
        <div class="checkout-field" style="grid-column:1/-1;"><label>Special requirements (optional)</label>
          <textarea class="checkout-input" rows="2" data-field="specialRequirements">${escapeHtml(d.specialRequirements || '')}</textarea></div>
      </div>
    </div>`;
  }

  /** Rebuilds the rider-details forms for the current riderCount, preserving
   *  already-typed values (riderData) if the rider stepped back and forth,
   *  and prefilling rider 1 (only once) from the signed-in account's own
   *  profile — still fully editable, never trusted as-is for the booking. */
  function renderRiderForms(){
    if(!riderData[0] && profile){
      riderData[0] = {
        name: profile.name || '', country: profile.country || '', ridingExperience: profile.riding_experience || '',
        bikeInfo: profile.bike_info || '', emergencyContactName: profile.emergency_contact_name || '',
        emergencyContactPhone: profile.emergency_contact_phone || '',
      };
    }
    const container = document.getElementById('co-rider-forms');
    let html = '';
    for(let i = 0; i < riderCount; i++) html += riderCardHtml(i);
    container.innerHTML = html;
    container.querySelectorAll('[data-field]').forEach(el => {
      el.addEventListener('input', () => {
        const idx = Number(el.closest('.rider-card').dataset.riderIndex);
        if(!riderData[idx]) riderData[idx] = {};
        riderData[idx][el.dataset.field] = el.value;
      });
    });
  }

  function validateRiders(){
    const errors = [];
    for(let i = 0; i < riderCount; i++){
      const d = riderData[i] || {};
      const label = 'Rider ' + (i + 1);
      const age = Number(d.age);
      if(!String(d.name || '').trim()) errors.push(`${label}: full name is required`);
      if(!Number.isInteger(age) || age < 1 || age > 120) errors.push(`${label}: a valid age is required`);
      if(!String(d.country || '').trim()) errors.push(`${label}: country is required`);
      if(!String(d.ridingExperience || '').trim()) errors.push(`${label}: riding experience is required`);
      if(!String(d.bikeInfo || '').trim()) errors.push(`${label}: bike information is required`);
      if(!String(d.emergencyContactName || '').trim() || !String(d.emergencyContactPhone || '').trim()) {
        errors.push(`${label}: emergency contact name and phone are required`);
      }
    }
    return errors;
  }

  function renderAddons(){
    const el = document.getElementById('co-addons-list');
    if(!addonCatalog.length){ el.innerHTML = '<p style="color:var(--paper-dim);">No add-ons are available right now.</p>'; return; }
    el.innerHTML = addonCatalog.map(a => {
      const qtyNote = a.unit === 'per_booking' ? 'once per booking' : `× ${riderCount} rider(s)`;
      const lineTotal = a.price_cents * (a.unit === 'per_booking' ? 1 : riderCount);
      return `<label class="addon-row">
        <input type="checkbox" data-addon="${escapeHtml(a.key)}" ${selectedAddons.has(a.key) ? 'checked' : ''}>
        <span class="addon-info"><b>${escapeHtml(a.label)}</b><span>${escapeHtml(a.description || '')} — ${money(a.price_cents)} ${qtyNote}</span></span>
        <span class="addon-price">${money(lineTotal)}</span>
      </label>`;
    }).join('');
    el.querySelectorAll('input[data-addon]').forEach(cb => {
      cb.addEventListener('change', () => {
        if(cb.checked) selectedAddons.add(cb.dataset.addon); else selectedAddons.delete(cb.dataset.addon);
        renderAddons();
        refreshPromoIfApplied();
      });
    });
  }

  async function applyPromo(silent){
    const input = document.getElementById('co-promo-input');
    const note = document.getElementById('co-promo-note');
    const code = (silent && appliedPromo ? appliedPromo.code : input.value).trim();
    if(!code){ appliedPromo = null; note.textContent = ''; note.className = 'promo-note'; updatePricingSidebar(); return; }
    const subtotalCents = computePricing().subtotalCents;
    try {
      const result = await apiPost('/api/promo/validate', { code, tourId: tour ? tour.id : null, riderCount, subtotalCents });
      appliedPromo = { code: result.code, discount_cents: result.discount_cents, description: result.description };
      note.textContent = `Applied ${result.code} — you save ${money(result.discount_cents)}.`;
      note.className = 'promo-note ok';
    } catch(err) {
      appliedPromo = null;
      note.textContent = err.message;
      note.className = 'promo-note err';
    }
    updatePricingSidebar();
  }
  function refreshPromoIfApplied(){
    if(appliedPromo) applyPromo(true); else updatePricingSidebar();
  }

  function renderReview(){
    const p = updatePricingSidebar();
    const riderRows = riderData.slice(0, riderCount).map((d, i) =>
      `<div class="review-rider"><b>${escapeHtml(d.name || ('Rider ' + (i + 1)))}</b> — ${escapeHtml(String(d.age || ''))} yrs, ${escapeHtml(d.country || '')}, ${escapeHtml(d.ridingExperience || '')}${d.specialRequirements ? ' · ' + escapeHtml(d.specialRequirements) : ''}</div>`
    ).join('');
    const addonRows = p.addonItems.length
      ? p.addonItems.map(a => `<div class="review-rider">${escapeHtml(a.label)}${a.unit === 'per_rider' ? ' × ' + a.quantity : ''} — ${money(a.line_total_cents)}</div>`).join('')
      : '<div class="review-rider" style="color:var(--paper-dim);">None selected</div>';
    document.getElementById('co-review').innerHTML = `
      <div class="review-block"><h4>Tour &amp; date</h4><p style="margin:0;">${escapeHtml(dep.tour_name)} — ${dateFmt(dep.start_date)} &rarr; ${dateFmt(dep.end_date)}</p></div>
      <div class="review-block"><h4>Riders (${riderCount})</h4>${riderRows}</div>
      <div class="review-block"><h4>Add-ons</h4>${addonRows}</div>
      ${appliedPromo ? `<div class="review-block"><h4>Promo code</h4><p style="margin:0; color:#7FBF6B;">${escapeHtml(appliedPromo.code)} — −${money(p.discountCents)}</p></div>` : ''}
      <div class="review-block"><h4>Cancellation terms</h4><p style="font-size:14px; color:var(--paper-dim); margin:0;">
        If you cancel later, any refund on what you've already paid is calculated automatically from how far in advance you cancel.
        <a href="cancellation-policy.html">Read the full policy</a>.</p></div>`;
  }

  function showConfirmation(result){
    const b = result.booking;
    document.querySelector('.checkout-main').innerHTML = `
      <div class="checkout-confirm">
        <span class="q-num">Booking confirmed</span>
        <h2>You're booked!</h2>
        <div class="ref">${escapeHtml(b.booking_reference)}</div>
        <p style="color:var(--paper-dim); max-width:52ch; margin:0 auto 24px;">
          A deposit of ${money(result.payment.deposit_due_cents)} is due within 72 hours to hold your place — no payment has been taken yet.
          Balance due after the deposit: ${money(result.payment.balance_due_cents)}.
        </p>
        <div style="display:flex; gap:12px; justify-content:center; flex-wrap:wrap;">
          <a href="dashboard.html" class="btn btn-solid">Go to my dashboard</a>
          <a href="invoice.html?booking=${b.id}&token=${encodeURIComponent(b.access_token)}" class="btn btn-ghost">View invoice</a>
        </div>
      </div>`;
    const summary = document.querySelector('.checkout-summary');
    if(summary) summary.classList.add('hidden');
    document.getElementById('checkout-subtitle').textContent = 'Booking reference ' + b.booking_reference;
    showToast('Booked! ' + b.booking_reference, 'success');
  }

  function wireNav(){
    const steps = [...document.querySelectorAll('.checkout-step')];
    const pips = [...document.querySelectorAll('.checkout-pip')];
    let current = 0;
    function showStep(i){
      steps.forEach((s, si) => s.classList.toggle('active', si === i));
      pips.forEach((p, pi) => { p.classList.toggle('done', pi < i); p.classList.toggle('active', pi === i); });
      current = i;
      const frame = document.querySelector('.checkout-frame');
      window.scrollTo({ top: frame.getBoundingClientRect().top + window.scrollY - 130, behavior: 'smooth' });
    }

    document.querySelectorAll('[data-co-next]').forEach(btn => btn.addEventListener('click', () => {
      if(current === 1){ renderRiderForms(); }
      if(current === 2){
        const errors = validateRiders();
        const errEl = document.getElementById('co-riders-error');
        if(errors.length){ errEl.textContent = errors.join('; '); errEl.classList.remove('hidden'); return; }
        errEl.classList.add('hidden');
        renderAddons();
      }
      if(current === 3){ renderReview(); }
      if(current < steps.length - 1) showStep(current + 1);
    }));
    document.querySelectorAll('[data-co-back]').forEach(btn => btn.addEventListener('click', () => {
      if(current > 0) showStep(current - 1);
    }));

    document.getElementById('co-promo-apply').addEventListener('click', () => applyPromo(false));

    document.getElementById('co-confirm-btn').addEventListener('click', async () => {
      const btn = document.getElementById('co-confirm-btn');
      const errEl = document.getElementById('co-confirm-error');
      errEl.classList.add('hidden');
      btn.disabled = true; // guards against a double-click firing two booking requests
      btn.textContent = 'Booking…';
      try {
        const payload = {
          departureId,
          riders: riderData.slice(0, riderCount).map(d => ({
            name: d.name, age: Number(d.age), country: d.country, ridingExperience: d.ridingExperience,
            bikeInfo: d.bikeInfo, emergencyContactName: d.emergencyContactName, emergencyContactPhone: d.emergencyContactPhone,
            specialRequirements: d.specialRequirements || undefined,
          })),
          addons: [...selectedAddons],
        };
        if(appliedPromo) payload.promoCode = appliedPromo.code;
        const result = await apiPost('/api/bookings', payload);
        showConfirmation(result);
      } catch(err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = 'Confirm booking';
      }
    });

    showStep(0);
  }

  async function init(){
    document.getElementById('checkout-gate').classList.add('hidden');
    document.querySelector('.page-hero').classList.remove('hidden');
    app.classList.remove('hidden');
    try {
      dep = await apiGet('/api/departures/' + departureId);
    } catch(err) { showError('Could not load this departure (' + err.message + ').'); return; }
    if(dep.status === 'cancelled'){ showError('This departure has been cancelled.'); return; }
    const spacesLeft = dep.capacity - dep.seats_booked;
    if(dep.status === 'full' || spacesLeft <= 0){ showError('This departure is fully booked — try another date from the tour page.'); return; }
    if(dep.status === 'request_only'){ showError('This departure is request-only — use "Build Your Adventure" to ask about it.'); return; }

    try { tour = await apiGet('/api/tours/' + encodeURIComponent(dep.tour_slug)); } catch(err) { tour = null; }
    try { addonCatalog = (await apiGet('/api/addons')).addons; } catch(err) { addonCatalog = []; }
    try { profile = (await apiGet('/api/riders/me')).rider; } catch(err) { profile = null; }

    document.getElementById('checkout-title').textContent = 'Book ' + dep.tour_name;
    document.getElementById('checkout-subtitle').textContent = dateFmt(dep.start_date) + ' → ' + dateFmt(dep.end_date);
    document.title = 'Checkout — ' + dep.tour_name + ' | High Route MTB';
    document.getElementById('checkout-crumb').innerHTML =
      `<a href="index.html">Home</a> / <a href="tour-detail.html?slug=${encodeURIComponent(dep.tour_slug)}">${escapeHtml(dep.tour_name)}</a> / Checkout`;

    renderDepartureSummary(spacesLeft);
    setupRiderStepper(spacesLeft);
    renderAddons();
    wireNav();
  }

  Auth.requireSignIn(init);
})();

/* ============================================================
   INVOICE (invoice.html) — GET /api/bookings/:id/invoice, rendered as a
   printable sheet (window.print() -> "Save as PDF" is the download
   mechanism, since this project ships no PDF-generation library).
   Accessible either while signed in as the booking's own rider, as an
   admin, or via ?token=<access_token> for a guest checkout link.
   ============================================================ */
(function(){
  const root = document.getElementById('invoice-root');
  if(!root) return;

  const params = new URLSearchParams(location.search);
  const bookingId = params.get('booking');
  const token = params.get('token');
  const money = c => '€' + (c/100).toLocaleString(undefined, { minimumFractionDigits:2 });
  const dateFmt = s => new Date(s).toLocaleDateString(undefined, { day:'numeric', month:'short', year:'numeric' });
  const STATUS_COLOR = { pending:'#E8B33D', deposit_paid:'#6FA0B8', completed:'#7FBF6B', cancelled:'#D9534F' };

  if(!bookingId){
    root.innerHTML = '<div class="invoice-sheet"><p style="color:var(--paper-dim);">No booking was specified.</p></div>';
    return;
  }

  const qs = token ? '?token=' + encodeURIComponent(token) : '';
  apiGet('/api/bookings/' + encodeURIComponent(bookingId) + '/invoice' + qs).then(inv => {
    document.title = 'Invoice ' + inv.invoice_number + ' | High Route MTB';
    root.innerHTML = `
      <div class="invoice-sheet">
        <div class="invoice-head">
          <div>
            <h2>High Route MTB</h2>
            <p style="color:var(--paper-dim); font-size:13px; margin:0;">Kathmandu, Nepal</p>
          </div>
          <div class="invoice-meta">
            Invoice <b>${escapeHtml(inv.invoice_number)}</b><br>
            Booking ref <b>${escapeHtml(inv.booking_reference)}</b><br>
            Issued ${dateFmt(inv.issued_at)}<br>
            <span class="invoice-status" style="background:${(STATUS_COLOR[inv.payment_status]||'#666')}22; color:${STATUS_COLOR[inv.payment_status] || '#C9C4B2'};">${escapeHtml(inv.payment_status)}</span>
          </div>
        </div>
        <div class="invoice-parties">
          <div><h5>Billed to</h5><p>${escapeHtml(inv.customer.name)}${inv.customer.email ? '<br>' + escapeHtml(inv.customer.email) : ''}</p></div>
          <div><h5>Trip</h5><p>${escapeHtml(inv.tour_name)}<br>${dateFmt(inv.start_date)} → ${dateFmt(inv.end_date)}<br>${inv.rider_count} rider(s)</p></div>
        </div>
        <table class="invoice-table">
          <thead><tr><th>Description</th><th>Amount</th></tr></thead>
          <tbody>${inv.line_items.map(li => `<tr><td>${escapeHtml(li.label)}</td><td>${li.amount_cents < 0 ? '−' : ''}${money(Math.abs(li.amount_cents))}</td></tr>`).join('')}</tbody>
        </table>
        <div class="invoice-totals">
          <div class="row"><span>Subtotal</span><span>${money(inv.subtotal_cents)}</span></div>
          ${inv.discount_cents > 0 ? `<div class="row"><span>Discount</span><span>−${money(inv.discount_cents)}</span></div>` : ''}
          ${inv.tax_cents > 0 ? `<div class="row"><span>Tax / fees</span><span>${money(inv.tax_cents)}</span></div>` : ''}
          <div class="row grand"><span>Total</span><span>${money(inv.total_cents)}</span></div>
          <div class="row"><span>Paid so far</span><span>${money(inv.amount_paid_cents)}</span></div>
          <div class="row"><span>Balance due</span><span>${money(inv.balance_due_cents)}</span></div>
        </div>
      </div>`;
  }).catch(err => {
    root.innerHTML = `<div class="invoice-sheet"><p style="color:var(--paper-dim);">Couldn't load this invoice (${escapeHtml(err.message)}).</p></div>`;
  });
})();

/* ============================================================
   CUSTOM-TRIP CHECKOUT (custom-checkout.html) — the same real multi-step
   flow checkout.html uses for a catalogue departure (rider count -> rider
   details -> add-ons -> review -> confirm), but for an APPROVED custom
   proposal instead: how many riders, their full details and any add-ons,
   with the price updating live, exactly like a normal booking — a custom
   trip was never meant to collect less information than a catalogue one.
   Reuses the exact same rider-card markup/validation/add-on pricing model
   as checkout.html (mirrored here, not literally shared, since the two
   flows submit to different endpoints with different payloads — POST
   /api/proposals/:id/pay, which both creates the booking AND charges the
   deposit in one step, unlike checkout's "pending, pay later" booking).
   ============================================================ */
(function(){
  const app = document.getElementById('cco-app');
  if(!app) return;

  const params = new URLSearchParams(location.search);
  const requestId = params.get('request');
  const money = c => '€' + (c/100).toLocaleString(undefined, { minimumFractionDigits:0 });
  const dateFmt = s => new Date(s).toLocaleDateString(undefined, { day:'numeric', month:'long', year:'numeric' });
  const RIDING_EXPERIENCE_OPTIONS = ['Beginner', 'Intermediate', 'Advanced', 'Expert'];
  const MAX_RIDERS = 20; // a private departure built just for this group — no shared-capacity cap, just a sane upper bound

  function showGate(){
    document.querySelector('.page-hero').classList.add('hidden');
    app.classList.add('hidden');
    document.getElementById('cco-gate').classList.remove('hidden');
  }
  function showError(msg){
    document.querySelector('.page-hero').classList.add('hidden');
    app.classList.add('hidden');
    document.getElementById('cco-gate').classList.add('hidden');
    document.getElementById('cco-error-msg').textContent = msg;
    document.getElementById('cco-error-view').classList.remove('hidden');
  }

  if(!requestId){ showError('No custom trip was specified.'); return; }
  showGate();

  let reqData = null, proposal = null, addonCatalog = [], profile = null;
  let riderCount = 1;
  let riderData = [];
  const selectedAddons = new Set();

  function computePricing(){
    const baseCents = proposal ? proposal.price_cents : 0; // a custom proposal's price is already the whole trip, not per person
    const addonItems = [...selectedAddons].map(key => {
      const a = addonCatalog.find(x => x.key === key);
      if(!a) return null;
      const quantity = a.unit === 'per_booking' ? 1 : riderCount;
      return { ...a, quantity, line_total_cents: a.price_cents * quantity };
    }).filter(Boolean);
    const addonsCents = addonItems.reduce((s, i) => s + i.line_total_cents, 0);
    const totalCents = baseCents + addonsCents;
    const depositPercent = proposal ? proposal.deposit_percent : 20;
    const depositCents = Math.round(totalCents * depositPercent / 100);
    const alreadyPaid = reqData ? (reqData.amount_paid_cents || 0) : 0;
    return { baseCents, addonItems, addonsCents, totalCents, depositCents, alreadyPaid, dueCents: Math.max(0, depositCents - alreadyPaid), balanceCents: totalCents - depositCents };
  }

  function updatePricingSidebar(){
    const p = computePricing();
    const setRow = (id, text, empty) => {
      const el = document.getElementById(id);
      el.textContent = text;
      el.closest('.ws-row').classList.toggle('empty', !!empty);
    };
    setRow('ccs-base', money(p.baseCents), false);
    setRow('ccs-addons', p.addonItems.length ? money(p.addonsCents) : 'None selected', !p.addonItems.length);
    document.getElementById('ccs-total').textContent = money(p.totalCents);
    document.getElementById('ccs-deposit-label').textContent = p.alreadyPaid > 0 ? `Deposit due now (${proposal.deposit_percent}%, ${money(p.alreadyPaid)} already paid)` : `Deposit due now (${proposal.deposit_percent}%)`;
    document.getElementById('ccs-deposit').textContent = money(p.dueCents);
    document.getElementById('ccs-balance').textContent = money(p.balanceCents);
    return p;
  }

  function renderProposalSummary(){
    document.getElementById('cco-proposal-summary').innerHTML = `
      <div class="ride-grid ride-grid-2col" style="margin-top:0;">
        <div class="ride-cell"><h5>Destination</h5><ul><li>${escapeHtml(proposal.destination)}</li></ul></div>
        <div class="ride-cell"><h5>Dates</h5><ul><li>${proposal.start_date ? dateFmt(proposal.start_date) : 'To be confirmed'}${proposal.duration_days ? ' · ' + proposal.duration_days + ' days' : ''}</li></ul></div>
        <div class="ride-cell"><h5>Trip price</h5><ul><li>${money(proposal.price_cents)}</li></ul></div>
        <div class="ride-cell"><h5>Deposit</h5><ul><li>${proposal.deposit_percent}% (${money(proposal.deposit_cents)})</li></ul></div>
      </div>
      ${proposal.riding_details ? `<p style="font-size:13px; color:var(--paper-dim); margin-top:14px;">${escapeHtml(proposal.riding_details)}</p>` : ''}`;
  }

  function setupRiderStepper(){
    const countEl = document.getElementById('cco-riders-count');
    const minusBtn = document.getElementById('cco-riders-minus');
    const plusBtn = document.getElementById('cco-riders-plus');
    function refresh(){
      countEl.textContent = riderCount;
      minusBtn.disabled = riderCount <= 1;
      plusBtn.disabled = riderCount >= MAX_RIDERS;
      updatePricingSidebar();
    }
    minusBtn.addEventListener('click', () => { if(riderCount > 1){ riderCount--; refresh(); } });
    plusBtn.addEventListener('click', () => { if(riderCount < MAX_RIDERS){ riderCount++; refresh(); } });
    refresh();
  }

  function riderCardHtml(i){
    const d = riderData[i] || {};
    return `<div class="rider-card" data-rider-index="${i}">
      <h3>${i === 0 ? 'Rider 1 (you)' : 'Rider ' + (i + 1)}</h3>
      <div class="rider-grid">
        <div class="checkout-field"><label>Full name</label><input class="checkout-input" data-field="name" value="${escapeHtml(d.name || '')}"></div>
        <div class="checkout-field"><label>Age</label><input class="checkout-input" type="number" min="1" max="120" data-field="age" value="${escapeHtml(d.age || '')}"></div>
        <div class="checkout-field"><label>Country</label><input class="checkout-input" data-field="country" value="${escapeHtml(d.country || '')}"></div>
        <div class="checkout-field"><label>Riding experience</label>
          <select class="checkout-input" data-field="ridingExperience">
            <option value="">Select…</option>
            ${RIDING_EXPERIENCE_OPTIONS.map(o => `<option ${d.ridingExperience === o ? 'selected' : ''}>${o}</option>`).join('')}
          </select>
        </div>
        <div class="checkout-field" style="grid-column:1/-1;"><label>Bike information</label>
          <input class="checkout-input" placeholder="Own bike make/model/size, or &quot;Renting&quot;" data-field="bikeInfo" value="${escapeHtml(d.bikeInfo || '')}"></div>
        <div class="checkout-field"><label>Emergency contact name</label><input class="checkout-input" data-field="emergencyContactName" value="${escapeHtml(d.emergencyContactName || '')}"></div>
        <div class="checkout-field"><label>Emergency contact phone</label><input class="checkout-input" data-field="emergencyContactPhone" value="${escapeHtml(d.emergencyContactPhone || '')}"></div>
        <div class="checkout-field" style="grid-column:1/-1;"><label>Special requirements (optional)</label>
          <textarea class="checkout-input" rows="2" data-field="specialRequirements">${escapeHtml(d.specialRequirements || '')}</textarea></div>
      </div>
    </div>`;
  }

  function renderRiderForms(){
    if(!riderData[0] && profile){
      riderData[0] = {
        name: profile.name || '', country: profile.country || '', ridingExperience: profile.riding_experience || '',
        bikeInfo: profile.bike_info || '', emergencyContactName: profile.emergency_contact_name || '',
        emergencyContactPhone: profile.emergency_contact_phone || '',
      };
    }
    const container = document.getElementById('cco-rider-forms');
    let html = '';
    for(let i = 0; i < riderCount; i++) html += riderCardHtml(i);
    container.innerHTML = html;
    container.querySelectorAll('[data-field]').forEach(el => {
      el.addEventListener('input', () => {
        const idx = Number(el.closest('.rider-card').dataset.riderIndex);
        if(!riderData[idx]) riderData[idx] = {};
        riderData[idx][el.dataset.field] = el.value;
      });
    });
  }

  function validateRidersClient(){
    const errors = [];
    for(let i = 0; i < riderCount; i++){
      const d = riderData[i] || {};
      const label = 'Rider ' + (i + 1);
      const age = Number(d.age);
      if(!String(d.name || '').trim()) errors.push(`${label}: full name is required`);
      if(!Number.isInteger(age) || age < 1 || age > 120) errors.push(`${label}: a valid age is required`);
      if(!String(d.country || '').trim()) errors.push(`${label}: country is required`);
      if(!String(d.ridingExperience || '').trim()) errors.push(`${label}: riding experience is required`);
      if(!String(d.bikeInfo || '').trim()) errors.push(`${label}: bike information is required`);
      if(!String(d.emergencyContactName || '').trim() || !String(d.emergencyContactPhone || '').trim()) {
        errors.push(`${label}: emergency contact name and phone are required`);
      }
    }
    return errors;
  }

  function renderAddons(){
    const el = document.getElementById('cco-addons-list');
    if(!addonCatalog.length){ el.innerHTML = '<p style="color:var(--paper-dim);">No add-ons are available right now.</p>'; return; }
    el.innerHTML = addonCatalog.map(a => {
      const qtyNote = a.unit === 'per_booking' ? 'once per booking' : `× ${riderCount} rider(s)`;
      const lineTotal = a.price_cents * (a.unit === 'per_booking' ? 1 : riderCount);
      return `<label class="addon-row">
        <input type="checkbox" data-addon="${escapeHtml(a.key)}" ${selectedAddons.has(a.key) ? 'checked' : ''}>
        <span class="addon-info"><b>${escapeHtml(a.label)}</b><span>${escapeHtml(a.description || '')} — ${money(a.price_cents)} ${qtyNote}</span></span>
        <span class="addon-price">${money(lineTotal)}</span>
      </label>`;
    }).join('');
    el.querySelectorAll('input[data-addon]').forEach(cb => {
      cb.addEventListener('change', () => {
        if(cb.checked) selectedAddons.add(cb.dataset.addon); else selectedAddons.delete(cb.dataset.addon);
        renderAddons();
        updatePricingSidebar();
      });
    });
  }

  function renderReview(){
    const p = updatePricingSidebar();
    const riderRows = riderData.slice(0, riderCount).map((d, i) =>
      `<div class="review-rider"><b>${escapeHtml(d.name || ('Rider ' + (i + 1)))}</b> — ${escapeHtml(String(d.age || ''))} yrs, ${escapeHtml(d.country || '')}, ${escapeHtml(d.ridingExperience || '')}${d.specialRequirements ? ' · ' + escapeHtml(d.specialRequirements) : ''}</div>`
    ).join('');
    const addonRows = p.addonItems.length
      ? p.addonItems.map(a => `<div class="review-rider">${escapeHtml(a.label)}${a.unit === 'per_rider' ? ' × ' + a.quantity : ''} — ${money(a.line_total_cents)}</div>`).join('')
      : '<div class="review-rider" style="color:var(--paper-dim);">None selected</div>';
    document.getElementById('cco-review').innerHTML = `
      <div class="review-block"><h4>Trip</h4><p style="margin:0;">${escapeHtml(proposal.destination)}${proposal.start_date ? ' — ' + dateFmt(proposal.start_date) : ''}</p></div>
      <div class="review-block"><h4>Riders (${riderCount})</h4>${riderRows}</div>
      <div class="review-block"><h4>Add-ons</h4>${addonRows}</div>
      <div class="review-block"><h4>Cancellation terms</h4><p style="font-size:14px; color:var(--paper-dim); margin:0;">
        If you cancel later, any refund on what you've already paid is calculated automatically from how far in advance you cancel.
        <a href="cancellation-policy.html">Read the full policy</a>.</p></div>`;
  }

  function wireNav(){
    const steps = [...document.querySelectorAll('.checkout-step')];
    const pips = [...document.querySelectorAll('.checkout-pip')];
    let current = 0;
    function showStep(i){
      steps.forEach((s, si) => s.classList.toggle('active', si === i));
      pips.forEach((p, pi) => { p.classList.toggle('done', pi < i); p.classList.toggle('active', pi === i); });
      current = i;
      const frame = document.querySelector('.checkout-frame');
      window.scrollTo({ top: frame.getBoundingClientRect().top + window.scrollY - 130, behavior: 'smooth' });
    }

    document.querySelectorAll('[data-cco-next]').forEach(btn => btn.addEventListener('click', () => {
      if(current === 1){ renderRiderForms(); }
      if(current === 2){
        const errors = validateRidersClient();
        const errEl = document.getElementById('cco-riders-error');
        if(errors.length){ errEl.textContent = errors.join('; '); errEl.classList.remove('hidden'); return; }
        errEl.classList.add('hidden');
        renderAddons();
      }
      if(current === 3){ renderReview(); }
      if(current < steps.length - 1) showStep(current + 1);
    }));
    document.querySelectorAll('[data-cco-back]').forEach(btn => btn.addEventListener('click', () => {
      if(current > 0) showStep(current - 1);
    }));

    document.getElementById('cco-confirm-btn').addEventListener('click', async () => {
      const btn = document.getElementById('cco-confirm-btn');
      const errEl = document.getElementById('cco-confirm-error');
      errEl.classList.add('hidden');
      btn.disabled = true; // guards against a double-click firing two payment requests
      btn.textContent = 'Confirming…';
      try {
        const payload = {
          riders: riderData.slice(0, riderCount).map(d => ({
            name: d.name, age: Number(d.age), country: d.country, ridingExperience: d.ridingExperience,
            bikeInfo: d.bikeInfo, emergencyContactName: d.emergencyContactName, emergencyContactPhone: d.emergencyContactPhone,
            specialRequirements: d.specialRequirements || undefined,
          })),
          addons: [...selectedAddons],
          card: {
            name: document.getElementById('cco-pay-name').value.trim(),
            number: document.getElementById('cco-pay-number').value.trim(),
            expiry: document.getElementById('cco-pay-expiry').value.trim(),
            cvv: document.getElementById('cco-pay-cvv').value.trim(),
          },
        };
        const result = await apiPost('/api/proposals/' + proposal.id + '/pay', payload);
        document.querySelector('.checkout-main').innerHTML = `
          <div class="checkout-confirm">
            <span class="q-num">Trip confirmed</span>
            <h2>You're booked!</h2>
            <p style="color:var(--paper-dim); max-width:52ch; margin:0 auto 24px;">
              Deposit paid: ${money(result.receipt.amount_cents)}. Balance due later: ${money(result.balance_due_cents)}.
            </p>
            <div style="display:flex; gap:12px; justify-content:center; flex-wrap:wrap;">
              <a href="dashboard.html" class="btn btn-solid">Go to my dashboard</a>
              ${result.booking_id ? `<a href="invoice.html?booking=${result.booking_id}" class="btn btn-ghost">View invoice</a>` : ''}
            </div>
          </div>`;
        const summary = document.querySelector('.checkout-summary');
        if(summary) summary.classList.add('hidden');
        document.getElementById('cco-subtitle').textContent = 'Deposit paid — trip confirmed';
        showToast('Trip confirmed!', 'success');
      } catch(err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = 'Pay deposit & confirm';
      }
    });

    showStep(0);
  }

  async function init(){
    document.getElementById('cco-gate').classList.add('hidden');
    document.querySelector('.page-hero').classList.remove('hidden');
    app.classList.remove('hidden');
    try {
      reqData = await apiGet('/api/riders/me/requests/' + encodeURIComponent(requestId));
    } catch(err) { showError('Could not load this request (' + err.message + ').'); return; }

    proposal = reqData.active_proposal;
    if(!proposal){ showError('This request doesn’t have a sent proposal yet.'); return; }
    if(reqData.booking_id){ showError('This trip is already booked — manage it from your dashboard instead.'); return; }
    if(proposal.status !== 'approved'){
      showError(proposal.status === 'sent'
        ? 'Approve this proposal from your dashboard before confirming and paying the deposit.'
        : `This proposal is ${proposal.status.replace('_',' ')} and can no longer be confirmed.`);
      return;
    }

    try { addonCatalog = (await apiGet('/api/addons')).addons; } catch(err) { addonCatalog = []; }
    try { profile = (await apiGet('/api/riders/me')).rider; } catch(err) { profile = null; }

    document.getElementById('cco-title').textContent = 'Confirm your ' + proposal.destination + ' trip';
    document.getElementById('cco-subtitle').textContent = (proposal.start_date ? dateFmt(proposal.start_date) : 'Dates to be confirmed') + ' · ' + money(proposal.price_cents);
    document.title = 'Confirm Trip — ' + proposal.destination + ' | High Route MTB';
    document.getElementById('cco-crumb').innerHTML =
      `<a href="index.html">Home</a> / <a href="dashboard.html">My account</a> / Confirm ${escapeHtml(proposal.destination)}`;

    renderProposalSummary();
    setupRiderStepper();
    renderAddons();
    wireNav();
  }

  Auth.requireSignIn(init);
})();

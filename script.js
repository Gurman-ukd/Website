'use strict';

/* ─── Utility ──────────────────────────────────────────────── */
const qs  = (sel, ctx = document) => ctx.querySelector(sel);
const qsa = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

/* ============================================================
   1. SCROLL-DRIVEN HERO VIDEO  — CANVAS + HYBRID SCRUB/PLAY
   ============================================================
   Why the old velocity/playbackRate approach stuttered:
   - playbackRate changes are applied asynchronously by the
     browser, and sub-1× rates decode frames on an uneven
     cadence → the video visibly froze then played in bursts.
   - Between scroll bursts the estimated velocity decayed below
     the "idle" threshold, so the video was parked at ~0× and
     then hard-seeked forward in one visible jump.

   This version splits the problem by scroll speed:
   - SLOW scroll → SCRUB: video PAUSED, currentTime = progress ×
     duration, with seeks throttled to one video frame (~1/30s)
     every ≥40ms so the decode queue never builds up. Time is a
     pure function of scroll position; every frame is exact.
   - FAST scroll → PLAY: the video actually PLAYS at a rate equal
     to the scroll speed (feedforward) plus a small error term
     (feedback). Frames advance sequentially — a fast-forward
     look — instead of jumping between distant frames.
   - At the last frame the video parks (play() on an ended video
     would make the browser loop back to 0).
   - Every rAF the latest decoded frame is drawn to the canvas.
   ============================================================ */
(function initScrollVideo() {
  const video      = qs('#heroVideo');
  const canvas     = qs('#heroCanvas');
  const container  = qs('#heroScrollContainer');
  const content    = qs('#heroContent');
  const fillBar    = qs('#heroProgressFill');
  const scrollHint = qs('#heroScrollHint');

  if (!video || !canvas || !container) return;

  const ctx = canvas.getContext('2d');

  /* ── Resize canvas to match viewport ── */
  function resizeCanvas() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas, { passive: true });

  /* ── Draw current video frame to canvas, cover-fit ── */
  function drawFrame() {
    if (video.readyState < 2) return;   // no frame available yet
    if (video.videoWidth === 0) return; // metadata not loaded

    const cw = canvas.width,  ch = canvas.height;
    const vw = video.videoWidth, vh = video.videoHeight;

    /* Calculate source rect to achieve "object-fit: cover" */
    const scale  = Math.max(cw / vw, ch / vh);
    const sw     = cw / scale;
    const sh     = ch / scale;
    const sx     = (vw - sw) / 2;
    const sy     = (vh - sh) / 2;

    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, cw, ch);
  }

  /* ── State ── */
  let duration    = 0;
  let isReady     = false;
  let lastSeekAt  = 0;
  let lastRate    = 0;
  let mode        = 'scrub';          // 'scrub' (paused seeks) | 'play' (fast-forward)
  let prevScrollY = window.scrollY;
  let scrollVel   = 0;                // px/sec, rAF-measured + smoothed
  let lastTickT   = performance.now();
  let negRateUnsupported = false;     // Safari can't play backward

  /* ── SCRUB mode (paused video, throttled currentTime seeks) ──
     Used for slow scrolling, idle parking and extreme flings.
     One video frame of media time (bg.webm is 30fps): we never
     seek for smaller deltas, and we cap seek frequency so the
     decode queue never builds up. */
  const SEEK_FRAME_STEP  = 1 / 30;
  const SEEK_INTERVAL_MS = 40;

  /* ── PLAY mode (video actually plays, frames advance in sequence) ──
     Below ~0.5× playback looks choppy, so slow scrolls stay in scrub
     mode. When the scroll demands a faster rate, we PLAY the video
     forward (or backward) — the decoder walks through every frame,
     which reads as "the video in speed", never as frame jumps. */
  const RATE_SWITCH_LO   = 0.5;       // drop to scrub below this rate
  const RATE_SWITCH_HI   = 0.75;      // switch to play above this rate
  const PLAY_RATE_MAX    = 8;         // fastest playable rate
  const PLAY_RATE_MIN    = 0.4;       // below this, frame decode gets choppy
  const RATE_GAIN        = 4;         // feedback: pull video time toward target
  const RATE_SET_EPS     = 0.05;      // don't spam playbackRate for tiny changes
  const PLAY_MAX_ERROR   = 0.75;      // beyond this, seek beats play (fling)
  const PLAY_REENTER_EPS = 0.3;       // hysteresis before returning to play

  /* ── Progress helper ── */
  function getProgress() {
    const scrollRange = container.offsetHeight - window.innerHeight;
    const scrolled    = Math.max(0, window.scrollY - container.offsetTop);
    return scrollRange > 0 ? Math.min(1, scrolled / scrollRange) : 0;
  }

  /* ── Start once video metadata is ready ── */
  function onReady() {
    duration = video.duration;
    if (!isFinite(duration) || duration === 0) return;
    if (isReady) return;   // prevent double-init
    isReady = true;

    /* Park the video at the frame matching the current scroll
       position — the rAF loop scrubs it from there. */
    video.pause();
    video.currentTime = getProgress() * duration;
  }

  // Try immediately if already loaded
  if (video.readyState >= 2 && video.duration > 0) {
    onReady();
  } else {
    video.addEventListener('loadeddata',     onReady, { once: true });
    video.addEventListener('canplaythrough', onReady, { once: true });
    video.addEventListener('canplay',        onReady, { once: true });
  }

  /* ── Guarantee the video is seekable ──
     Some static hosts (and many local setups) don't serve HTTP Range
     requests. The browser then reports seekable=[0,0] and silently
     ignores every currentTime seek — the video would never advance.
     Loading the file as a Blob URL makes it fully seekable on ANY
     host. If fetch is blocked (e.g. file://), we keep the original
     <source>, which is seekable locally anyway.
  */
  (async function ensureSeekable() {
    try {
      const res = await fetch('bg.webm');
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      video.src = URL.createObjectURL(blob);
    } catch (e) {
      /* keep the <source> element — local files seek directly */
    }
    video.load();
  })();

  /* ── Main rAF loop ── */
  function rafLoop() {
    requestAnimationFrame(rafLoop);

    /* ALWAYS draw — even before isReady, so the first frame shows immediately */
    drawFrame();

    if (!isReady || duration === 0) return;

    /* ── Scroll velocity (px/sec) measured from actual scrollY ── */
    const now  = performance.now();
    const dt   = Math.max(1, now - lastTickT);
    const dy   = window.scrollY - prevScrollY;
    prevScrollY = window.scrollY;
    const instVel = (dy / dt) * 1000;
    scrollVel = scrollVel * 0.8 + instVel * 0.2;
    lastTickT = now;

    const progress    = getProgress();
    const targetTime  = progress * duration;
    const scrollRange = container.offsetHeight - window.innerHeight;
    const secsPerPx   = duration / scrollRange;
    /* Playback rate the video would need to exactly track the scroll */
    const requiredRate = scrollVel * secsPerPx;

    const error = targetTime - video.currentTime;

    /* ── Mode selection (with hysteresis so we don't flap) ── */
    const canPlay = !(negRateUnsupported && requiredRate < 0);
    if (mode === 'scrub' &&
        Math.abs(requiredRate) > RATE_SWITCH_HI &&
        Math.abs(error) < PLAY_REENTER_EPS &&
        canPlay) {
      mode = 'play';
    }
    if (mode === 'play' &&
        (Math.abs(requiredRate) < RATE_SWITCH_LO ||
         Math.abs(error) > PLAY_MAX_ERROR ||
         !canPlay)) {
      mode = 'scrub';
    }

    if (mode === 'play') {
      /* ── PLAY: fast-forward / rewind through sequential frames ──
         Feedforward (requiredRate) + feedback (error) keeps the video
         glued to the scroll while the decoder walks frame by frame.
      */

      /* At the last frame: park instead of playing on — play() on an
         ended video makes the browser loop back to 0 (visible jump). */
      if (video.currentTime >= duration - 0.03) {
        video.pause();
        video.currentTime = targetTime;
        lastRate = 0;
        mode = 'scrub';
        lastSeekAt = now;
      } else {
        if (video.paused) video.play().catch(() => {});

        let rate = requiredRate + error * RATE_GAIN;
        rate = Math.max(-PLAY_RATE_MAX, Math.min(PLAY_RATE_MAX, rate));
        /* Never crawl below PLAY_RATE_MIN while in play mode — that
           sub-0.4× zone is exactly where frame decode gets uneven. */
        if (rate > -PLAY_RATE_MIN && rate < PLAY_RATE_MIN) {
          rate = rate >= 0 ? PLAY_RATE_MIN : -PLAY_RATE_MIN;
        }

        if (Math.abs(rate - lastRate) >= RATE_SET_EPS) {
          try {
            video.playbackRate = rate;
            lastRate = rate;
          } catch (e) {
            /* Negative rates unsupported (Safari) → rewind via scrub */
            negRateUnsupported = true;
            mode = 'scrub';
            if (!video.paused) video.pause();
          }
        }
        /* Keep the scrub throttle fresh so a mode switch can't burst */
        lastSeekAt = now;
      }
    } else {
      /* ── SCRUB: paused + throttled seeks ──
         The video time locks exactly to the scroll position and
         steps one video frame at a time.
      */
      if (!video.paused) {
        video.pause();
        lastRate = 0;
      }
      if (Math.abs(targetTime - video.currentTime) > SEEK_FRAME_STEP &&
          now - lastSeekAt >= SEEK_INTERVAL_MS) {
        video.currentTime = targetTime;
        lastSeekAt = now;
      }
    }

    /* ── Progress bar ── */
    if (fillBar) fillBar.style.width = (progress * 100) + '%';

    /* ── Scroll hint ── */
    if (scrollHint) scrollHint.classList.toggle('hidden', window.scrollY > 60);

    /* ── Hero content fade + lift ── */
    if (content) {
      const fadeStart = 0.18, fadeEnd = 0.55;
      let opacity, ty;
      if (progress <= fadeStart) {
        opacity = 1; ty = 0;
      } else if (progress >= fadeEnd) {
        opacity = 0; ty = -60;
      } else {
        const t = (progress - fadeStart) / (fadeEnd - fadeStart);
        opacity = 1 - t; ty = -60 * t;
      }
      content.style.opacity   = opacity;
      content.style.transform = `translateY(${ty}px)`;
    }
  }

  // Start rAF immediately so canvas starts drawing as soon as any frame arrives
  requestAnimationFrame(rafLoop);
})();

/* ============================================================
   2. NAVBAR
   ============================================================ */
(function initNavbar() {
  const navbar    = qs('#navbar');
  const hamburger = qs('#hamburger');
  const navLinks  = qs('.nav-links');

  function onScroll() {
    /* navbar kicks in after hero scroll container ends ~= 300vh */
    if (window.scrollY > 80) {
      navbar.classList.add('scrolled');
    } else {
      navbar.classList.remove('scrolled');
    }
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  if (hamburger) {
    hamburger.addEventListener('click', () => {
      navLinks.classList.toggle('open');
      document.body.style.overflow = navLinks.classList.contains('open') ? 'hidden' : '';
    });
  }
  qsa('.nav-links a').forEach(link => {
    link.addEventListener('click', () => {
      navLinks.classList.remove('open');
      document.body.style.overflow = '';
    });
  });
})();

/* ============================================================
   3. SMOOTH SCROLL (accounts for fixed navbar height)
   ============================================================ */
(function initSmoothScroll() {
  document.addEventListener('click', e => {
    const link = e.target.closest('a[href^="#"]');
    if (!link) return;
    const target = qs(link.getAttribute('href'));
    if (!target) return;
    e.preventDefault();
    const navH = qs('#navbar').offsetHeight;
    const top  = target.getBoundingClientRect().top + window.scrollY - navH - 16;
    window.scrollTo({ top, behavior: 'smooth' });
  });
})();

/* ============================================================
   4. SCROLL REVEAL  (all sections below hero)
   ============================================================ */
(function initReveal() {
  const els = qsa('.reveal-up, .reveal-left, .reveal-right, .reveal-scale');
  if (!els.length) return;

  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const el    = entry.target;
      const delay = el.dataset.delay ? parseInt(el.dataset.delay) : 0;
      const cssDelay = getComputedStyle(el).getPropertyValue('--delay').trim();

      el.style.transitionDelay = cssDelay
        ? cssDelay
        : `${delay}ms`;

      el.classList.add('in-view');
      observer.unobserve(el);
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

  els.forEach(el => observer.observe(el));
})();

/* ============================================================
   5. MENU TABS
   ============================================================ */
(function initMenuTabs() {
  const tabBtns = qsa('.tab-btn');
  const panels  = qsa('.menu-panel');
  if (!tabBtns.length) return;

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      panels.forEach(p => {
        p.classList.remove('active');
        if (p.id === `tab-${target}`) {
          p.classList.add('active');
          qsa('.reveal-up', p).forEach(el => {
            el.classList.remove('in-view');
            el.style.transitionDelay = '';
          });
          requestAnimationFrame(() => {
            qsa('.reveal-up', p).forEach((el, i) => {
              setTimeout(() => {
                el.style.transitionDelay = `${i * 60}ms`;
                el.classList.add('in-view');
              }, 30);
            });
          });
        }
      });
    });
  });

  /* Initial reveal for first tab */
  qsa('#tab-starters .reveal-up').forEach((el, i) => {
    setTimeout(() => {
      el.style.transitionDelay = `${i * 60}ms`;
      el.classList.add('in-view');
    }, 400);
  });
})();

/* ============================================================
   6. TESTIMONIAL SLIDER
   ============================================================ */
(function initTestiSlider() {
  const track = qs('#testiTrack');
  const dots  = qsa('#testiDots .dot');
  const prev  = qs('#testiPrev');
  const next  = qs('#testiNext');
  if (!track) return;

  let current = 0;
  const total = qsa('.testi-card').length;
  let timer   = null;

  function goTo(idx) {
    current = (idx + total) % total;
    track.style.transform = `translateX(-${current * 100}%)`;
    dots.forEach((d, i) => d.classList.toggle('active', i === current));
  }

  function resetTimer() { clearInterval(timer); timer = setInterval(() => goTo(current + 1), 5000); }

  prev && prev.addEventListener('click', () => { goTo(current - 1); resetTimer(); });
  next && next.addEventListener('click', () => { goTo(current + 1); resetTimer(); });
  dots.forEach((d, i) => d.addEventListener('click', () => { goTo(i); resetTimer(); }));

  let startX = 0;
  track.addEventListener('touchstart', e => { startX = e.touches[0].clientX; }, { passive: true });
  track.addEventListener('touchend', e => {
    const diff = startX - e.changedTouches[0].clientX;
    if (Math.abs(diff) > 50) { goTo(diff > 0 ? current + 1 : current - 1); resetTimer(); }
  });

  resetTimer();
})();

/* ============================================================
   7. RESERVATION FORM
   ============================================================ */
(function initForm() {
  const form    = qs('#reservationForm');
  const success = qs('#formSuccess');
  if (!form) return;

  const dateInput = qs('#date');
  if (dateInput) dateInput.min = new Date().toISOString().split('T')[0];

  form.addEventListener('submit', e => {
    e.preventDefault();
    const btn = form.querySelector('[type="submit"]');
    const orig = btn.textContent;
    btn.textContent = 'Confirming…';
    btn.disabled = true;

    setTimeout(() => {
      form.style.cssText = 'opacity:0; transform:scale(0.97); transition:all 0.4s ease;';
      setTimeout(() => {
        form.style.display = 'none';
        success.classList.add('visible');
        btn.textContent = orig;
        btn.disabled = false;
      }, 400);
    }, 1200);
  });
})();

/* ============================================================
   8. STAT COUNTER ANIMATION
   ============================================================ */
(function initCounters() {
  const nums = qsa('.stat-num');
  if (!nums.length) return;

  const obs = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const el   = entry.target;
      const text = el.textContent.trim();
      const num  = parseFloat(text);
      const suf  = text.replace(/[\d.]/g, '');
      if (isNaN(num)) return;

      let cur = 0;
      const inc = num / (1800 / 16);
      const run = setInterval(() => {
        cur += inc;
        if (cur >= num) { cur = num; clearInterval(run); }
        el.textContent = (Number.isInteger(num) ? Math.floor(cur) : cur.toFixed(1)) + suf;
      }, 16);

      obs.unobserve(el);
    });
  }, { threshold: 0.5 });

  nums.forEach(n => obs.observe(n));
})();

/* ============================================================
   9. MARQUEE PAUSE ON HOVER
   ============================================================ */
(function initMarquee() {
  const strip = qs('.marquee-strip');
  const track = qs('.marquee-track');
  if (!strip || !track) return;
  strip.addEventListener('mouseenter', () => { track.style.animationPlayState = 'paused'; });
  strip.addEventListener('mouseleave', () => { track.style.animationPlayState = 'running'; });
})();

/* ============================================================
   10. PAGE LOAD FADE-IN  +  HERO CONTENT ENTRANCE
   ============================================================ */
(function initLoad() {
  document.body.style.cssText = 'opacity:0; transition:opacity 0.5s ease;';

  window.addEventListener('load', () => {
    document.body.style.opacity = '1';
  });
})();

/* ============================================================
   11. SUBTLE CURSOR GLOW  (desktop only)
   ============================================================ */
(function initCursorGlow() {
  if (window.matchMedia('(pointer: coarse)').matches) return;

  const glow = Object.assign(document.createElement('div'), {});
  glow.style.cssText = [
    'position:fixed', 'pointer-events:none', 'z-index:9999',
    'width:320px', 'height:320px', 'border-radius:50%',
    'background:radial-gradient(circle, rgba(201,168,76,0.055) 0%, transparent 70%)',
    'transform:translate(-50%,-50%)', 'will-change:left,top',
  ].join(';');
  document.body.appendChild(glow);

  let mx = 0, my = 0, gx = 0, gy = 0;
  document.addEventListener('mousemove', e => { mx = e.clientX; my = e.clientY; });

  (function animate() {
    gx += (mx - gx) * 0.08;
    gy += (my - gy) * 0.08;
    glow.style.left = gx + 'px';
    glow.style.top  = gy + 'px';
    requestAnimationFrame(animate);
  })();
})();

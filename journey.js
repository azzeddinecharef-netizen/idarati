// ============================================================================
// IDARATI Company - Meta Pixel & Comprehensive Journey Analytics Engine
// Based on advanced funnel architecture with event deduplication (eventID),
// first-touch attribution (UTM/fbclid), form drop-off analytics, and scroll telemetry.
// Debug mode: add ?analytics_debug=1 to any URL to view real-time events.
// ============================================================================

(() => {
  const META_STANDARD = new Set([
    'AddPaymentInfo', 'AddToCart', 'AddToWishlist', 'CompleteRegistration',
    'Contact', 'CustomizeProduct', 'Donate', 'FindLocation', 'InitiateCheckout',
    'Lead', 'PageView', 'Purchase', 'Schedule', 'Search', 'StartTrial',
    'SubmitApplication', 'Subscribe', 'ViewContent'
  ]);

  const SCROLL_MARKS = [10, 25, 50, 75, 90, 100];
  const TIME_MARKS = [5, 15, 30, 60, 120, 180, 300];
  const IDLE_MS = 45000;
  const ENGAGED_WINDOW_MS = 30000;
  const FORM_ID = 'leadForm';
  const FORM_HASH = '#form';
  const DEBUG = new URLSearchParams(location.search).get('analytics_debug') === '1';
  const now = () => performance.now();

  const session = {
    startedAt: now(),
    maxScroll: 0,
    scrollMarks: new Set(),
    sections: [],
    deepestSection: '',
    interactions: 0,
    clicks: 0,
    ctaClicks: 0,
    firstInteractionAt: null,
    activeMs: 0,
    lastActivityAt: now(),
    hiddenCount: 0,
    lead: false,
    leaveSent: false,
    form: null,
    once: new Set()
  };

  const secondsOnPage = () => Math.round((now() - session.startedAt) / 100) / 10;
  const engagedSeconds = () => Math.round(session.activeMs / 100) / 10;

  function once(key, run) {
    if (session.once.has(key)) return;
    session.once.add(key);
    run();
  }

  /* ---------- Attribution (First-touch preserved across session) ---------- */
  let attribution = null;
  function getAttribution() {
    if (attribution) return attribution;
    try {
      const stored = sessionStorage.getItem('idarati_attribution');
      if (stored) return (attribution = JSON.parse(stored));
    } catch {}

    const query = new URLSearchParams(location.search);
    const q = key => query.get(key) || undefined;
    let referrer = 'direct';
    try {
      if (document.referrer) referrer = new URL(document.referrer).hostname;
    } catch {}

    const parsed = {
      utm_source: q('utm_source'),
      utm_medium: q('utm_medium'),
      utm_campaign: q('utm_campaign'),
      utm_content: q('utm_content'),
      utm_term: q('utm_term'),
      fbclid: q('fbclid'),
      gclid: q('gclid'),
      ttclid: q('ttclid'),
      referrer,
      landing_path: location.pathname
    };

    // Auto-attribute paid channels if UTMs are omitted but click ID exists
    if (!parsed.utm_source && parsed.fbclid) {
      parsed.utm_source = 'facebook';
      parsed.utm_medium = parsed.utm_medium || 'paid_social';
    }
    if (!parsed.utm_source && parsed.gclid) {
      parsed.utm_source = 'google';
      parsed.utm_medium = parsed.utm_medium || 'cpc';
    }
    if (!parsed.utm_source && parsed.ttclid) {
      parsed.utm_source = 'tiktok';
      parsed.utm_medium = parsed.utm_medium || 'paid_social';
    }

    attribution = parsed;
    try {
      sessionStorage.setItem('idarati_attribution', JSON.stringify(parsed));
    } catch {}
    return parsed;
  }

  function readMetaCookie(name) {
    const prefix = `${name}=`;
    const value = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith(prefix));
    if (!value) return '';
    try { return decodeURIComponent(value.slice(prefix.length)); } catch { return ''; }
  }

  /* ---------- Device & Payload Sanitization ---------- */
  function deviceContext() {
    const width = innerWidth;
    return {
      device: matchMedia('(pointer: coarse)').matches ? 'touch' : 'pointer',
      viewport: width < 640 ? 'sm' : width < 1024 ? 'md' : 'lg',
      viewport_w: width,
      viewport_h: innerHeight,
      connection: navigator.connection?.effectiveType
    };
  }

  function clean(params) {
    const out = {};
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      out[key] = typeof value === 'string'
        ? value.slice(0, 120)
        : typeof value === 'number'
          ? Math.round(value * 100) / 100
          : value;
    }
    return out;
  }

  let eventSeq = 0;
  const makeEventId = name => `${name}.${Math.round(Date.now() / 1000)}.${++eventSeq}.${Math.random().toString(36).slice(2, 8)}`;
  const toPascal = name => name.split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');

  function baseParams() {
    const a = getAttribution();
    return {
      page_path: location.pathname,
      locale: document.documentElement.lang || 'ar',
      seconds_on_page: secondsOnPage(),
      engaged_seconds: engagedSeconds(),
      scroll_depth: session.maxScroll,
      sections_seen: session.sections.length,
      interactions: session.interactions,
      utm_source: a.utm_source,
      utm_medium: a.utm_medium,
      utm_campaign: a.utm_campaign,
      referrer: a.referrer
    };
  }

  /* ---------- Meta Pixel Dispatcher with Deduplication ---------- */
  function emit(name, { meta, params = {}, withDevice = false, eventId = null } = {}) {
    const payload = clean({
      ...baseParams(),
      ...(withDevice ? deviceContext() : {}),
      ...params
    });

    const metaName = meta ?? toPascal(name);

    if (DEBUG) {
      console.info(`%c[IDARATI Analytics] ${name}`, 'color:#1F5FBF;font-weight:bold;', {
        meta: metaName,
        eventId: eventId || 'generated',
        payload
      });
    }

    if (typeof window.fbq !== 'function' || metaName === false) return;

    try {
      const eid = eventId || makeEventId(name);
      window.fbq(META_STANDARD.has(metaName) ? 'track' : 'trackCustom', metaName, payload, { eventID: eid });
    } catch (e) {
      if (DEBUG) console.warn('[IDARATI Analytics] fbq error:', e);
    }
  }

  /* ---------- IDARATI Services & Lead Funnel ---------- */
  function getServiceData() {
    const form = document.getElementById(FORM_ID);
    const selectedWilaya = form?.querySelector('input[name="wilaya"]:checked')?.value || 'Alger';
    return {
      content_name: 'Création Entreprise Alger & Blida',
      content_category: 'business_formation',
      service_type: 'creation_entreprise',
      target_wilaya: selectedWilaya,
      currency: 'DZD'
    };
  }

  function trackViewContent(trigger) {
    once('view_content', () => {
      emit('view_content', {
        meta: 'ViewContent',
        params: { ...getServiceData(), trigger_section: trigger }
      });
    });
  }

  function trackOrderIntent(id, label, section) {
    emit('order_intent', {
      params: { cta_id: id, cta_label: label, section }
    });
    once('add_to_cart_intent', () => {
      emit('add_to_cart', {
        meta: 'AddToCart',
        params: { ...getServiceData(), trigger: 'cta_click', cta_id: id }
      });
    });
  }

  function startForm() {
    if (session.form) return;
    session.form = {
      startedAt: now(),
      touched: [],
      filled: [],
      lastField: '',
      errors: 0,
      attempts: 0,
      submitted: false
    };

    once('initiate_checkout', () => {
      emit('form_start', {
        meta: 'InitiateCheckout',
        params: {
          ...getServiceData(),
          form_id: FORM_ID,
          content_name: 'Demande Consultation Création'
        }
      });
    });
  }

  function trackFieldFocus(field) {
    const form = session.form;
    if (!form) return;
    form.lastField = field;
    if (form.touched.includes(field)) return;
    form.touched.push(field);
    emit('form_field_focus', {
      params: { form_id: FORM_ID, field_name: field, field_order: form.touched.length }
    });
  }

  function trackFieldComplete(field, filled) {
    const form = session.form;
    if (!form) return;
    if (!filled) {
      emit('form_field_skipped', { params: { form_id: FORM_ID, field_name: field } });
      return;
    }
    if (form.filled.includes(field)) return;
    form.filled.push(field);
    emit('form_field_complete', {
      params: {
        form_id: FORM_ID,
        field_name: field,
        fields_filled: form.filled.length,
        seconds_since_start: Math.round((now() - form.startedAt) / 1000)
      }
    });
  }

  function trackFormValidationError(field, message) {
    if (session.form) session.form.errors += 1;
    emit('form_error', {
      meta: 'FormValidationError',
      params: {
        form_id: FORM_ID,
        field_name: field,
        error_message: message,
        error_count: session.form?.errors || 1
      }
    });
  }

  function trackFormSubmitAttempt() {
    startForm();
    const form = session.form;
    form.attempts += 1;
    emit('form_submit', {
      meta: 'FormSubmit',
      params: {
        form_id: FORM_ID,
        attempt: form.attempts,
        fields_filled: form.filled.length,
        seconds_to_submit: Math.round((now() - form.startedAt) / 1000)
      }
    });
  }

  function trackFormFailure(reason) {
    emit('form_submit_failed', {
      meta: 'FormFailed',
      params: { form_id: FORM_ID, error_message: reason }
    });
  }

  function trackLeadConversion({ eventId, wilaya, activity, company_name }) {
    session.lead = true;
    if (session.form) session.form.submitted = true;
    const form = session.form;
    const params = {
      ...getServiceData(),
      form_id: FORM_ID,
      content_name: 'Demande Création Entreprise',
      wilaya: wilaya || 'Alger',
      activity: activity || '',
      has_company_name: Boolean(company_name),
      seconds_to_convert: secondsOnPage(),
      fields_filled: form?.filled.length || 0,
      form_attempts: form?.attempts || 1,
      form_errors: form?.errors || 0,
      fbp: readMetaCookie('_fbp'),
      fbc: readMetaCookie('_fbc')
    };

    emit('generate_lead', { meta: 'Lead', params, eventId });
    emit('consultation_conversion', { meta: 'ConsultationRequested', params, eventId });
  }

  function trackFormAbandon(reason) {
    const form = session.form;
    if (!form || form.submitted) return;
    once('form_abandon', () => {
      emit('form_abandon', {
        params: {
          form_id: FORM_ID,
          reason,
          last_field: form.lastField,
          fields_touched: form.touched.length,
          fields_filled: form.filled.length,
          form_errors: form.errors,
          form_attempts: form.attempts,
          seconds_in_form: Math.round((now() - form.startedAt) / 1000)
        }
      });
    });
  }

  /* ---------- Funnel Stage & Page Leave ---------- */
  function funnelStage() {
    if (session.lead) return 'converted';
    if (session.form?.submitted) return 'submitted';
    if (session.form) return 'form_started';
    if (session.ctaClicks > 0) return 'cta_clicked';
    if (session.maxScroll >= 75) return 'read_full';
    if (session.maxScroll >= 25) return 'scrolled';
    if (session.interactions > 0) return 'interacted';
    return 'landed';
  }

  function trackPageLeave(reason) {
    if (session.leaveSent) return;
    session.leaveSent = true;
    const stage = funnelStage();
    const bounced = !session.lead && session.interactions === 0 && session.maxScroll < 25 && engagedSeconds() < 10;

    emit('page_leave', {
      params: {
        leave_reason: reason,
        leave_index: session.hiddenCount,
        funnel_stage: stage,
        deepest_section: session.deepestSection,
        sections_list: session.sections.join('>').slice(0, 100),
        max_scroll: session.maxScroll,
        total_clicks: session.clicks,
        cta_clicks: session.ctaClicks,
        tab_hides: session.hiddenCount,
        converted: session.lead,
        bounced
      }
    });

    if (!session.lead) {
      once('abandonment', () => {
        emit('abandonment', {
          params: {
            funnel_stage: stage,
            max_scroll: session.maxScroll,
            form_started: Boolean(session.form),
            fields_filled: session.form?.filled.length ?? 0,
            engaged_seconds: engagedSeconds()
          }
        });
      });
    }

    if (bounced) {
      once('bounce', () => emit('bounce', { params: { max_scroll: session.maxScroll } }));
    }

    trackFormAbandon(reason);
  }

  /* ---------- User Interactions & Scroll Tracking ---------- */
  function markInteraction(kind) {
    const at = now();
    if (session.firstInteractionAt === null || at - session.lastActivityAt > 1000) {
      session.interactions += 1;
    }
    session.lastActivityAt = at;
    if (session.firstInteractionAt !== null) return;
    session.firstInteractionAt = at;
    emit('first_interaction', { params: { interaction_type: kind } });
  }

  ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach(type => {
    addEventListener(type, () => markInteraction('input'), { passive: true });
  });

  let scrollTicking = false, scrolled = false, lastY = scrollY, scrollBackReported = false;
  function measureScroll(silent) {
    scrollTicking = false;
    const depth = Math.max(0, Math.min(100, Math.round((scrollY + innerHeight) / Math.max(document.documentElement.scrollHeight, 1) * 100)));
    if (depth > session.maxScroll) {
      session.maxScroll = depth;
      for (const mark of SCROLL_MARKS) {
        if (depth < mark || session.scrollMarks.has(mark)) continue;
        session.scrollMarks.add(mark);
        if (silent) continue;
        emit('scroll', { meta: `ScrollDepth${mark}`, params: { percent_scrolled: mark, depth_label: `${mark}%` } });
        if (mark === 50) trackViewContent('scroll_50');
      }
    } else if (!scrollBackReported && session.maxScroll - depth >= 25 && session.maxScroll >= 50) {
      scrollBackReported = true;
      emit('scroll_back', { params: { from_depth: session.maxScroll, to_depth: depth } });
    }
  }

  measureScroll(true);
  addEventListener('scroll', () => {
    markInteraction('scroll');
    if (!scrolled) {
      scrolled = true;
      emit('first_scroll', { params: { direction: scrollY >= lastY ? 'down' : 'up' } });
    }
    lastY = scrollY;
    if (scrollTicking) return;
    scrollTicking = true;
    requestAnimationFrame(() => measureScroll(false));
  }, { passive: true });

  /* ---------- Time on Page & Dwell Observer ---------- */
  const timeMarks = new Set();
  let idleReported = false;
  setInterval(() => {
    const visible = document.visibilityState === 'visible';
    const sinceActivity = now() - session.lastActivityAt;
    if (visible && sinceActivity < ENGAGED_WINDOW_MS) {
      session.activeMs += 1000;
      idleReported = false;
    } else if (visible && sinceActivity >= IDLE_MS && !idleReported) {
      idleReported = true;
      emit('user_idle', { params: { idle_seconds: Math.round(sinceActivity / 1000), funnel_stage: funnelStage() } });
    }

    const elapsed = secondsOnPage();
    for (const mark of TIME_MARKS) {
      if (elapsed < mark || timeMarks.has(mark)) continue;
      timeMarks.add(mark);
      emit('time_on_page', { meta: `TimeOnPage${mark}s`, params: { milestone_seconds: mark } });
    }
  }, 1000);

  /* ---------- Clicks & CTAs ---------- */
  function labelOf(el) {
    if (el.closest('.form-card')) return el.id || el.name || el.tagName.toLowerCase();
    return el.getAttribute('data-track-label') ||
           el.getAttribute('aria-label') ||
           el.textContent.trim().replace(/\s+/g, ' ').slice(0, 80) ||
           el.tagName.toLowerCase();
  }

  function positionOf(el) {
    const ratio = (el.getBoundingClientRect().top + scrollY) / (document.documentElement.scrollHeight || 1);
    return ratio < 0.25 ? 'top' : ratio < 0.7 ? 'middle' : 'bottom';
  }

  const trackContact = (channel, position, href) => emit('contact', {
    meta: 'Contact',
    params: { contact_channel: channel, position, contact_target: href }
  });

  let lastClickAt = 0, lastX = 0, lastClickY = 0, streak = 0, rageReportedAt = 0, deadClicks = 0;
  document.addEventListener('click', event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    session.clicks += 1;

    const near = Math.abs(event.clientX - lastX) < 40 && Math.abs(event.clientY - lastClickY) < 40;
    streak = event.timeStamp - lastClickAt < 800 && near ? streak + 1 : 1;
    lastClickAt = event.timeStamp; lastX = event.clientX; lastClickY = event.clientY;
    if (streak >= 3 && event.timeStamp - rageReportedAt > 5000) {
      rageReportedAt = event.timeStamp;
      emit('rage_click', { params: { target_label: labelOf(target), click_count: streak } });
    }

    // 1. Explicitly tracked elements [data-track]
    const tracked = target.closest('[data-track]');
    if (tracked) {
      const { track: id = 'unknown', trackType: type = 'cta', trackSection: section } = tracked.dataset;
      const href = tracked.getAttribute('href') || undefined;
      const label = labelOf(tracked);
      session.ctaClicks += 1;

      emit('cta_click', {
        meta: 'ClickCTA',
        params: {
          cta_id: id,
          cta_type: type,
          cta_label: label,
          section,
          link_url: href,
          position: positionOf(tracked),
          cta_order: session.ctaClicks
        }
      });

      if (type === 'contact' || href?.includes('wa.me') || href?.startsWith('tel:')) {
        trackContact(href?.includes('wa.me') ? 'whatsapp' : 'phone', positionOf(tracked), href);
      }
      if (type === 'consultation' || href === FORM_HASH) {
        trackOrderIntent(id, label, section);
      }
      return;
    }

    // 2. Links
    const link = target.closest('a[href]');
    if (link) {
      const href = link.getAttribute('href') || '';
      const label = labelOf(link);
      if (href.includes('wa.me') || href.includes('whatsapp.com')) {
        session.ctaClicks += 1;
        trackContact('whatsapp', positionOf(link), href);
      } else if (href.startsWith('tel:')) {
        session.ctaClicks += 1;
        trackContact('phone', positionOf(link), href);
      } else if (href.startsWith('mailto:')) {
        trackContact('email', positionOf(link), href);
      } else if (href === FORM_HASH || href.endsWith('/#form') || href.includes('/form/') || href.includes('/order/')) {
        trackOrderIntent('in_page_link', label, positionOf(link));
      } else if (link.hostname && link.hostname !== location.hostname) {
        emit('outbound_click', { params: { link_url: href, link_label: label } });
      }
      return;
    }

    // 3. UI Buttons
    if (target.closest('input, select, textarea, label')) return;
    const button = target.closest('button, [role="button"], summary');
    if (button) {
      emit('ui_click', { params: { element: button.tagName.toLowerCase(), element_label: labelOf(button) } });
      return;
    }

    // 4. Dead clicks
    if (deadClicks++ < 5) {
      emit('dead_click', { params: { target_label: labelOf(target) } });
    }
  }, { capture: true });

  // FAQ accordion tracking
  document.addEventListener('toggle', event => {
    const item = event.target;
    if (!(item instanceof HTMLDetailsElement) || !item.open) return;
    const items = [...document.querySelectorAll('details')];
    emit('faq_open', {
      meta: 'FAQOpen',
      params: {
        item_index: items.indexOf(item) + 1,
        item_label: item.querySelector('summary')?.textContent.trim()
      }
    });
  }, true);

  // Video / Audio playback tracking
  function trackMediaPlay(el) {
    const kind = el.tagName === 'AUDIO' ? 'audio' : 'video';
    const src = el.src || el.currentSrc || 'media';
    once(`media_play_${src}`, () => {
      emit(`${kind}_play`, {
        params: {
          media_type: kind,
          media_src: src.split('/').pop(),
          media_title: el.title || el.getAttribute('aria-label') || 'IDARATI Media'
        }
      });
    });
  }
  document.addEventListener('play', event => trackMediaPlay(event.target), true);

  // Exit Intent (desktop pointer leaves via top of window)
  if (!matchMedia('(pointer: coarse)').matches) {
    let exitFired = false;
    document.addEventListener('mouseout', event => {
      if (exitFired || event.relatedTarget || event.clientY > 8) return;
      exitFired = true;
      emit('exit_intent', {
        params: {
          deepest_section: session.deepestSection,
          form_started: Boolean(session.form),
          has_lead: session.lead
        }
      });
    });
  }

  // Leaving / Visibility
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      session.hiddenCount += 1;
      emit('tab_hidden', { params: { hidden_count: session.hiddenCount } });
      trackPageLeave('hidden');
    } else {
      emit('tab_return', {
        params: {
          away_seconds: hiddenAt ? Math.round((Date.now() - hiddenAt) / 1000) : 0,
          return_count: session.hiddenCount
        }
      });
      session.leaveSent = false;
    }
  });

  addEventListener('pagehide', () => trackPageLeave('pagehide'));
  addEventListener('pageshow', event => {
    if (!event.persisted) return;
    session.leaveSent = false;
    emit('page_restored');
  });

  // Section visibility and dwell time
  const sectionNodes = [...document.querySelectorAll('[data-section]')];
  const enteredAt = new Map();
  const reportDwell = (name, start) => {
    const dwell = Math.round((Date.now() - start) / 1000);
    if (dwell >= 2) emit('section_dwell', { params: { section_name: name, dwell_seconds: dwell } });
  };

  if (sectionNodes.length && 'IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const name = entry.target.dataset.section;
        const seen = entry.isIntersecting && (entry.intersectionRatio >= 0.3 || entry.intersectionRect.height >= innerHeight * 0.4);
        if (seen) {
          if (!enteredAt.has(name)) enteredAt.set(name, Date.now());
          if (session.sections.includes(name)) continue;
          session.sections.push(name);
          session.deepestSection = name;
          emit('section_view', {
            meta: 'ViewSection',
            params: { section_name: name, section_index: sectionNodes.indexOf(entry.target) + 1, seconds_to_view: secondsOnPage() }
          });
          if (name === 'services' || name === 'steps') trackViewContent(name);
          if (name === 'form' || name === 'consultation_form') {
            emit('form_view', { params: { form_id: FORM_ID, seconds_to_view: secondsOnPage() } });
          }
          continue;
        }
        const start = enteredAt.get(name);
        if (start) {
          enteredAt.delete(name);
          reportDwell(name, start);
        }
      }
    }, { threshold: [0, 0.3, 0.6] });

    sectionNodes.forEach(node => observer.observe(node));
    addEventListener('pagehide', () => {
      enteredAt.forEach((start, name) => reportDwell(name, start));
      enteredAt.clear();
    });
  }

  // Lead Form field listeners
  const formElement = document.getElementById(FORM_ID);
  if (formElement) {
    const fieldOf = el => el.closest?.('.field') && (el.name || el.id);
    formElement.addEventListener('focusin', event => {
      const field = fieldOf(event.target);
      if (!field) return;
      startForm();
      trackFieldFocus(field);
    });

    formElement.addEventListener('input', event => {
      if (fieldOf(event.target)) startForm();
    });

    formElement.addEventListener('focusout', event => {
      const field = fieldOf(event.target);
      if (field) {
        const val = event.target.type === 'radio'
          ? Boolean(formElement.querySelector(`input[name="${event.target.name}"]:checked`))
          : Boolean(event.target.value?.trim());
        trackFieldComplete(field, val);
      }
    });

    formElement.addEventListener('change', event => {
      const field = fieldOf(event.target);
      if (field) {
        startForm();
        trackFieldComplete(field, true);
      }
    });
  }

  // Session Start
  const firstTouch = getAttribution();
  emit('session_start', {
    withDevice: true,
    params: {
      landing_path: location.pathname,
      fbclid: firstTouch.fbclid ? 'yes' : 'no',
      utm_content: firstTouch.utm_content,
      utm_term: firstTouch.utm_term
    }
  });

  // Global Exports for landing scripts
  const api = {
    emit,
    trackFormSubmitAttempt,
    trackFormValidationError,
    trackFormFailure,
    trackLeadConversion,
    trackContact,
    trackOrderIntent,
    readMetaCookie,
    getAttribution
  };

  window.IDARATI_JOURNEY = api;
  window.ELB_JOURNEY = api; // alias for universal compatibility
})();

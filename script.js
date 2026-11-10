/* ==========================================================
   NEUROVOLT — script.js
   Vanilla JS engine for the existing index.html / style.css.
   No frameworks, no external libraries.
   ========================================================== */

(function () {
  'use strict';

  // ----------------------------------------------------------
  // CONSTANTS
  // ----------------------------------------------------------
  const STORAGE_KEY = 'neurovolt_data_v1';
  const DEFAULT_RATE = 8; // ₹ per kWh, used until the user sets one via the form
  const CO2_PER_KWH = 0.82; // kg CO2 per kWh — approximate India grid average, used for footprint estimates

  // Mirrors the three rows already hardcoded in the original table markup,
  // so the page behaves the same on first load before the user adds anything.
  const DEFAULT_APPLIANCES = [
    { id: 'default-ac', name: 'Air Conditioner', power: 1500, quantity: 1, hours: 6 },
    { id: 'default-fridge', name: 'Refrigerator', power: 200, quantity: 1, hours: 24 },
    { id: 'default-fan', name: 'Fan', power: 75, quantity: 1, hours: 20 }
  ];

  // ----------------------------------------------------------
  // STATE
  // ----------------------------------------------------------
  let state = {
    rate: DEFAULT_RATE,
    appliances: []
  };
   // Chart.js instances — stored so renderCharts() can destroy/recreate
  // instead of piling up new instances on every renderAll().
  let applianceChart = null;
  let energyComparisonChart = null;

  // ----------------------------------------------------------
  // SMALL UTILITIES
  // ----------------------------------------------------------
  function $(selector, scope) { return (scope || document).querySelector(selector); }
  function $all(selector, scope) { return Array.from((scope || document).querySelectorAll(selector)); }

  function clamp(n, min, max) {
    if (isNaN(n)) return min;
    return Math.min(Math.max(n, min), max);
  }

  function safeNumber(n, fallback) {
    return isNaN(n) || n === null || n === undefined ? (fallback || 0) : Number(n);
  }

  function formatNumber(n, decimals) {
    const d = decimals === undefined ? 1 : decimals;
    return safeNumber(n, 0).toLocaleString('en-IN', {
      minimumFractionDigits: d,
      maximumFractionDigits: d
    });
  }

  function formatCurrency(n) {
    return '₹' + safeNumber(n, 0).toLocaleString('en-IN', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    });
  }

  function genId() {
    return 'app-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str == null ? '' : str);
    return div.innerHTML;
  }

  function getCssVar(name, fallback) {
    const val = getComputedStyle(document.documentElement).getPropertyValue(name);
    return val && val.trim() ? val.trim() : fallback;
  }

  function destroyChart(chart) {
    if (chart) chart.destroy();
  }
  // ----------------------------------------------------------
  // PERSISTENCE
  // ----------------------------------------------------------
  function isValidApplianceShape(a) {
    return a && typeof a.name === 'string' &&
      typeof a.power === 'number' &&
      typeof a.quantity === 'number' &&
      typeof a.hours === 'number';
  }

  function saveData() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('NeuroVolt: could not save to localStorage.', e);
    }
  }

  function loadData() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        state.appliances = DEFAULT_APPLIANCES.map(a => Object.assign({}, a));
        state.rate = DEFAULT_RATE;
        return;
      }
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.appliances)) throw new Error('Malformed data shape');

      const cleanAppliances = parsed.appliances.filter(isValidApplianceShape).map(a => ({
        id: a.id || genId(),
        name: a.name,
        power: a.power,
        quantity: a.quantity,
        hours: a.hours
      }));

      state.appliances = cleanAppliances.length ? cleanAppliances : DEFAULT_APPLIANCES.map(a => Object.assign({}, a));
      state.rate = typeof parsed.rate === 'number' && parsed.rate > 0 ? parsed.rate : DEFAULT_RATE;
    } catch (e) {
      console.warn('NeuroVolt: saved data was corrupted, resetting to defaults.', e);
      state.appliances = DEFAULT_APPLIANCES.map(a => Object.assign({}, a));
      state.rate = DEFAULT_RATE;
    }
  }

  function clearAllData() {
    if (!window.confirm('This removes every saved appliance and resets NeuroVolt. Continue?')) return;
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    state.appliances = DEFAULT_APPLIANCES.map(a => Object.assign({}, a));
    state.rate = DEFAULT_RATE;
    renderAll();
  }

  // ----------------------------------------------------------
  // CALCULATIONS
  // ----------------------------------------------------------
  function calculateDailyEnergy(app) {
    // kWh/day = Watts × quantity × hours ÷ 1000
    return (safeNumber(app.power) * safeNumber(app.quantity) * safeNumber(app.hours)) / 1000;
  }

  function calculateMonthlyEnergy(app) {
    return calculateDailyEnergy(app) * 30;
  }

  function calculateApplianceCost(app, rate) {
    return calculateMonthlyEnergy(app) * safeNumber(rate, state.rate);
  }

  function calculateTotals() {
    const dailyTotal = state.appliances.reduce((sum, a) => sum + calculateDailyEnergy(a), 0);
    const monthlyTotal = dailyTotal * 30;
    const billTotal = monthlyTotal * state.rate;
    return { dailyTotal: dailyTotal, monthlyTotal: monthlyTotal, billTotal: billTotal };
  }

  function getHighestConsumer() {
    if (state.appliances.length === 0) return null;
    return state.appliances.reduce((max, a) =>
      calculateMonthlyEnergy(a) > calculateMonthlyEnergy(max) ? a : max, state.appliances[0]);
  }

  // ----------------------------------------------------------
  // VALIDATION
  // ----------------------------------------------------------
  function validateApplianceInput(data) {
    const errors = [];
    if (!data.name || !String(data.name).trim()) errors.push('Appliance name is required.');
    if (isNaN(data.power) || data.power < 0) errors.push('Power (W) cannot be negative.');
    if (isNaN(data.quantity) || data.quantity < 1) errors.push('Quantity must be at least 1.');
    if (isNaN(data.hours) || data.hours < 0 || data.hours > 24) errors.push('Hours/day must be between 0 and 24.');
    if (data.rate !== undefined && data.rate !== '' && !isNaN(data.rate) && data.rate <= 0) {
      errors.push('Electricity rate must be greater than 0.');
    }
    return errors;
  }

  function showFormError(message) {
    const form = document.getElementById('add-appliance-form');
    if (!form) return;
    let box = document.getElementById('neurovolt-form-error');
    if (!box) {
      box = document.createElement('p');
      box.id = 'neurovolt-form-error';
      box.style.gridColumn = '1 / -1';
      box.style.color = '#f2b84b';
      box.style.fontFamily = "'JetBrains Mono', monospace";
      box.style.fontSize = '12px';
      box.style.letterSpacing = '0.04em';
      box.style.margin = '-8px 0 0';
      const submitBtn = form.querySelector('.btn');
      if (submitBtn) form.insertBefore(box, submitBtn); else form.appendChild(box);
    }
    box.textContent = message || '';
    box.style.display = message ? 'block' : 'none';
  }

  // ----------------------------------------------------------
  // APPLIANCE CRUD
  // ----------------------------------------------------------
  function addAppliance(data) {
    const errors = validateApplianceInput(data);
    if (errors.length) {
      showFormError(errors.join(' '));
      return false;
    }
    showFormError('');

    state.appliances.push({
      id: genId(),
      name: String(data.name).trim(),
      power: Number(data.power),
      quantity: Number(data.quantity),
      hours: Number(data.hours)
    });

    if (data.rate !== undefined && data.rate !== '' && !isNaN(data.rate) && data.rate > 0) {
      state.rate = Number(data.rate);
    }

    saveData();
    renderAll();
    return true;
  }

  function removeAppliance(id) {
    state.appliances = state.appliances.filter(a => a.id !== id);
    saveData();
    renderAll();
  }

  // ----------------------------------------------------------
  // ENERGY ANALYSIS
  // ----------------------------------------------------------
  function analyzeAppliances() {
    const totals = calculateTotals();
    return state.appliances.map(app => {
      const monthly = calculateMonthlyEnergy(app);
      const share = totals.monthlyTotal > 0 ? (monthly / totals.monthlyTotal) * 100 : 0;

      let level;
      if (share >= 30) level = 'HIGH';
      else if (share >= 12) level = 'NORMAL';
      else level = 'EFFICIENT';

      // Heuristic-only "efficiency" score (not a real energy-efficiency measurement):
      // appliances that dominate the household's total draw score lower here.
      // This is meant to be swapped for a real model/API later.
      const efficiencyScore = clamp(Math.round(100 - share * 0.9), 15, 96);

      return Object.assign({}, app, { monthly: monthly, share: share, level: level, efficiencyScore: efficiencyScore });
    }).sort((a, b) => b.monthly - a.monthly);
  }

  function calculateEfficiencyScore() {
    const analysis = analyzeAppliances();
    if (analysis.length === 0) return 70;
    const avg = analysis.reduce((sum, a) => sum + a.efficiencyScore, 0) / analysis.length;
    return clamp(Math.round(avg), 0, 100);
  }

  // ----------------------------------------------------------
  // RULE-BASED RECOMMENDATIONS
  // (Not real AI — simple JS heuristics, structured so a real
  // API call could later replace generateRecommendations().)
  // This function is UNCHANGED and now also serves as the
  // guaranteed fallback whenever the AI request fails — see
  // analyzeEnergyWithAI() near the bottom of this file.
  // ----------------------------------------------------------
  function generateRecommendations() {
    const analysis = analyzeAppliances();
    const recs = [];

    analysis.forEach(app => {
      const n = app.name.toUpperCase();
      if (recs.some(r => r.target === app.name)) return; // one tip per appliance

      if ((n.includes('AC') || n.includes('AIR COND')) && app.hours >= 5) {
        recs.push({
          target: app.name,
          action: 'Reduce runtime by 1 hour/day — your AC is contributing significantly to monthly consumption.',
          potential: (app.power * app.quantity * 1 / 1000) * 30 * state.rate
        });
      } else if (n.includes('FAN') && app.hours >= 16) {
        recs.push({
          target: app.name,
          action: 'Consider using the fan only when required.',
          potential: (app.power * app.quantity * 2 / 1000) * 30 * state.rate
        });
      } else if ((n.includes('LIGHT') || n.includes('BULB') || n.includes('TUBE')) && app.hours >= 4) {
        recs.push({
          target: app.name,
          action: 'Switching to LED lighting can reduce energy consumption.',
          potential: app.monthly * 0.4 * state.rate
        });
      } else if (app.power >= 1000) {
        recs.push({
          target: app.name,
          action: 'This appliance is one of your biggest energy consumers.',
          potential: app.monthly * 0.15 * state.rate
        });
      } else if (app.level === 'HIGH') {
        recs.push({
          target: app.name,
          action: 'This appliance is one of your biggest energy consumers.',
          potential: app.monthly * 0.15 * state.rate
        });
      }
    });

    if (recs.length === 0) {
      recs.push({
        target: 'GENERAL',
        action: 'Add your appliances above to get personalized savings tips.',
        potential: 0
      });
    }

    return recs.slice(0, 3);
  }

  function estimateSavingsPotential() {
    return generateRecommendations().reduce((sum, r) => sum + (r.potential || 0), 0);
  }

  // ----------------------------------------------------------
  // SAVINGS SIMULATION
  // ----------------------------------------------------------
  function simulateChange(applianceId, newHours) {
    const app = state.appliances.find(a => a.id === applianceId);
    if (!app) return null;

    const currentMonthly = calculateMonthlyEnergy(app);
    const currentBill = currentMonthly * state.rate;

    const simulated = Object.assign({}, app, { hours: clamp(newHours, 0, 24) });
    const newMonthly = calculateMonthlyEnergy(simulated);
    const newBill = newMonthly * state.rate;

    const energySaved = currentMonthly - newMonthly;
    const moneySaved = currentBill - newBill;

    return {
      currentMonthly: currentMonthly,
      newMonthly: newMonthly,
      energySaved: energySaved,
      moneySaved: moneySaved,
      yearlyMoneySaved: moneySaved * 12,
      co2Reduced: energySaved * CO2_PER_KWH
    };
  }

  // ----------------------------------------------------------
  // RENDERING
  // ----------------------------------------------------------
  function renderApplianceTable() {
    const table = document.getElementById('appliance-list');
    if (!table) { console.warn('NeuroVolt: #appliance-list not found — appliance rows cannot render.'); return; }
    const tbody = table.querySelector('tbody');
    if (!tbody) return;

    const analysis = analyzeAppliances();

    if (analysis.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:24px; color:var(--text-mid);">No appliances added yet. Use the form below to add your first one.</td></tr>';
      return;
    }

    tbody.innerHTML = analysis.map(function (app) {
      const monthlyKwh = calculateMonthlyEnergy(app);
      const cost = calculateApplianceCost(app, state.rate);
      const pillClass = app.level === 'HIGH' ? 'pill--high' : (app.level === 'NORMAL' ? 'pill--normal' : 'pill--efficient');

      return '' +
        '<tr data-id="' + app.id + '">' +
          '<td data-label="Appliance">' + escapeHtml(app.name.toUpperCase()) + '</td>' +
          '<td data-label="Power">' + formatNumber(app.power, 0) + ' W</td>' +
          '<td data-label="Daily use">' + formatNumber(app.hours, 1) + ' h/day</td>' +
          '<td data-label="Monthly kWh">' + formatNumber(monthlyKwh, 0) + ' kWh</td>' +
          '<td data-label="Cost">' + formatCurrency(cost) + '</td>' +
          '<td data-label="Efficiency"><div class="eff-bar"><span style="width:' + app.efficiencyScore + '%"></span></div><span class="eff-num">' + app.efficiencyScore + '%</span></td>' +
          '<td data-label="Status">' +
            '<span class="pill ' + pillClass + '">' + app.level + '</span> ' +
            '<button type="button" class="neurovolt-remove-btn" data-remove-id="' + app.id + '" aria-label="Remove ' + escapeHtml(app.name) + '" title="Remove appliance" ' +
            'style="margin-left:8px;background:none;border:1px solid var(--line-strong);color:var(--text-mid);border-radius:4px;width:22px;height:22px;font-family:var(--f-mono);font-size:11px;cursor:pointer;line-height:1;">✕</button>' +
          '</td>' +
        '</tr>';
    }).join('');

    $all('.neurovolt-remove-btn', tbody).forEach(function (btn) {
      btn.addEventListener('click', function () { removeAppliance(btn.getAttribute('data-remove-id')); });
    });
  }

  function renderTelemetry() {
    const totals = calculateTotals();
    const savings = estimateSavingsPotential();

    setText('#estimated-bill .telemetry__value', formatCurrency(totals.billTotal));
    setText('#potential-savings .telemetry__value', formatCurrency(savings));

    // These specific stats are approximated from monthly totals since the markup
    // has no unique IDs for them yet — see setup notes for the IDs to add.
    setTextById('current-consumption', formatNumber(totals.dailyTotal / 24, 2) + ' kW');
    setTextById('today-consumption', formatNumber(totals.dailyTotal, 2) + ' kWh');
    setTextById('monthly-consumption-value', formatNumber(totals.monthlyTotal, 0) + ' kWh');
  }

  function setText(selector, text) {
    const el = document.querySelector(selector);
    if (el) el.textContent = text;
  }
  function setTextById(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function renderEnergyScore() {
    const orbit = document.getElementById('energy-score');
    if (!orbit) return;

    const totals = calculateTotals();
    const savings = estimateSavingsPotential();
    const score = calculateEfficiencyScore();

    setText('#energy-score .orbit__number', String(score));
    setText('#energy-score .orbit__tag--load .orbit__tag-value', formatNumber(totals.monthlyTotal, 0) + ' kWh');
    setText('#energy-score .orbit__tag--save .orbit__tag-value', formatCurrency(savings));
    setText('#energy-score .orbit__tag--status .orbit__tag-value--accent',
      score >= 70 ? 'OPTIMIZED' : (score >= 45 ? 'MODERATE' : 'NEEDS ATTENTION'));

    orbit.setAttribute('aria-label',
      'Energy efficiency score ' + score + ' out of 100, current load ' + formatNumber(totals.monthlyTotal, 0) +
      ' kilowatt hours, potential savings ' + formatCurrency(savings) + ', status ' +
      (score >= 70 ? 'optimized' : (score >= 45 ? 'moderate' : 'needs attention')));

    const ringFill = document.querySelector('.score-ring__fill');
    const ringNumber = document.querySelector('.score-ring__number');
    if (ringFill) {
      const circumference = 553; // matches the circle's stroke-dasharray already set in style.css
      ringFill.style.strokeDashoffset = String(circumference - (circumference * score / 100));
    }
    if (ringNumber) ringNumber.innerHTML = score + '<small>/100</small>';
  }

  function renderEnergyFlow() {
    const container = document.getElementById('energy-flow');
    if (!container) return;
    const nodes = container.querySelectorAll('.flow__node');
    if (!nodes.length) return;

    // Maps appliance names to the six fixed flow nodes already in the HTML,
    // in the order they appear: AC, REFRIGERATOR, FANS, LIGHTING, TV, OTHER.
    const buckets = { AC: 0, REFRIGERATOR: 0, FANS: 0, LIGHTING: 0, TV: 0, OTHER: 0 };
    state.appliances.forEach(function (a) {
      const n = a.name.toUpperCase();
      const kw = (safeNumber(a.power) * safeNumber(a.quantity)) / 1000;
      if (n.includes('AC') || n.includes('AIR COND')) buckets.AC += kw;
      else if (n.includes('FRIDGE') || n.includes('REFRIGERAT')) buckets.REFRIGERATOR += kw;
      else if (n.includes('FAN')) buckets.FANS += kw;
      else if (n.includes('LIGHT') || n.includes('BULB') || n.includes('TUBE')) buckets.LIGHTING += kw;
      else if (n.includes('TV') || n.includes('TELEVISION')) buckets.TV += kw;
      else buckets.OTHER += kw;
    });

    const order = ['AC', 'REFRIGERATOR', 'FANS', 'LIGHTING', 'TV', 'OTHER'];
    const total = order.reduce(function (s, k) { return s + buckets[k]; }, 0) || 1;

    nodes.forEach(function (node, i) {
      const key = order[i];
      if (!key) return;
      const kw = buckets[key];
      const pct = Math.round((kw / total) * 100);
      const powerEl = node.querySelector('.flow__node-power');
      const barEl = node.querySelector('.flow__node-bar span');
      const pctEl = node.querySelector('.flow__node-pct');
      if (powerEl) powerEl.textContent = formatNumber(kw, 2) + ' kW';
      if (barEl) barEl.style.width = pct + '%';
      if (pctEl) pctEl.textContent = pct + '%';
    });
  }

  function renderRecommendations() {
    const panel = document.getElementById('ai-insights-panel');
    if (!panel) { console.warn('NeuroVolt: #ai-insights-panel not found — recommendations cannot render.'); return; }
    const list = panel.querySelector('.ai-core__list');
    const headline = panel.querySelector('.ai-core__headline');
    if (!list) { console.warn('NeuroVolt: .ai-core__list not found inside #ai-insights-panel.'); return; }

    const recs = generateRecommendations();
    const realRecs = recs.filter(function (r) { return r.potential > 0; });

    if (headline) {
      headline.textContent = realRecs.length
        ? 'WE FOUND ' + realRecs.length + ' SAVING OPPORTUNIT' + (realRecs.length === 1 ? 'Y' : 'IES') + '.'
        : 'ADD APPLIANCES TO SEE SAVING OPPORTUNITIES.';
    }

    list.innerHTML = recs.map(function (r, i) {
      return '' +
        '<li class="ai-core__item">' +
          '<span class="ai-core__index">' + String(i + 1).padStart(2, '0') + '</span>' +
          '<div class="ai-core__content">' +
            '<span class="ai-core__target">' + escapeHtml(r.target.toUpperCase()) + '</span>' +
            '<span class="ai-core__action">' + escapeHtml(r.action) + '</span>' +
          '</div>' +
          '<div class="ai-core__potential">' +
            '<span class="ai-core__potential-label">POTENTIAL</span>' +
            '<span class="ai-core__potential-value">' + (r.potential > 0 ? formatCurrency(r.potential) : '—') + ' <small>/ MONTH</small></span>' +
          '</div>' +
        '</li>';
    }).join('');
  }

  function renderSimulator() {
    const select = document.getElementById('sim-appliance');
    if (!select) { console.warn('NeuroVolt: #sim-appliance not found — simulator disabled.'); return; }

    const previousValue = select.value;
    select.innerHTML = state.appliances.length
      ? state.appliances.map(function (a) { return '<option value="' + a.id + '">' + escapeHtml(a.name.toUpperCase()) + '</option>'; }).join('')
      : '<option value="">NO APPLIANCES ADDED</option>';

    if (state.appliances.some(function (a) { return a.id === previousValue; })) {
      select.value = previousValue;
    }

    updateSimulatorDisplay();
  }

  function updateSimulatorDisplay() {
    const select = document.getElementById('sim-appliance');
    const container = document.getElementById('simulator');
    if (!select || !container || !select.value) return;

    const app = state.appliances.find(function (a) { return a.id === select.value; });
    if (!app) return;

    // index.html currently has no input for the target hours value, so this
    // defaults to "2 hours less than current use" as a demo reduction.
    // Add <input type="number" id="sim-target-hours"> to let users set this themselves.
    const targetInput = document.getElementById('sim-target-hours');
    const targetHours = targetInput ? safeNumber(targetInput.value, app.hours) : clamp(app.hours - 2, 0, 24);

    const currentStat = container.querySelector('.simulator__stat-value');
    const targetStat = container.querySelector('.simulator__stat-value--accent');
    const arrow = container.querySelector('.simulator__arrow');
    if (currentStat) currentStat.innerHTML = formatNumber(app.hours, 1) + ' <small>HOURS / DAY</small>';
    if (targetStat) targetStat.innerHTML = formatNumber(targetHours, 1) + ' <small>HOURS / DAY</small>';
    if (arrow) arrow.innerHTML = formatNumber(app.hours, 1) + 'H <span>→</span> ' + formatNumber(targetHours, 1) + 'H';

    const result = simulateChange(app.id, targetHours);
    if (!result) return;

    // Order in the existing markup: CURRENT, NEW, ENERGY SAVED, MONEY SAVED, CO2 REDUCED
    const resultEls = container.querySelectorAll('.simulator__result-value');
    if (resultEls[0]) resultEls[0].innerHTML = formatNumber(result.currentMonthly, 0) + ' <small>kWh</small>';
    if (resultEls[1]) resultEls[1].innerHTML = formatNumber(result.newMonthly, 0) + ' <small>kWh</small>';
    if (resultEls[2]) resultEls[2].innerHTML = formatNumber(result.energySaved, 0) + ' <small>kWh</small>';
    if (resultEls[3]) resultEls[3].textContent = formatCurrency(result.moneySaved);
    if (resultEls[4]) resultEls[4].innerHTML = '~' + formatNumber(result.co2Reduced, 0) + ' <small>kg</small>';
  }

  function renderSustainability() {
    const section = document.getElementById('sustainability-index');
    if (!section) return;

    const totals = calculateTotals();
    const score = calculateEfficiencyScore();
    const savings = estimateSavingsPotential();
    const co2Monthly = totals.monthlyTotal * CO2_PER_KWH;
    const energySavedKwh = state.rate > 0 ? savings / state.rate : 0;

    const stats = section.querySelectorAll('.sustain-stat__value');
    if (stats[0]) stats[0].innerHTML = formatNumber(co2Monthly, 0) + ' <small>kg</small>';
    if (stats[1]) stats[1].innerHTML = formatNumber(energySavedKwh, 0) + ' <small>kWh</small>';
    if (stats[2]) stats[2].textContent = clamp(Math.round((score / 100) * 20), 0, 25) + '%';

    const meter = section.querySelector('.sustain-meter__fill');
    if (meter) meter.style.width = score + '%';
    const meterWrap = section.querySelector('.sustain-meter');
    if (meterWrap) meterWrap.setAttribute('aria-label', 'Sustainability meter at ' + score + ' percent');
  }
  
    function renderDashboardSummary() {
    const highest = getHighestConsumer();
    setTextById('total-appliances-value', String(state.appliances.length));

    if (highest) {
      const monthlyKwh = calculateMonthlyEnergy(highest);
      setTextById('highest-consumer-value', highest.name.toUpperCase() + ' — ' + formatNumber(monthlyKwh, 0) + ' kWh');
    } else {
      setTextById('highest-consumer-value', '—');
    }
  }

  function renderBillPrediction() {
    const panel = document.querySelector('.bill-panel');
    if (!panel) return;
    const stats = panel.querySelectorAll('.bill-stat__value');
    if (!stats.length) return;

    const totals = calculateTotals();
    // Demo trend consistent with the static "+9.4%" originally shown in the design.
    const predicted = totals.billTotal * 1.094;
    const trendPct = totals.billTotal > 0 ? ((predicted - totals.billTotal) / totals.billTotal) * 100 : 0;

    if (stats[0]) stats[0].textContent = formatCurrency(totals.billTotal);
    if (stats[1]) stats[1].textContent = formatCurrency(predicted);
    if (stats[2]) stats[2].textContent = '+' + trendPct.toFixed(1) + '%';
  }

  // Charts: index.html does not currently include Chart.js or any <canvas> elements,
  // so no chart is drawn. This hook is ready to use once both exist — see setup notes.
    function renderApplianceChart(analysis) {
    const canvas = document.getElementById('appliance-chart');
    const emptyEl = document.getElementById('appliance-chart-empty');
    if (!canvas || typeof window.Chart === 'undefined') return;

    if (!analysis.length) {
      destroyChart(applianceChart);
      applianceChart = null;
      canvas.hidden = true;
      if (emptyEl) emptyEl.hidden = false;
      return;
    }

    canvas.hidden = false;
    if (emptyEl) emptyEl.hidden = true;

    const totalMonthly = analysis.reduce(function (s, a) { return s + a.monthly; }, 0) || 1;
    const palette = [
      getCssVar('--lime', '#b6ff3c'),
      getCssVar('--cyan', '#4fd6d6'),
      getCssVar('--violet', '#9a86ff'),
      getCssVar('--amber', '#f2b84b'),
      getCssVar('--lime-dim', '#7fbf2a'),
      getCssVar('--text-mid', '#9aa79a')
    ];

    const labels = analysis.map(function (a) { return a.name.toUpperCase(); });
    const values = analysis.map(function (a) { return a.monthly; });
    const colors = analysis.map(function (a, i) { return palette[i % palette.length]; });

    destroyChart(applianceChart);
    applianceChart = new window.Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [{
          data: values,
          backgroundColor: colors,
          borderColor: getCssVar('--bg-panel', '#101310'),
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '68%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: getCssVar('--text-mid', '#9aa79a'),
              font: { family: "'JetBrains Mono', monospace", size: 11 },
              boxWidth: 10,
              padding: 14
            }
          },
          tooltip: {
            backgroundColor: getCssVar('--bg-panel-2', '#14170f'),
            titleColor: getCssVar('--text-hi', '#eef2ea'),
            bodyColor: getCssVar('--text-mid', '#9aa79a'),
            borderColor: getCssVar('--line-strong', 'rgba(200,255,200,0.2)'),
            borderWidth: 1,
            titleFont: { family: "'JetBrains Mono', monospace" },
            bodyFont: { family: "'JetBrains Mono', monospace" },
            callbacks: {
              label: function (ctx) {
                const val = ctx.parsed;
                const pct = ((val / totalMonthly) * 100).toFixed(1);
                return ctx.label + ': ' + formatNumber(val, 0) + ' kWh (' + pct + '%)';
              }
            }
          }
        }
      }
    });
  }

  function renderEnergyComparisonChart(totals) {
    const canvas = document.getElementById('energy-comparison-chart');
    if (!canvas || typeof window.Chart === 'undefined') return;

    destroyChart(energyComparisonChart);
    energyComparisonChart = new window.Chart(canvas, {
      type: 'bar',
      data: {
        labels: ['DAILY', 'MONTHLY'],
        datasets: [{
          label: 'ENERGY (kWh)',
          data: [totals.dailyTotal, totals.monthlyTotal],
          backgroundColor: [getCssVar('--cyan', '#4fd6d6'), getCssVar('--lime', '#b6ff3c')],
          borderRadius: 4,
          maxBarThickness: 64
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: getCssVar('--bg-panel-2', '#14170f'),
            titleColor: getCssVar('--text-hi', '#eef2ea'),
            bodyColor: getCssVar('--text-mid', '#9aa79a'),
            borderColor: getCssVar('--line-strong', 'rgba(200,255,200,0.2)'),
            borderWidth: 1,
            callbacks: {
              label: function (ctx) { return formatNumber(ctx.parsed.y, 1) + ' kWh'; }
            }
          }
        },
        scales: {
          x: {
            ticks: { color: getCssVar('--text-mid', '#9aa79a'), font: { family: "'JetBrains Mono', monospace", size: 11 } },
            grid: { color: getCssVar('--line', 'rgba(200,255,200,0.1)') }
          },
          y: {
            beginAtZero: true,
            ticks: { color: getCssVar('--text-mid', '#9aa79a'), font: { family: "'JetBrains Mono', monospace", size: 10 } },
            grid: { color: getCssVar('--line', 'rgba(200,255,200,0.1)') }
          }
        }
      }
    });
  }

  // Charts: reuses analyzeAppliances()/calculateTotals() from the existing
  // engine, destroys prior instances before redrawing (see #9), and
  // no-ops safely if Chart.js hasn't loaded.
  function renderCharts() {
    if (typeof window.Chart === 'undefined') return;
    renderApplianceChart(analyzeAppliances());
    renderEnergyComparisonChart(calculateTotals());
  }

    function renderAll() {
    try {
      renderApplianceTable();
      renderTelemetry();
      renderDashboardSummary();
      renderEnergyScore();
      renderEnergyFlow();
      renderRecommendations(); // rule-based view on first load; analyzeEnergyWithAI() below repopulates the same panel on demand
      renderSimulator();
      renderSustainability();
      renderBillPrediction();
      renderCharts();
    } catch (e) {
      console.error('NeuroVolt: render error', e);
    }
  }

  // ----------------------------------------------------------
  // AI ENERGY ANALYSIS — wiring for the existing
  // "OPTIMIZE MY ENERGY" button inside #ai-insights-panel.
  //
  // Everything above this block is unchanged. This section only
  // ADDS behavior to a button that previously did nothing; it does
  // not touch appliance CRUD, calculations, charts, simulator,
  // localStorage, telemetry, energy score, bill prediction, or
  // sustainability rendering.
  // ----------------------------------------------------------
  const AI_ENDPOINT = '/api/analyze';

  // Builds the payload from the SAME calculation functions used everywhere
  // else on the page — no duplicated math, no invented numbers.
  function buildAIPayload() {
    const analysis = analyzeAppliances();
    const totals = calculateTotals();
    return {
      rate: state.rate,
      appliances: analysis.map(function (a) {
        return {
          name: a.name,
          power_w: a.power,
          quantity: a.quantity,
          hours_per_day: a.hours,
          daily_kwh: calculateDailyEnergy(a),
          monthly_kwh: a.monthly,
          share_pct: Math.round(a.share * 10) / 10
        };
      }),
      totals: {
        daily_kwh: totals.dailyTotal,
        monthly_kwh: totals.monthlyTotal,
        estimated_monthly_bill: totals.billTotal
      }
    };
  }

  async function sendEnergyData(payload) {
    const controller = new AbortController();
    const timeout = setTimeout(function () { controller.abort(); }, 15000);
    try {
      const res = await fetch(AI_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!res.ok) {
        const errBody = await res.json().catch(function () { return {}; });
        throw new Error(errBody.error || ('Server responded with ' + res.status));
      }
      return await res.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  // Never trusts numbers coming from the AI. Only "appliance" and
  // "recommendation" text are required; any savings figure is recomputed
  // here from the real appliance data (same formula as simulateChange()),
  // using the AI's "suggested_hours_reduction" purely as a suggestion.
  function validateAIResponse(data) {
    if (!data || typeof data !== 'object') return false;
    if (!Array.isArray(data.recommendations) || data.recommendations.length === 0) return false;

    const cleaned = data.recommendations
      .filter(function (r) { return r && typeof r.recommendation === 'string' && r.recommendation.trim(); })
      .slice(0, 3)
      .map(function (r) {
        const applianceName = String(r.appliance || 'General').trim();
        const match = state.appliances.find(function (a) {
          return a.name.toLowerCase() === applianceName.toLowerCase();
        });

        // Observation is computed from real data, never taken from the AI —
        // this is the "problem" line and it's always grounded in actual usage.
        let observation = 'No matching appliance data on record.';
        if (match) {
          const analysis = analyzeAppliances().find(function (a) { return a.id === match.id; });
          if (analysis) {
            observation = analysis.name + ' uses ' + formatNumber(analysis.monthly, 0) +
              ' kWh/month (' + Math.round(analysis.share) + '% of your total consumption).';
          }
        }

        let energySavedKwh = 0;
        let moneySavedMonthly = 0;
        const reduction = Number(r.suggested_hours_reduction);
        if (match && !isNaN(reduction) && reduction > 0) {
          const safeReduction = clamp(reduction, 0, match.hours);
          energySavedKwh = (match.power * match.quantity * safeReduction / 1000) * 30;
          moneySavedMonthly = energySavedKwh * state.rate;
        }

        return {
          appliance: applianceName,
          observation: observation,
          recommendation: r.recommendation.trim(),
          reason: typeof r.reason === 'string' ? r.reason.trim() : '',
          money_saved_monthly: Math.round(moneySavedMonthly)
        };
      });

    return cleaned.length ? cleaned : false;
  }

  function showAILoading(btn) {
    if (!btn) return;
    btn.disabled = true;
    btn.dataset.originalHtml = btn.dataset.originalHtml || btn.innerHTML;
    btn.textContent = 'ANALYZING...';
  }

  function showAIDone(btn) {
    if (!btn) return;
    btn.disabled = false;
    if (btn.dataset.originalHtml) btn.innerHTML = btn.dataset.originalHtml;
  }

  function showAIError(btn, message) {
    if (btn) {
      btn.disabled = false;
      if (btn.dataset.originalHtml) btn.innerHTML = btn.dataset.originalHtml;
    }
    console.warn('NeuroVolt AI: ' + (message || 'unknown error') + ' — falling back to rule-based recommendations.');
  }

  // Renders AI recommendations into the EXISTING #ai-insights-panel markup —
  // same .ai-core__list / .ai-core__item / .ai-core__content classes as
  // renderRecommendations(), just with observation + recommendation + reason
  // as separate lines and a real, backend-verified savings figure.
  function renderAIAnalysis(recommendations) {
    const panel = document.getElementById('ai-insights-panel');
    if (!panel) return;
    const list = panel.querySelector('.ai-core__list');
    const headline = panel.querySelector('.ai-core__headline');
    if (!list) return;

    if (headline) {
      headline.textContent = 'AI FOUND ' + recommendations.length +
        ' SAVING OPPORTUNIT' + (recommendations.length === 1 ? 'Y' : 'IES') + '.';
    }

    list.innerHTML = recommendations.map(function (r, i) {
      return '' +
        '<li class="ai-core__item">' +
          '<span class="ai-core__index">' + String(i + 1).padStart(2, '0') + '</span>' +
          '<div class="ai-core__content">' +
            '<span class="ai-core__target">' + escapeHtml(r.appliance.toUpperCase()) + '</span>' +
            '<span class="ai-core__action">' + escapeHtml(r.observation) + '</span>' +
            '<span class="ai-core__action">' + escapeHtml(r.recommendation) + '</span>' +
            (r.reason ? '<span class="ai-core__action">' + escapeHtml(r.reason) + '</span>' : '') +
          '</div>' +
          '<div class="ai-core__potential">' +
            '<span class="ai-core__potential-label">POTENTIAL</span>' +
            '<span class="ai-core__potential-value">' + (r.money_saved_monthly > 0 ? formatCurrency(r.money_saved_monthly) : '—') + ' <small>/ MONTH</small></span>' +
          '</div>' +
        '</li>';
    }).join('');
  }

  // Orchestrates the full click flow: loading state → real payload →
  // backend call → validate → render, or fall back to the existing
  // rule-based generateRecommendations() via renderRecommendations()
  // on ANY failure (bad network, bad response, timeout, invalid JSON).
  async function analyzeEnergyWithAI(btn) {
    if (state.appliances.length === 0) {
      renderRecommendations();
      return;
    }

    showAILoading(btn);
    try {
      const payload = buildAIPayload();
      const raw = await sendEnergyData(payload);
      const validated = validateAIResponse(raw);
      if (!validated) throw new Error('AI response failed validation');

      renderAIAnalysis(validated);
      showAIDone(btn);
    } catch (err) {
      renderRecommendations(); // guaranteed fallback — panel is never left broken or empty
      showAIError(btn, err && err.message);
    }
  }

  function wireAIAnalyzeButton() {
    const panel = document.getElementById('ai-insights-panel');
    if (!panel) { console.warn('NeuroVolt: #ai-insights-panel not found — AI button cannot be wired.'); return; }
    // Existing markup has no id on this button, so it's selected by its
    // existing classes within the panel — no HTML changes required.
    const btn = panel.querySelector('.btn');
    if (!btn) { console.warn('NeuroVolt: OPTIMIZE MY ENERGY button not found inside #ai-insights-panel.'); return; }

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      analyzeEnergyWithAI(btn);
    });
  }

  // ----------------------------------------------------------
  // EVENT WIRING
  // ----------------------------------------------------------
  function wireAddApplianceForm() {
    const form = document.getElementById('add-appliance-form');
    if (!form) { console.warn('NeuroVolt: #add-appliance-form not found — cannot add appliances.'); return; }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      const nameEl = document.getElementById('f-appliance');
      const powerEl = document.getElementById('f-power');
      const qtyEl = document.getElementById('f-qty');
      const hoursEl = document.getElementById('f-hours');
      const rateEl = document.getElementById('f-rate');

      const added = addAppliance({
        name: nameEl ? nameEl.value : '',
        power: powerEl ? parseFloat(powerEl.value) : NaN,
        quantity: qtyEl ? parseFloat(qtyEl.value) : NaN,
        hours: hoursEl ? parseFloat(hoursEl.value) : NaN,
        rate: rateEl ? parseFloat(rateEl.value) : undefined
      });

      if (added) form.reset();
    });
  }

  function wireSimulator() {
    const select = document.getElementById('sim-appliance');
    if (select) select.addEventListener('change', updateSimulatorDisplay);

    const targetInput = document.getElementById('sim-target-hours');
    if (targetInput) targetInput.addEventListener('input', updateSimulatorDisplay);

    const simButton = document.querySelector('#simulator .btn');
    if (simButton) simButton.addEventListener('click', function (e) {
      e.preventDefault();
      updateSimulatorDisplay();
    });
  }

  function wireClearData() {
    const btn = document.getElementById('clear-data-btn');
    if (!btn) return; // optional — see setup notes to add this button
    btn.addEventListener('click', clearAllData);
  }

  // ----------------------------------------------------------
  // INIT
  // ----------------------------------------------------------
  function init() {
    loadData();
    renderAll();
    wireAddApplianceForm();
    wireSimulator();
    wireClearData();
    wireAIAnalyzeButton();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
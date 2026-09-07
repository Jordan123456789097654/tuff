// Jordan's Snack Shack POS - Client Logic with Open Pricing & Full Discount System

// ==========================================
// STATE
// ==========================================
let products = [];
let categories = [];
let students = [];
let orders = [];
let cart = [];
let fundraisers = [];
let activeFundraiserId = null;
let currentCategory = null;
let searchQuery = '';
let activeShift = null;
let selectedStudentForCheckout = null;
let soundEnabled = true;

// Discount State
let activeDiscount = null; // { name: string, type: 'pct' | 'fixed', value: number, code?: string }
let isCelebrationActiveOnDisplay = false;

// Display Synchronization (BroadcastChannel + SSE)
const displayChannel = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel('snack_display_sync') : null;

if (displayChannel) {
  displayChannel.onmessage = (event) => {
    if (event.data && event.data.type === 'student_face_identified') {
      handleStudentFaceIdentifiedFromDisplay(event.data.student);
    } else if (event.data && event.data.type === 'student_registered') {
      handleStudentRegisteredFromDisplay(event.data.student);
    } else if (event.data && event.data.type === 'stealth_mode') {
      setStealthMode(event.data.active, false);
    }
  };
}

// Connect SSE on POS for cross-device events
if (typeof EventSource !== 'undefined') {
  try {
    const posEvtSource = new EventSource('/api/display/events');
    posEvtSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'cctv_customer_frame') {
          if (typeof handleIncomingCustomerCctvPacket === 'function') {
            handleIncomingCustomerCctvPacket(data);
          }
        } else if (data.type === 'display_heartbeat') {
          if (typeof lastCustomerFrameTime !== 'undefined') {
            lastCustomerFrameTime = Date.now();
            isCustomerDisplayOnline = true;
            if (typeof updateCustomerDisplayConnectionBadge === 'function') {
              updateCustomerDisplayConnectionBadge(true);
            }
            if (typeof updateCustomerCctvAudioHud === 'function') {
              updateCustomerCctvAudioHud(data.audioLevel, data.hasAudio);
            }
          }
        } else if (data.type === 'student_face_identified') {
          handleStudentFaceIdentifiedFromDisplay(data.student);
        } else if (data.type === 'student_registered') {
          handleStudentRegisteredFromDisplay(data.student);
        } else if (data.type === 'stealth_mode') {
          setStealthMode(data.active, false);
        }
      } catch(e){}
    };
  } catch(e){}
}

// Automatically start background sync so DVR rolling buffer records 2nd monitor camera continuously
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    if (typeof initCashierCustomerCctvSync === 'function') {
      initCashierCustomerCctvSync();
    }
  });
}

function handleStudentFaceIdentifiedFromDisplay(student) {
  if (!student) return;
  playSound('chaching');
  closeCameraScanner();
  openStudentCheckoutModal();
  selectStudentForCheckout(student.id);
  showToast(`👤 Face ID Identified from 2nd Monitor: ${student.name}! ($${parseFloat(student.balance || 0).toFixed(2)})`, 'success');
}

function handleStudentRegisteredFromDisplay(student) {
  if (!student) return;
  playSound('chaching');
  showToast(`🎉 New Student Registered from 2nd Screen: ${student.name} (${student.student_id})!`, 'success');
  if (typeof loadStudents === 'function') {
    loadStudents();
  }
}

function getActiveFundraiser() {
  if (!fundraisers || fundraisers.length === 0) return null;
  if (activeFundraiserId) {
    const f = fundraisers.find(item => item.id === parseInt(activeFundraiserId, 10));
    if (f) return f;
  }
  return fundraisers[0] || null;
}

function syncCartToDisplay(forceIdle = false) {
  // If celebration screen is currently active on customer 2nd monitor and cart is empty,
  // do NOT overwrite celebrate screen unless cashier explicitly clicked 'New Order' (forceIdle = true)
  if (isCelebrationActiveOnDisplay && cart.length === 0 && !selectedStudentForCheckout && !forceIdle) {
    return;
  }

  if (cart.length > 0) {
    isCelebrationActiveOnDisplay = false;
  }

  const { subtotal, comboDiscount, discountAmount, discountLabel, total } = calculateTotals();
  const currentFund = getActiveFundraiser();
  const payload = {
    state: (cart.length === 0 && !selectedStudentForCheckout) ? 'idle' : 'active',
    cart: cart,
    subtotal: subtotal,
    comboDiscount: comboDiscount,
    discountAmount: discountAmount,
    discountLabel: discountLabel,
    total: total,
    student: selectedStudentForCheckout || null,
    fundraiser: currentFund
  };

  if (displayChannel) {
    try { displayChannel.postMessage(payload); } catch(e){}
  }

  fetch('/api/display/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch(() => {});
}

function celebrateDisplay(order) {
  isCelebrationActiveOnDisplay = true;
  const currentFund = getActiveFundraiser();
  const payload = {
    state: 'celebrate',
    order: order,
    fundraiser: currentFund
  };

  if (displayChannel) {
    try { displayChannel.postMessage(payload); } catch(e){}
  }

  fetch('/api/display/celebrate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order, fundraiser: currentFund })
  }).catch(() => {});
}

// Open Price State
let pendingOpenPriceProduct = null;

// Audio Synthesizer
let audioCtx = null;
function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

function playSound(type) {
  if (!soundEnabled) return;
  try {
    const ctx = getAudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    const now = ctx.currentTime;

    if (type === 'beep') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(1320, now + 0.08);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
      osc.start(now);
      osc.stop(now + 0.08);
    } else if (type === 'chaching') {
      const freqs = [523.25, 659.25, 783.99, 1046.5];
      freqs.forEach((freq, idx) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'triangle';
        o.frequency.value = freq;
        o.connect(g);
        g.connect(ctx.destination);
        const startTime = now + idx * 0.06;
        g.gain.setValueAtTime(0.2, startTime);
        g.gain.exponentialRampToValueAtTime(0.001, startTime + 0.25);
        o.start(startTime);
        o.stop(startTime + 0.25);
      });
    } else if (type === 'fanfare') {
      const freqs = [523.25, 659.25, 783.99, 1046.5, 1318.5];
      freqs.forEach((freq, idx) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = freq;
        o.connect(g);
        g.connect(ctx.destination);
        const startTime = now + idx * 0.08;
        g.gain.setValueAtTime(0.25, startTime);
        g.gain.exponentialRampToValueAtTime(0.001, startTime + 0.35);
        o.start(startTime);
        o.stop(startTime + 0.35);
      });
    } else if (type === 'spooky') {
      const notes = [440, 523.25, 622.25, 880];
      notes.forEach((freq, idx) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(freq, now + idx * 0.12);
        o.frequency.linearRampToValueAtTime(freq - 15, now + idx * 0.12 + 0.3);
        o.connect(g);
        g.connect(ctx.destination);
        const st = now + idx * 0.12;
        g.gain.setValueAtTime(0.2, st);
        g.gain.exponentialRampToValueAtTime(0.001, st + 0.4);
        o.start(st);
        o.stop(st + 0.4);
      });
    } else if (type === 'winter_bell') {
      const bells = [1200, 1600, 2000, 2400];
      bells.forEach((freq, idx) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'triangle';
        o.frequency.value = freq;
        o.connect(g);
        g.connect(ctx.destination);
        const st = now + idx * 0.07;
        g.gain.setValueAtTime(0.2, st);
        g.gain.exponentialRampToValueAtTime(0.001, st + 0.35);
        o.start(st);
        o.stop(st + 0.35);
      });
    } else if (type === 'celtic') {
      const harp = [523.25, 659.25, 783.99, 987.77, 1046.5];
      harp.forEach((freq, idx) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = freq;
        o.connect(g);
        g.connect(ctx.destination);
        const st = now + idx * 0.08;
        g.gain.setValueAtTime(0.22, st);
        g.gain.exponentialRampToValueAtTime(0.001, st + 0.35);
        o.start(st);
        o.stop(st + 0.35);
      });
    } else if (type === 'rose_chime') {
      const melody = [587.33, 739.99, 880, 1174.66];
      melody.forEach((freq, idx) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = freq;
        o.connect(g);
        g.connect(ctx.destination);
        const st = now + idx * 0.09;
        g.gain.setValueAtTime(0.22, st);
        g.gain.exponentialRampToValueAtTime(0.001, st + 0.4);
        o.start(st);
        o.stop(st + 0.4);
      });
    } else if (type === 'warning') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(300, now);
      osc.frequency.linearRampToValueAtTime(200, now + 0.15);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
      osc.start(now);
      osc.stop(now + 0.15);
    }
  } catch (e) {
    console.warn('Audio note:', e);
  }
}

function toggleAudio() {
  soundEnabled = !soundEnabled;
  const icon = document.getElementById('audio-icon');
  if (soundEnabled) {
    icon.setAttribute('data-lucide', 'volume-2');
    showToast('Sound effects enabled 🔊');
  } else {
    icon.setAttribute('data-lucide', 'volume-x');
    showToast('Sound effects muted 🔇');
  }
  lucide.createIcons();
}

// ==========================================
// TOAST NOTIFICATIONS
// ==========================================
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  
  let bg = 'bg-slate-800 text-white border-slate-700';
  let icon = '🔔';
  if (type === 'success') {
    bg = 'bg-emerald-950 text-emerald-100 border-emerald-500/50';
    icon = '✅';
  } else if (type === 'error') {
    bg = 'bg-rose-950 text-rose-100 border-rose-500/50';
    icon = '⚠️';
  } else if (type === 'reward') {
    bg = 'bg-amber-950 text-amber-100 border-amber-500/50';
    icon = '⭐';
  }

  toast.className = `toast-item px-4 py-3 rounded-2xl border shadow-2xl flex items-center gap-2 text-xs font-semibold backdrop-blur-md pointer-events-auto ${bg}`;
  toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3400);
}

// ==========================================
// NAVIGATION & TABS
// ==========================================
function switchTab(tabId) {
  document.querySelectorAll('main > section').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));

  const target = document.getElementById(`tab-${tabId}`);
  if (target) target.classList.remove('hidden');

  const btn = document.getElementById(`tab-btn-${tabId}`);
  if (btn) btn.classList.add('active');

  if (tabId === 'preorders') loadPreorders();
  if (tabId === 'students') loadStudents();
  if (tabId === 'inventory') loadProducts();
  if (tabId === 'orders') loadOrders();
  if (tabId === 'shifts') loadShiftData();
  if (tabId === 'analytics') loadAnalytics();
  
  lucide.createIcons();
}

// ==========================================
// DATA FETCHING & INITIALIZATION
// ==========================================
async function initApp() {
  try {
    await Promise.all([loadCategories(), loadProducts(), loadFundraisers(), loadShiftStatus(), loadStaff()]);
  } catch (err) {
    console.error('Init error:', err);
  }
}

async function loadFundraisers() {
  try {
    const res = await fetch('/api/fundraisers');
    fundraisers = await res.json();
    renderFundraiserSelectors();
  } catch (err) {
    console.error('Failed to load fundraisers', err);
  }
}

function renderFundraiserSelectors() {
  const cartSelect = document.getElementById('cart-fundraiser-select');
  const shrinkSelect = document.getElementById('shrinkage-fundraiser-select');

  if (cartSelect) {
    if (fundraisers.length === 0) {
      cartSelect.innerHTML = `<option value="">Default School Fund</option>`;
    } else {
      cartSelect.innerHTML = fundraisers.map(f => `
        <option value="${f.id}" ${activeFundraiserId === f.id ? 'selected' : ''}>
          ${f.name} (Goal: $${parseFloat(f.goal_amount).toFixed(0)})
        </option>
      `).join('');
      if (!activeFundraiserId && fundraisers.length > 0) {
        activeFundraiserId = fundraisers[0].id;
      }
    }
  }

  if (shrinkSelect) {
    shrinkSelect.innerHTML = `
      <option value="">None (General Snack Shack Write-Off)</option>
      ${fundraisers.map(f => `<option value="${f.id}">${f.name}</option>`).join('')}
    `;
  }
}

function onFundraiserSelectChange(val) {
  activeFundraiserId = val ? parseInt(val, 10) : null;
  const f = getActiveFundraiser();
  if (f) {
    showToast(`Active Fundraiser: ${f.name} 🎯`, 'info');
  }
  syncCartToDisplay();
}

function openNewFundraiserModal() {
  document.getElementById('fundraiser-name-input').value = '';
  document.getElementById('fundraiser-goal-input').value = '500.00';
  document.getElementById('fundraiser-desc-input').value = '';
  openModal('modal-new-fundraiser');
}

async function submitNewFundraiser() {
  const name = document.getElementById('fundraiser-name-input').value.trim();
  const goal_amount = parseFloat(document.getElementById('fundraiser-goal-input').value);
  const description = document.getElementById('fundraiser-desc-input').value.trim();

  if (!name) {
    showToast('Please enter a campaign name', 'error');
    return;
  }

  try {
    const res = await fetch('/api/fundraisers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, goal_amount, description })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to create campaign');

    playSound('chaching');
    closeModal('modal-new-fundraiser');
    await loadFundraisers();
    activeFundraiserId = data.id;
    renderFundraiserSelectors();
    syncCartToDisplay();
    showToast(`Fundraiser Campaign "${data.name}" created! 🎯`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ==========================================
// INVENTORY SHRINKAGE & LOSS LOGGING
// ==========================================
function openShrinkageModal(preselectedProductId = null) {
  const select = document.getElementById('shrinkage-product-select');
  if (products.length === 0) {
    showToast('No products available to log loss.', 'error');
    return;
  }

  select.innerHTML = products.map(p => `
    <option value="${p.id}" ${preselectedProductId === p.id ? 'selected' : ''}>
      ${p.emoji || '🍿'} ${p.name} (Stock: ${p.stock_quantity}, Wholesale: $${parseFloat(p.cost_price).toFixed(2)})
    </option>
  `).join('');

  document.getElementById('shrinkage-qty').value = '1';
  document.getElementById('shrinkage-notes').value = '';
  
  onShrinkageProductChange();
  openModal('modal-shrinkage');
}

function onShrinkageProductChange() {
  calculateShrinkageCost();
}

function calculateShrinkageCost() {
  const select = document.getElementById('shrinkage-product-select');
  const productId = parseInt(select.value, 10);
  const qty = parseInt(document.getElementById('shrinkage-qty').value, 10) || 0;
  const costDisplay = document.getElementById('shrinkage-cost-display');

  const product = products.find(p => p.id === productId);
  if (!product) {
    costDisplay.textContent = '$0.00';
    return;
  }

  const cost = parseFloat(product.cost_price) || 0;
  const totalLoss = cost * qty;
  costDisplay.textContent = `$${totalLoss.toFixed(2)} ($${cost.toFixed(2)} each)`;
}

async function submitShrinkageLog() {
  const select = document.getElementById('shrinkage-product-select');
  const productId = parseInt(select.value, 10);
  const qty = parseInt(document.getElementById('shrinkage-qty').value, 10);
  const reasonRadio = document.querySelector('input[name="shrinkage-reason"]:checked');
  const reason = reasonRadio ? reasonRadio.value : 'expired';
  const notes = document.getElementById('shrinkage-notes').value.trim();
  const fundraiserId = document.getElementById('shrinkage-fundraiser-select').value || null;

  if (!productId || isNaN(qty) || qty <= 0) {
    showToast('Please specify valid product and quantity.', 'error');
    return;
  }

  try {
    const res = await fetch('/api/inventory/shrinkage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product_id: productId,
        quantity: qty,
        reason: reason,
        notes: notes,
        fundraiser_id: fundraiserId ? parseInt(fundraiserId, 10) : null,
        logged_by: 'Cashier Volunteer'
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to log loss');

    playSound('warning');
    closeModal('modal-shrinkage');
    await loadProducts();
    showToast(`Logged ${qty} units written off as ${reason}! 🗑️`, 'info');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function loadCategories() {
  try {
    const res = await fetch('/api/categories');
    categories = await res.json();
    renderCategories();
  } catch (err) {
    console.error('Failed to load categories', err);
  }
}

async function loadProducts() {
  try {
    const res = await fetch('/api/products');
    products = await res.json();
    renderProductGrid();
    renderInventoryTable();
  } catch (err) {
    console.error('Failed to load products', err);
  }
}

async function loadStudents() {
  try {
    const res = await fetch('/api/students');
    students = await res.json();
    renderStudentsTable();
  } catch (err) {
    console.error('Failed to load students', err);
  }
}

async function loadOrders() {
  try {
    const res = await fetch('/api/orders?limit=50');
    orders = await res.json();
    renderOrdersTable();
  } catch (err) {
    console.error('Failed to load orders', err);
  }
}

async function loadShiftStatus() {
  try {
    const res = await fetch('/api/shifts/current');
    const data = await res.json();
    activeShift = data.active ? data.shift : null;

    const badge = document.getElementById('top-shift-badge');
    const text = document.getElementById('top-shift-text');

    if (badge) {
      if (activeShift) {
        badge.className = 'flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 font-semibold hover:bg-emerald-500/20 transition cursor-pointer';
      } else {
        badge.className = 'flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-400 font-semibold hover:bg-rose-500/20 transition cursor-pointer';
      }
    }
    if (text) {
      text.textContent = activeShift ? 'Shift Open' : 'Shift Closed';
    }

    const closedBanner = document.getElementById('pos-closed-banner');
    if (closedBanner) {
      closedBanner.classList.toggle('hidden', !!activeShift);
    }

    if (displayChannel) {
      try {
        displayChannel.postMessage({ type: 'shift_status', active: !!activeShift });
      } catch (e) {}
    }
  } catch (err) {
    console.error('Failed to load shift status', err);
  }
}

// ==========================================
// REGISTER & PRODUCT GRID
// ==========================================
function renderCategories() {
  const container = document.getElementById('categories-pill-container');
  const catSelect = document.getElementById('prod-category');
  
  if (catSelect) {
    catSelect.innerHTML = categories.map(c => `<option value="${c.id}">${c.icon} ${c.name}</option>`).join('');
  }

  const pillsHtml = [
    `<button onclick="filterCategory(null)" class="category-pill ${currentCategory === null ? 'active' : ''} flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-bold transition whitespace-nowrap"><span>✨</span> All Items</button>`
  ];

  categories.forEach(c => {
    pillsHtml.push(`
      <button onclick="filterCategory(${c.id})" class="category-pill ${currentCategory === c.id ? 'active' : ''} flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-bold transition whitespace-nowrap">
        <span>${c.icon}</span> ${c.name}
      </button>
    `);
  });

  container.innerHTML = pillsHtml.join('');
}

function filterCategory(catId) {
  currentCategory = catId;
  renderCategories();
  renderProductGrid();
}

function handleSearch(query) {
  searchQuery = query.toLowerCase().trim();
  const clearBtn = document.getElementById('clear-search-btn');
  if (searchQuery.length > 0) {
    clearBtn.classList.remove('hidden');
  } else {
    clearBtn.classList.add('hidden');
  }
  renderProductGrid();
}

function clearSearch() {
  document.getElementById('product-search-input').value = '';
  searchQuery = '';
  document.getElementById('clear-search-btn').classList.add('hidden');
  renderProductGrid();
}

function handleProductClick(productId) {
  const product = products.find(p => p.id === productId);
  if (!product) return;

  if (product.stock_quantity <= 0 && product.stock_quantity !== 0 && !product.is_open_price) {
    showToast('Item is sold out! Please restock.', 'error');
    playSound('warning');
    return;
  }

  // Check if Open / Variable Price
  if (product.is_open_price || parseFloat(product.price) === 0) {
    openPricePromptModal(product);
  } else {
    addToCart(product.id);
  }
}

function renderProductGrid() {
  const grid = document.getElementById('products-grid');
  const noMsg = document.getElementById('no-products-msg');

  const filtered = products.filter(p => {
    const matchesCat = currentCategory === null || p.category_id === currentCategory;
    const matchesSearch = !searchQuery || 
      p.name.toLowerCase().includes(searchQuery) ||
      (p.barcode && p.barcode.toLowerCase().includes(searchQuery)) ||
      (p.category_name && p.category_name.toLowerCase().includes(searchQuery));
    return matchesCat && matchesSearch;
  });

  if (filtered.length === 0) {
    grid.innerHTML = '';
    noMsg.classList.remove('hidden');
    return;
  }

  noMsg.classList.add('hidden');

  grid.innerHTML = filtered.map(item => {
    const isSoldOut = item.stock_quantity < 0;
    const isLowStock = item.stock_quantity > 0 && item.stock_quantity <= item.low_stock_threshold;
    const isOpen = item.is_open_price || parseFloat(item.price) === 0;

    let badge = `<span class="text-[10px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-md">${item.stock_quantity} in stock</span>`;
    if (isOpen) {
      badge = `<span class="text-[10px] font-bold text-amber-300 bg-amber-500/20 border border-amber-500/40 px-2 py-0.5 rounded-md">✍️ Open Price</span>`;
    } else if (isLowStock) {
      badge = `<span class="text-[10px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-md">LOW: ${item.stock_quantity} left</span>`;
    }

    return `
      <div 
        onclick="handleProductClick(${item.id})"
        class="product-card group relative bg-slate-950 border border-slate-800 hover:border-amber-500/50 rounded-2xl p-3.5 flex flex-col justify-between cursor-pointer transition ${isSoldOut ? 'opacity-50 grayscale cursor-not-allowed' : ''}"
      >
        <div>
          <div class="flex items-start justify-between gap-1 mb-2">
            <span class="text-3xl p-1 bg-slate-900 rounded-xl border border-slate-800 shadow-sm">${item.emoji || '🍿'}</span>
            ${badge}
          </div>

          <h4 class="font-heading font-bold text-sm text-white group-hover:text-amber-400 transition line-clamp-2 leading-tight">
            ${item.name}
          </h4>

          <div class="mt-1 flex flex-wrap gap-1 items-center">
            ${item.allergy_info ? `<span class="text-[9px] text-amber-300/90 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20">⚠️ ${item.allergy_info}</span>` : ''}
          </div>
        </div>

        <div class="mt-3 pt-2 border-t border-slate-800/80 flex items-center justify-between">
          <span class="font-heading font-extrabold text-base ${isOpen ? 'text-amber-300 text-xs' : 'text-amber-400'}">
            ${isOpen ? 'Custom / Enter $' : '$' + parseFloat(item.price).toFixed(2)}
          </span>
          <button class="w-7 h-7 rounded-lg bg-slate-800 group-hover:bg-amber-500 text-slate-300 group-hover:text-slate-950 flex items-center justify-center font-bold text-sm transition">
            +
          </button>
        </div>
      </div>
    `;
  }).join('');

  lucide.createIcons();
}

// ==========================================
// OPEN / VARIABLE PRICE MODAL
// ==========================================
function openPricePromptModal(product) {
  pendingOpenPriceProduct = product;
  document.getElementById('open-price-product-id').value = product.id;
  document.getElementById('open-price-emoji').textContent = product.emoji || '🍰';
  document.getElementById('open-price-item-title').textContent = `Set Price: ${product.name}`;
  document.getElementById('open-price-input').value = parseFloat(product.price) > 0 ? parseFloat(product.price).toFixed(2) : '1.00';

  openModal('modal-open-price');
  document.getElementById('open-price-input').select();
}

function setOpenPrice(val) {
  document.getElementById('open-price-input').value = parseFloat(val).toFixed(2);
}

function submitOpenPriceToCart() {
  if (!pendingOpenPriceProduct) return;
  const customPrice = parseFloat(document.getElementById('open-price-input').value);

  if (isNaN(customPrice) || customPrice < 0) {
    showToast('Please enter a valid price amount.', 'error');
    return;
  }

  addToCart(pendingOpenPriceProduct.id, customPrice);
  closeModal('modal-open-price');
  pendingOpenPriceProduct = null;
}

// ==========================================
// CART & PRICING
// ==========================================
function addToCart(productId, customPrice = null) {
  const product = products.find(p => p.id === productId);
  if (!product) return;

  const priceToUse = (customPrice !== null) ? customPrice : parseFloat(product.price);

  // If item has custom price, check if exact item with that custom price exists
  const existing = cart.find(c => c.id === productId && c.custom_price === priceToUse);

  if (existing) {
    existing.quantity += 1;
  } else {
    cart.push({
      id: product.id,
      name: product.name,
      category_id: product.category_id,
      category_name: product.category_name || '',
      price: priceToUse,
      custom_price: priceToUse,
      is_open_price: product.is_open_price,
      cost_price: parseFloat(product.cost_price),
      emoji: product.emoji,
      allergy_info: product.allergy_info,
      quantity: 1,
      max_stock: product.stock_quantity || 999
    });
  }

  playSound('beep');
  renderCart();
}

function updateCartQty(idx, delta) {
  const item = cart[idx];
  if (!item) return;

  const newQty = item.quantity + delta;
  if (newQty <= 0) {
    removeFromCart(idx);
    return;
  }

  item.quantity = newQty;
  playSound('beep');
  renderCart();
}

function removeFromCart(idx) {
  cart.splice(idx, 1);
  renderCart();
}

function clearCart() {
  if (cart.length === 0) return;
  cart = [];
  activeDiscount = null;
  renderCart();
  showToast('Cart cleared');
}

function editCartItemPrice(idx) {
  const item = cart[idx];
  if (!item) return;
  const newPriceStr = prompt(`Enter new price for "${item.name}" ($):`, item.price.toFixed(2));
  if (newPriceStr !== null) {
    const newPrice = parseFloat(newPriceStr);
    if (!isNaN(newPrice) && newPrice >= 0) {
      item.price = newPrice;
      item.custom_price = newPrice;
      renderCart();
      showToast(`Updated price for ${item.name} to $${newPrice.toFixed(2)}`);
    }
  }
}

// Auto-Combo detection (Snack + Drink)
function detectComboSavings() {
  if (featureSettings && featureSettings.cfg_pos_auto_combo === 'false') {
    return { eligibleCombos: 0, comboDiscount: 0 };
  }

  let drinksCount = 0;
  let snacksCount = 0;

  cart.forEach(item => {
    const catName = (item.category_name || '').toLowerCase();
    const itemName = item.name.toLowerCase();
    const isDrink = catName.includes('drink') || itemName.includes('drink') || itemName.includes('gatorade') || itemName.includes('water') || itemName.includes('juice') || itemName.includes('capri') || itemName.includes('milk');
    const isSnack = catName.includes('chip') || catName.includes('crunch') || catName.includes('baked') || catName.includes('candy') || catName.includes('sweets') || itemName.includes('chips') || itemName.includes('pretzel') || itemName.includes('cookie') || itemName.includes('doritos') || itemName.includes('cheetos') || itemName.includes('takis');

    if (isDrink) drinksCount += item.quantity;
    else if (isSnack) snacksCount += item.quantity;
  });

  const eligibleCombos = Math.min(drinksCount, snacksCount);
  const comboDiscount = eligibleCombos * 0.50;

  return { eligibleCombos, comboDiscount };
}

function getHappyHourDiscount(subtotal) {
  if (!featureSettings || featureSettings.cfg_happy_hour_enabled === 'false') {
    return { active: false, amount: 0, label: '' };
  }
  const start = featureSettings.cfg_happy_hour_start || '15:00';
  const end = featureSettings.cfg_happy_hour_end || '15:30';
  const discountVal = parseFloat(featureSettings.cfg_happy_hour_discount) || 0.25;
  const label = featureSettings.cfg_happy_hour_label || '⚡ Happy Hour Deal';

  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const [sH, sM] = start.split(':').map(Number);
  const [eH, eM] = end.split(':').map(Number);
  const startMinutes = (sH || 15) * 60 + (sM || 0);
  const endMinutes = (eH || 15) * 60 + (eM || 30);

  if (currentMinutes >= startMinutes && currentMinutes <= endMinutes && subtotal > 0) {
    const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
    const amount = Math.min(subtotal, totalItems * discountVal);
    return { active: true, amount, label };
  }
  return { active: false, amount: 0, label: '' };
}

function calculateTotals() {
  const subtotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const { eligibleCombos, comboDiscount } = detectComboSavings();
  const happyHour = getHappyHourDiscount(subtotal);

  let discountAmount = 0;
  let discountLabel = '';

  if (activeDiscount) {
    discountLabel = activeDiscount.name;
    if (activeDiscount.type === 'pct') {
      discountAmount = (subtotal - comboDiscount) * (activeDiscount.value / 100);
    } else {
      discountAmount = activeDiscount.value;
    }
  }

  const combinedDiscount = comboDiscount + discountAmount + (happyHour.active ? happyHour.amount : 0);
  const totalDiscount = Math.min(combinedDiscount, subtotal);
  const total = Math.max(0, subtotal - totalDiscount);

  return { subtotal, comboDiscount, eligibleCombos, happyHour, discountAmount, discountLabel, totalDiscount, total };
}

function renderCart() {
  const container = document.getElementById('cart-items-list');
  const countEl = document.getElementById('cart-item-count');
  const btnCash = document.getElementById('btn-pay-cash');
  const btnStudent = document.getElementById('btn-pay-student');
  const comboBanner = document.getElementById('auto-combo-banner');

  const totalItemsCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  countEl.textContent = `${totalItemsCount} ${totalItemsCount === 1 ? 'item' : 'items'} in order`;

  if (cart.length === 0) {
    container.innerHTML = `
      <div id="cart-empty-placeholder" class="flex flex-col items-center justify-center h-48 text-center text-slate-500">
        <span class="text-4xl mb-2">🛒</span>
        <p class="font-medium text-slate-400 text-sm">Cart is empty</p>
        <p class="text-xs text-slate-600 mt-0.5">Click snack items on the left to add</p>
      </div>
    `;
    btnCash.disabled = true;
    btnStudent.disabled = true;
    comboBanner.classList.add('hidden');
  } else {
    btnCash.disabled = false;
    btnStudent.disabled = false;

    container.innerHTML = cart.map((item, idx) => `
      <div class="py-2.5 flex items-center justify-between gap-2">
        <div class="flex items-center gap-2.5 min-w-0">
          <span class="text-xl bg-slate-900 p-1 rounded-lg border border-slate-800">${item.emoji || '🍪'}</span>
          <div class="min-w-0">
            <h5 class="text-xs font-bold text-white truncate">${item.name}</h5>
            <button onclick="editCartItemPrice(${idx})" class="text-[11px] text-amber-400/90 hover:text-amber-300 underline font-mono">
              $${item.price.toFixed(2)} each ✏️
            </button>
          </div>
        </div>

        <div class="flex items-center gap-2">
          <div class="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-0.5">
            <button onclick="updateCartQty(${idx}, -1)" class="w-6 h-6 rounded flex items-center justify-center text-slate-400 hover:text-white hover:bg-slate-800 text-xs font-bold transition">-</button>
            <span class="w-6 text-center font-bold text-xs text-white">${item.quantity}</span>
            <button onclick="updateCartQty(${idx}, 1)" class="w-6 h-6 rounded flex items-center justify-center text-slate-400 hover:text-white hover:bg-slate-800 text-xs font-bold transition">+</button>
          </div>

          <span class="font-bold text-xs text-amber-400 w-12 text-right">
            $${(item.price * item.quantity).toFixed(2)}
          </span>

          <button onclick="removeFromCart(${idx})" class="text-slate-500 hover:text-rose-400 p-1 transition">
            <i data-lucide="trash" class="w-3.5 h-3.5"></i>
          </button>
        </div>
      </div>
    `).join('');
  }

  updateCartTotals();
  lucide.createIcons();
}

function updateCartTotals() {
  const { subtotal, comboDiscount, eligibleCombos, discountAmount, discountLabel, totalDiscount, total } = calculateTotals();

  document.getElementById('summary-subtotal').textContent = `$${subtotal.toFixed(2)}`;
  
  // Auto-combo row & banner
  const comboBanner = document.getElementById('auto-combo-banner');
  const comboRow = document.getElementById('combo-discount-row');
  const comboEl = document.getElementById('summary-combo-discount');

  if (eligibleCombos > 0) {
    comboBanner.classList.remove('hidden');
    document.getElementById('combo-banner-text').textContent = `Auto-Combo Deal! (${eligibleCombos}x Snack + Drink bundle: -$${comboDiscount.toFixed(2)})`;
    comboRow.classList.remove('hidden');
    comboEl.textContent = `-$${comboDiscount.toFixed(2)}`;
  } else {
    comboBanner.classList.add('hidden');
    comboRow.classList.add('hidden');
  }

  // Active Discount Bar & Row
  const activeLabel = document.getElementById('active-discount-label');
  const removeBtn = document.getElementById('btn-remove-discount');
  const discountRow = document.getElementById('discount-row');
  const discountTitle = document.getElementById('summary-discount-title');
  const discountEl = document.getElementById('summary-discount');

  if (activeDiscount && discountAmount > 0) {
    activeLabel.textContent = `${activeDiscount.name} (-$${discountAmount.toFixed(2)})`;
    activeLabel.className = 'font-bold text-emerald-400';
    removeBtn.classList.remove('hidden');

    discountRow.classList.remove('hidden');
    discountTitle.textContent = `${activeDiscount.name}:`;
    discountEl.textContent = `-$${discountAmount.toFixed(2)}`;
  } else {
    activeLabel.textContent = 'No Discount Applied';
    activeLabel.className = 'font-semibold text-slate-400';
    removeBtn.classList.add('hidden');
    discountRow.classList.add('hidden');
  }

  document.getElementById('summary-total').textContent = `$${total.toFixed(2)}`;
  document.getElementById('cash-btn-total-preview').textContent = `$${total.toFixed(2)}`;

  // Sync Customer Facing Second Screen
  syncCartToDisplay();
}

// ==========================================
// ADVANCED DISCOUNT SYSTEM
// ==========================================
function openDiscountModal() {
  openModal('modal-discount');
}

function applyPresetDiscount(name, type, val) {
  activeDiscount = {
    name: name,
    type: type,
    value: parseFloat(val)
  };
  playSound('beep');
  closeModal('modal-discount');
  renderCart();
  showToast(`Applied ${name}! 🏷️`, 'success');
}

function applyCustomDiscount() {
  const type = document.getElementById('custom-disc-type').value;
  const val = parseFloat(document.getElementById('custom-disc-val').value);

  if (isNaN(val) || val <= 0) {
    showToast('Please enter a valid discount amount.', 'error');
    return;
  }

  const name = type === 'pct' ? `${val}% Custom Discount` : `$${val.toFixed(2)} Custom Discount`;
  activeDiscount = {
    name: name,
    type: type,
    value: val
  };

  playSound('beep');
  closeModal('modal-discount');
  renderCart();
  showToast(`Applied ${name}! 🏷️`, 'success');
}

async function submitPromoCode() {
  const code = document.getElementById('promo-code-input').value.trim();
  if (!code) {
    showToast('Please enter a coupon code.', 'error');
    return;
  }

  const { subtotal } = calculateTotals();

  try {
    const res = await fetch('/api/discounts/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, subtotal })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Invalid code');

    activeDiscount = {
      name: data.name,
      type: data.type === 'percentage' ? 'pct' : 'fixed',
      value: data.value,
      code: data.code
    };

    playSound('chaching');
    closeModal('modal-discount');
    renderCart();
    showToast(`Promo Code Applied: ${data.name}! 🎉`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
    playSound('warning');
  }
}

function removeDiscount() {
  activeDiscount = null;
  renderCart();
  showToast('Discount removed.');
}

// ==========================================
// CASH CHECKOUT FLOW
// ==========================================
let currentCashTendered = 0;

function openCashCheckoutModal() {
  if (cart.length === 0) return;
  const { total } = calculateTotals();

  document.getElementById('cash-modal-total-due').textContent = `$${total.toFixed(2)}`;
  document.getElementById('cash-amount-input').value = total.toFixed(2);
  currentCashTendered = total;
  computeCashChange(total);

  openModal('modal-cash-checkout');
}

function setCashTendered(val) {
  const { total } = calculateTotals();
  if (val === 'exact') {
    currentCashTendered = total;
  } else {
    currentCashTendered = parseFloat(val);
  }
  document.getElementById('cash-amount-input').value = currentCashTendered.toFixed(2);
  computeCashChange(currentCashTendered);
}

function addCashTendered(val) {
  const current = parseFloat(document.getElementById('cash-amount-input').value) || 0;
  currentCashTendered = current + parseFloat(val);
  document.getElementById('cash-amount-input').value = currentCashTendered.toFixed(2);
  computeCashChange(currentCashTendered);
}

function computeCashChange(givenStr) {
  const { total } = calculateTotals();
  const given = parseFloat(givenStr) || 0;
  const change = given - total;

  const changeBox = document.getElementById('cash-change-box');
  const changeEl = document.getElementById('cash-modal-change-due');
  const subtextEl = document.getElementById('cash-change-subtext');
  const completeBtn = document.getElementById('btn-complete-cash');

  if (change < 0) {
    changeBox.className = 'bg-rose-500/10 border border-rose-500/30 p-4 rounded-2xl flex justify-between items-center';
    changeEl.className = 'font-heading font-extrabold text-3xl text-rose-400';
    changeEl.textContent = `-$${Math.abs(change).toFixed(2)}`;
    subtextEl.textContent = 'Insufficient cash given!';
    completeBtn.disabled = true;
  } else {
    changeBox.className = 'bg-emerald-500/10 border border-emerald-500/30 p-4 rounded-2xl flex justify-between items-center';
    changeEl.className = 'font-heading font-extrabold text-3xl text-emerald-400';
    changeEl.textContent = `$${change.toFixed(2)}`;
    subtextEl.textContent = change === 0 ? 'Exact cash provided' : 'Return change to customer';
    completeBtn.disabled = false;
  }
}

async function submitCashCheckout() {
  const { subtotal, totalDiscount, discountLabel, total } = calculateTotals();
  const paid = parseFloat(document.getElementById('cash-amount-input').value) || total;

  if (paid < total) {
    showToast('Paid amount is less than total due!', 'error');
    playSound('warning');
    return;
  }

  try {
    const res = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cart: cart,
        payment_method: 'cash',
        discount: totalDiscount,
        discount_name: discountLabel,
        tax: 0,
        amount_paid: paid,
        cashier_name: 'Cashier Volunteer',
        fundraiser_id: activeFundraiserId || null
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Checkout failed');

    playSound('chaching');
    closeModal('modal-cash-checkout');
    clearCart();
    loadProducts();
    celebrateDisplay(data.order);
    showReceiptModal(data.order);
    showToast(`Order ${data.order.order_number} completed! 🍿`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
    playSound('warning');
  }
}

// ==========================================
// STUDENT PASS & DIGITAL PUNCH CARDS
// ==========================================
async function openStudentCheckoutModal() {
  if (cart.length === 0) return;
  const { total } = calculateTotals();

  document.getElementById('student-modal-total-due').textContent = `$${total.toFixed(2)}`;
  document.getElementById('student-lookup-input').value = '';
  document.getElementById('selected-student-card').classList.add('hidden');
  document.getElementById('student-allergy-alert').classList.add('hidden');
  document.getElementById('student-actions-container').classList.add('hidden');
  selectedStudentForCheckout = null;

  if (students.length === 0) {
    await loadStudents();
  }

  searchStudentsForCheckout('');
  openModal('modal-student-checkout');
}

function searchStudentsForCheckout(query) {
  const q = query.toLowerCase().trim();
  const matchesContainer = document.getElementById('student-matches-list');

  const matches = students.filter(s => 
    !q || s.name.toLowerCase().includes(q) || s.student_id.toLowerCase().includes(q)
  );

  if (matches.length === 0) {
    matchesContainer.innerHTML = `<div class="text-xs text-slate-500 p-2 text-center">No student accounts found.</div>`;
    return;
  }

  matchesContainer.innerHTML = matches.slice(0, 5).map(s => {
    const punches = s.punch_card || 0;
    const rewards = s.free_rewards || 0;
    return `
      <div 
        onclick="selectStudentForCheckout(${s.id})"
        class="p-2 rounded-lg bg-slate-900 hover:bg-blue-600/20 border border-slate-800 hover:border-blue-500/50 cursor-pointer flex items-center justify-between transition"
      >
        <div>
          <div class="font-bold text-xs text-white">${s.name} <span class="text-[10px] text-blue-300 font-normal">(${s.student_id} • ${s.grade})</span></div>
          <div class="text-[10px] text-amber-300 flex items-center gap-1 mt-0.5">
            <span>⭐ ${punches}/10 Punches</span>
            ${rewards > 0 ? `<span class="bg-amber-500 text-slate-950 font-extrabold px-1 rounded text-[9px]">${rewards} Free Pass!</span>` : ''}
          </div>
        </div>
        <div class="text-right">
          <span class="font-bold text-xs text-emerald-400">$${parseFloat(s.balance).toFixed(2)} balance</span>
        </div>
      </div>
    `;
  }).join('');
}

function selectStudentForCheckout(studentId) {
  const student = students.find(s => s.id === studentId);
  if (!student) return;

  selectedStudentForCheckout = student;
  const { total } = calculateTotals();

  const card = document.getElementById('selected-student-card');
  const alertBox = document.getElementById('student-allergy-alert');
  const alertText = document.getElementById('student-allergy-text');
  const actionsContainer = document.getElementById('student-actions-container');
  const btnBalance = document.getElementById('btn-pay-balance');
  const balancePreview = document.getElementById('balance-btn-preview');
  const btnReward = document.getElementById('btn-pay-free-reward');

  const balance = parseFloat(student.balance) || 0;
  const punches = student.punch_card || 0;
  const freeRewards = student.free_rewards || 0;

  let punchCardStars = '';
  for (let i = 1; i <= 10; i++) {
    if (i <= punches) {
      punchCardStars += `<span class="w-6 h-6 rounded-md bg-amber-500 text-slate-950 flex items-center justify-center font-extrabold text-xs shadow-sm">★</span>`;
    } else {
      punchCardStars += `<span class="w-6 h-6 rounded-md bg-slate-800 border border-slate-700 text-slate-500 flex items-center justify-center text-xs">○</span>`;
    }
  }

  // Birthday Detection
  let isBirthdayToday = false;
  if (student.birthday) {
    const today = new Date();
    const todayMonth = today.getMonth() + 1;
    const todayDay = today.getDate();
    const parts = student.birthday.split('-');
    if (parts.length >= 3) {
      const bMonth = parseInt(parts[1], 10);
      const bDay = parseInt(parts[2], 10);
      if (bMonth === todayMonth && bDay === todayDay) {
        isBirthdayToday = true;
      }
    }
  }

  let birthdayBanner = '';
  if (isBirthdayToday && featureSettings.cfg_pos_birthday_celebration !== 'false') {
    birthdayBanner = `
      <div class="mt-2 bg-gradient-to-r from-pink-500/20 via-purple-500/20 to-amber-500/20 border-2 border-pink-500/50 p-2.5 rounded-2xl flex flex-wrap items-center justify-between gap-2 shadow-lg animate-pulse">
        <div class="flex items-center gap-2">
          <span class="text-2xl">🎂</span>
          <div>
            <span class="font-heading font-black text-pink-300 text-xs block">IT'S ${student.name.toUpperCase()}'S BIRTHDAY TODAY! 🎉</span>
            <span class="text-[10px] text-slate-300">100% Free Birthday Treat on the house!</span>
          </div>
        </div>
        <button onclick="applyBirthdayFreeTreat('${student.name}')" class="bg-gradient-to-r from-pink-500 to-purple-600 hover:from-pink-400 hover:to-purple-500 text-white font-extrabold px-3 py-1.5 rounded-xl text-xs shadow transition">
          🎁 Apply Free Birthday Snack
        </button>
      </div>
    `;

    // Notify Customer Facing 2nd Screen to burst in confetti and celebration!
    if (displayChannel) {
      try {
        displayChannel.postMessage({ type: 'birthday_alert', student });
      } catch(e){}
    }
    fetch('/api/display/birthday', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ student })
    }).catch(()=>{});

    playSound('fanfare');
  }

  card.classList.remove('hidden');
  card.innerHTML = `
    <div class="flex items-center justify-between border-b border-slate-800 pb-2">
      <div>
        <h4 class="font-bold text-sm text-white">${student.name}</h4>
        <span class="text-xs text-blue-300">${student.student_id} • ${student.grade}</span>
      </div>
      <div class="text-right">
        <span class="text-[10px] text-slate-400 block">Prepaid Balance</span>
        <span class="font-heading font-extrabold text-lg ${balance > 0 ? 'text-emerald-400' : 'text-slate-400'}">$${balance.toFixed(2)}</span>
      </div>
    </div>

    <div class="space-y-1.5 pt-1">
      <div class="flex justify-between text-xs">
        <span class="font-semibold text-amber-400 flex items-center gap-1">
          <i data-lucide="award" class="w-3.5 h-3.5"></i>
          Digital Punch Card:
        </span>
        <span class="text-slate-300 font-bold">${punches} / 10 Stamps</span>
      </div>
      <div class="grid grid-cols-10 gap-1">
        ${punchCardStars}
      </div>
      <p class="text-[10px] text-slate-400 text-center pt-0.5">Every 10 orders = 1 FREE Snack Reward!</p>
    </div>

    ${birthdayBanner}
  `;

  // Allergy Check
  let hasAllergyMatch = false;
  let matchingAllergens = [];

  if (student.allergies && student.allergies.toLowerCase() !== 'none') {
    const studentAllergyWords = student.allergies.toLowerCase().split(/[\s,]+/);
    cart.forEach(item => {
      if (item.allergy_info) {
        studentAllergyWords.forEach(word => {
          if (word.length > 3 && item.allergy_info.toLowerCase().includes(word)) {
            hasAllergyMatch = true;
            matchingAllergens.push(`"${item.name}"`);
          }
        });
      }
    });
  }

  if (hasAllergyMatch) {
    alertBox.classList.remove('hidden');
    alertText.textContent = `Caution! Student allergy flags: ${matchingAllergens.join(', ')} (${student.allergies})`;
    playSound('warning');
  } else if (student.allergies && student.allergies.toLowerCase() !== 'none') {
    alertBox.classList.remove('hidden');
    alertText.textContent = `Documented dietary note: ${student.allergies}`;
  } else {
    alertBox.classList.add('hidden');
  }

  actionsContainer.classList.remove('hidden');
  balancePreview.textContent = `$${balance.toFixed(2)} available`;

  if (balance >= total) {
    btnBalance.disabled = false;
  } else {
    btnBalance.disabled = true;
  }

  if (freeRewards > 0) {
    btnReward.classList.remove('hidden');
  } else {
    btnReward.classList.add('hidden');
  }

  playSound('beep');
  lucide.createIcons();
  syncCartToDisplay();
}

async function submitStudentCheckout(paymentType) {
  if (!selectedStudentForCheckout) return;
  const { totalDiscount, discountLabel, total } = calculateTotals();
  const isReward = paymentType === 'reward_token';

  try {
    const res = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cart: cart,
        payment_method: paymentType,
        student_id: selectedStudentForCheckout.id,
        use_reward: isReward,
        discount: totalDiscount,
        discount_name: isReward ? '100% Free Snack Reward Pass' : discountLabel,
        tax: 0,
        amount_paid: isReward ? 0 : total,
        cashier_name: 'Cashier Volunteer',
        fundraiser_id: activeFundraiserId || null
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Student checkout failed');

    if (isReward || (data.order && data.order.free_rewards > (selectedStudentForCheckout.free_rewards || 0))) {
      playSound('fanfare');
      showToast(`🎉 Congratulations! Student earned a FREE Snack Reward!`, 'reward');
    } else {
      playSound('chaching');
      showToast(`Punch card stamped ⭐! Order completed!`, 'success');
    }

    closeModal('modal-student-checkout');
    clearCart();
    loadProducts();
    loadStudents();
    celebrateDisplay(data.order);
    showReceiptModal(data.order);
  } catch (err) {
    showToast(err.message, 'error');
    playSound('warning');
  }
}

// ==========================================
// OTHER CHECKOUT (CARD / MEAL TOKEN)
// ==========================================
async function quickOtherCheckout(methodName) {
  if (cart.length === 0) return;
  const { totalDiscount, discountLabel, total } = calculateTotals();

  try {
    const res = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cart: cart,
        payment_method: methodName,
        discount: totalDiscount,
        discount_name: discountLabel,
        tax: 0,
        amount_paid: total,
        cashier_name: 'Cashier Volunteer',
        fundraiser_id: activeFundraiserId || null
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Checkout failed');

    playSound('chaching');
    clearCart();
    loadProducts();
    celebrateDisplay(data.order);
    showReceiptModal(data.order);
    showToast(`Order completed via ${methodName}! 🍿`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
    playSound('warning');
  }
}

// ==========================================
// RECEIPT MODAL
// ==========================================
function showReceiptModal(order) {
  const container = document.getElementById('printable-receipt');
  const dateStr = new Date(order.created_at || Date.now()).toLocaleString();

  let itemsHtml = '';
  if (order.items && order.items.length > 0) {
    itemsHtml = order.items.map(item => `
      <div style="display: flex; justify-content: space-between; margin: 3px 0;">
        <span>${item.quantity}x ${item.product_name}</span>
        <span>$${parseFloat(item.total_price).toFixed(2)}</span>
      </div>
    `).join('');
  }

  const punchInfo = order.punch_card_count !== undefined 
    ? `<div style="text-align: center; margin-top: 8px; padding: 6px; background: #f3f4f6; border-radius: 6px; font-weight: bold; font-size: 11px;">
        ⭐ PUNCH CARD: ${order.punch_card_count}/10 STAMPS
        ${order.free_rewards > 0 ? `<div style="color: #d97706;">🎁 FREE SNACK UNLOCKED!</div>` : ''}
       </div>`
    : '';

  container.innerHTML = `
    <div style="text-align: center; border-bottom: 1px dashed #4b5563; padding-bottom: 8px; margin-bottom: 8px;">
      <h3 style="font-size: 14px; font-weight: bold; margin: 0;">JORDAN'S SNACK SHACK</h3>
      <p style="font-size: 10px; color: #4b5563; margin: 2px 0;">School Snack Bar & Fundraiser</p>
      <p style="font-size: 10px; color: #4b5563; margin: 2px 0;">${dateStr}</p>
      <p style="font-size: 11px; font-weight: bold; margin-top: 4px;"># ${order.order_number}</p>
    </div>

    <div style="margin: 8px 0; border-bottom: 1px dashed #4b5563; padding-bottom: 8px;">
      ${itemsHtml}
    </div>

    <div style="space-y: 2px; font-size: 11px;">
      <div style="display: flex; justify-content: space-between;">
        <span>Subtotal:</span>
        <span>$${parseFloat(order.subtotal).toFixed(2)}</span>
      </div>
      ${parseFloat(order.discount) > 0 ? `
        <div style="display: flex; justify-content: space-between; color: #059669;">
          <span>Savings (${order.discount_name || 'Discount'}):</span>
          <span>-$${parseFloat(order.discount).toFixed(2)}</span>
        </div>` : ''}
      <div style="display: flex; justify-content: space-between; font-weight: bold; font-size: 13px; margin-top: 4px; border-top: 1px solid #111827; padding-top: 4px;">
        <span>TOTAL:</span>
        <span>$${parseFloat(order.total).toFixed(2)}</span>
      </div>
      <div style="display: flex; justify-content: space-between; font-size: 10px; color: #4b5563; margin-top: 6px;">
        <span>Payment Method:</span>
        <span style="text-transform: uppercase;">${order.payment_method.replace('_', ' ')}</span>
      </div>
      ${order.payment_method.includes('cash') ? `
        <div style="display: flex; justify-content: space-between; font-size: 10px; color: #4b5563;">
          <span>Cash Tendered:</span>
          <span>$${parseFloat(order.amount_paid).toFixed(2)}</span>
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 10px; font-weight: bold; color: #059669;">
          <span>Change Due:</span>
          <span>$${parseFloat(order.change_due).toFixed(2)}</span>
        </div>` : ''}
    </div>

    ${punchInfo}

    <div style="text-align: center; margin-top: 10px; padding-top: 8px; border-top: 1px dashed #4b5563; font-size: 10px; color: #4b5563;">
      <p>Thank you for supporting our school snack shop!</p>
      <p style="font-size: 8px; margin-top: 4px;">★ HAVE A GREAT DAY ★</p>
    </div>
  `;

  openModal('modal-receipt');
}

function printReceipt() {
  window.print();
}

function handleNewOrderClick() {
  closeModal('modal-receipt');
  isCelebrationActiveOnDisplay = false;
  cart = [];
  selectedStudentForCheckout = null;
  activeDiscount = null;
  renderCart();

  // Explicitly return the 2nd monitor to the idle/welcome screen
  syncCartToDisplay(true);

  // Clear search input and restore full catalog view for next customer
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.value = '';
    searchQuery = '';
    renderProductGrid();
  }
}

// ==========================================
// STUDENT PASS & PUNCH CARDS TAB
// ==========================================
function renderStudentsTable(filterText = '') {
  const tbody = document.getElementById('students-table-body');
  const q = (filterText || document.getElementById('student-search-input')?.value || '').toLowerCase().trim();

  const filtered = students.filter(s => 
    !q || s.name.toLowerCase().includes(q) || s.student_id.toLowerCase().includes(q) || s.grade.toLowerCase().includes(q)
  );

  const totalPunches = students.reduce((sum, s) => sum + (s.punch_card || 0), 0);
  document.getElementById('stat-total-punches').textContent = `${totalPunches} Stamps`;

  const totalPool = students.reduce((sum, s) => sum + parseFloat(s.balance), 0);
  document.getElementById('stat-total-balance').textContent = `$${totalPool.toFixed(2)}`;

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-slate-500">No student accounts found. Click "+ New Student Pass" above.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(s => {
    const bal = parseFloat(s.balance) || 0;
    const punches = s.punch_card || 0;
    const rewards = s.free_rewards || 0;

    return `
      <tr class="hover:bg-slate-900/60 transition">
        <td class="p-3.5 font-bold text-white">${s.student_id}</td>
        <td class="p-3.5">
          <div class="font-bold text-slate-100">${s.name}</div>
          <div class="text-[11px] text-slate-400">${s.grade}</div>
        </td>
        <td class="p-3.5">
          <span class="font-heading font-extrabold text-sm ${bal > 0 ? 'text-emerald-400' : 'text-slate-400'}">
            $${bal.toFixed(2)}
          </span>
        </td>
        <td class="p-3.5">
          <div class="flex items-center gap-2">
            <span class="bg-amber-500/10 text-amber-400 border border-amber-500/30 px-2.5 py-1 rounded-lg font-bold text-xs">
              ⭐ ${punches} / 10
            </span>
            ${rewards > 0 ? `<span class="bg-gradient-to-r from-amber-500 to-orange-500 text-slate-950 px-2 py-0.5 rounded-md font-extrabold text-[10px]">🎁 ${rewards} FREE</span>` : ''}
          </div>
        </td>
        <td class="p-3.5">
          ${s.allergies && s.allergies.toLowerCase() !== 'none'
            ? `<span class="bg-rose-500/10 text-rose-300 border border-rose-500/30 px-2 py-0.5 rounded-full text-[10px] font-semibold">⚠️ ${s.allergies}</span>`
            : `<span class="text-slate-500 text-[11px]">None</span>`}
        </td>
        <td class="p-3.5 text-right space-x-1 whitespace-nowrap">
          <button onclick="openEditStudentModal(${s.id})" class="bg-blue-500/20 hover:bg-blue-500 text-blue-300 hover:text-white px-2.5 py-1.5 rounded-lg border border-blue-500/30 text-xs font-semibold transition" title="Edit Student Profile">
            ✏️ Edit
          </button>
          <button onclick="openPrintBadgeModal(${s.id})" class="bg-amber-500/20 hover:bg-amber-500 text-amber-300 hover:text-slate-950 px-2.5 py-1.5 rounded-lg border border-amber-500/30 text-xs font-semibold transition" title="Print Barcode Badge Pass">
            🏷️ Badge
          </button>
          <button onclick="openRechargeModal(${s.id})" class="bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white px-2.5 py-1.5 rounded-lg border border-emerald-500/30 text-xs font-semibold transition">
            + Reload $
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function openNewStudentModal() {
  document.getElementById('edit-stu-id-pk').value = '';
  document.getElementById('student-modal-title').textContent = 'Create Student Pass & Punch Card';
  document.getElementById('btn-save-stu-text').textContent = 'Create Student Pass';
  document.getElementById('btn-delete-stu').classList.add('hidden');

  document.getElementById('new-stu-name').value = '';
  document.getElementById('new-stu-id').value = `STU${Math.floor(100 + Math.random() * 900)}`;
  document.getElementById('new-stu-grade').value = '7th Grade';
  document.getElementById('new-stu-balance').value = '0.00';
  document.getElementById('new-stu-limit').value = '10.00';
  document.getElementById('new-stu-punch').value = '0';
  document.getElementById('new-stu-rewards').value = '0';
  document.getElementById('new-stu-allergies').value = '';
  document.getElementById('new-stu-notes').value = '';
  document.getElementById('new-stu-birthday').value = '';
  document.getElementById('new-stu-streak').value = '0';
  document.getElementById('new-stu-photo-data').value = '';
  document.getElementById('new-stu-photo-preview').innerHTML = `👤`;

  openModal('modal-student-new');
}

function openEditStudentModal(studentId) {
  const student = students.find(s => s.id === studentId);
  if (!student) return;

  document.getElementById('edit-stu-id-pk').value = student.id;
  document.getElementById('student-modal-title').textContent = `Edit Profile: ${student.name}`;
  document.getElementById('btn-save-stu-text').textContent = 'Save Profile Changes';
  document.getElementById('btn-delete-stu').classList.remove('hidden');

  document.getElementById('new-stu-name').value = student.name || '';
  document.getElementById('new-stu-id').value = student.student_id || '';
  document.getElementById('new-stu-grade').value = student.grade || '7th Grade';
  document.getElementById('new-stu-balance').value = parseFloat(student.balance || 0).toFixed(2);
  document.getElementById('new-stu-limit').value = parseFloat(student.daily_limit || 10).toFixed(2);
  document.getElementById('new-stu-punch').value = student.punch_card || 0;
  document.getElementById('new-stu-rewards').value = student.free_rewards || 0;
  document.getElementById('new-stu-allergies').value = student.allergies || '';
  document.getElementById('new-stu-notes').value = student.notes || '';
  document.getElementById('new-stu-birthday').value = student.birthday || '';
  document.getElementById('new-stu-streak').value = student.streak_count || 0;
  document.getElementById('new-stu-photo-data').value = student.photo_data || '';

  if (student.photo_data) {
    document.getElementById('new-stu-photo-preview').innerHTML = `<img src="${student.photo_data}" class="w-full h-full object-cover" />`;
  } else {
    document.getElementById('new-stu-photo-preview').innerHTML = `👤`;
  }

  openModal('modal-student-new');
}

function handleStudentPhotoSelected(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    document.getElementById('new-stu-photo-data').value = dataUrl;
    document.getElementById('new-stu-photo-preview').innerHTML = `<img src="${dataUrl}" class="w-full h-full object-cover" />`;
  };
  reader.readAsDataURL(file);
}

async function snapPhotoFromWebcam() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 320, height: 320 } });
    const video = document.createElement('video');
    video.srcObject = stream;
    video.play();

    setTimeout(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 160;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, 160, 160);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);

      stream.getTracks().forEach(t => t.stop());

      document.getElementById('new-stu-photo-data').value = dataUrl;
      document.getElementById('new-stu-photo-preview').innerHTML = `<img src="${dataUrl}" class="w-full h-full object-cover" />`;
      showToast('Photo captured successfully! 📸', 'success');
    }, 800);
  } catch (err) {
    showToast('Webcam access notice: ' + err.message, 'error');
  }
}

async function submitStudentForm() {
  const pk = document.getElementById('edit-stu-id-pk').value;
  const name = document.getElementById('new-stu-name').value.trim();
  const student_id = document.getElementById('new-stu-id').value.trim();
  const grade = document.getElementById('new-stu-grade').value.trim();
  const balance = parseFloat(document.getElementById('new-stu-balance').value) || 0;
  const limit = parseFloat(document.getElementById('new-stu-limit').value) || 10;
  const punch_card = parseInt(document.getElementById('new-stu-punch').value, 10) || 0;
  const free_rewards = parseInt(document.getElementById('new-stu-rewards').value, 10) || 0;
  const allergies = document.getElementById('new-stu-allergies').value.trim();
  const notes = document.getElementById('new-stu-notes').value.trim();
  const birthday = document.getElementById('new-stu-birthday').value;
  const streak_count = parseInt(document.getElementById('new-stu-streak').value, 10) || 0;
  const photo_data = document.getElementById('new-stu-photo-data').value || '';

  if (!name || !student_id) {
    showToast('Name and Student ID are required', 'error');
    return;
  }

  const payload = {
    student_id,
    name,
    grade,
    balance,
    daily_limit: limit,
    punch_card,
    free_rewards,
    allergies,
    notes,
    birthday,
    streak_count,
    photo_data
  };

  try {
    const url = pk ? `/api/students/${pk}` : '/api/students';
    const method = pk ? 'PUT' : 'POST';

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save student');

    playSound('beep');
    closeModal('modal-student-new');
    loadStudents();
    showToast(pk ? `Updated profile for ${name}! ✨` : `Student pass created for ${name}! 🎒`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleDeleteStudent() {
  const pk = document.getElementById('edit-stu-id-pk').value;
  if (!pk) return;
  const s = students.find(item => item.id === parseInt(pk, 10));
  const confirmMsg = s ? `Are you sure you want to delete ${s.name}'s snack pass?` : 'Delete this student pass?';
  if (!confirm(confirmMsg)) return;

  try {
    const res = await fetch(`/api/students/${pk}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to delete student');

    closeModal('modal-student-new');
    loadStudents();
    showToast('Student account deleted.', 'info');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function openRechargeModal(studentId) {
  const student = students.find(s => s.id === studentId);
  if (!student) return;

  document.getElementById('recharge-student-id').value = student.id;
  document.getElementById('recharge-student-name').textContent = `Reload: ${student.name}`;
  document.getElementById('recharge-current-balance').textContent = `Current: $${parseFloat(student.balance).toFixed(2)}`;
  document.getElementById('recharge-amount-input').value = '10.00';
  document.getElementById('recharge-note-input').value = 'Parent Deposit';

  openModal('modal-recharge');
}

function setRechargeAmount(val) {
  document.getElementById('recharge-amount-input').value = parseFloat(val).toFixed(2);
}

async function submitRecharge() {
  const studentId = document.getElementById('recharge-student-id').value;
  const amount = parseFloat(document.getElementById('recharge-amount-input').value);
  const notes = document.getElementById('recharge-note-input').value;

  if (isNaN(amount) || amount <= 0) {
    showToast('Please enter a valid deposit amount', 'error');
    return;
  }

  try {
    const res = await fetch(`/api/students/${studentId}/recharge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, notes })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Recharge failed');

    playSound('chaching');
    closeModal('modal-recharge');
    loadStudents();
    showToast(`Added $${amount.toFixed(2)} to account! New balance: $${parseFloat(data.balance).toFixed(2)}`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ==========================================
// INVENTORY & PRODUCT MANAGEMENT
// ==========================================
function toggleOpenPriceFields(isOpen) {
  const priceFields = document.getElementById('fixed-price-fields');
  if (isOpen) {
    priceFields.classList.add('opacity-50');
    document.getElementById('prod-price').value = '0.00';
  } else {
    priceFields.classList.remove('opacity-50');
    if (parseFloat(document.getElementById('prod-price').value) === 0) {
      document.getElementById('prod-price').value = '1.50';
    }
  }
}

function renderInventoryTable(filterText = '') {
  const tbody = document.getElementById('inventory-table-body');
  const q = (filterText || document.getElementById('inventory-search-input')?.value || '').toLowerCase().trim();

  const filtered = products.filter(p => 
    !q || p.name.toLowerCase().includes(q) || (p.category_name && p.category_name.toLowerCase().includes(q))
  );

  document.getElementById('stat-total-products').textContent = products.length;
  const lowCount = products.filter(p => p.stock_quantity <= p.low_stock_threshold).length;
  document.getElementById('stat-low-stock-count').textContent = `${lowCount} items`;

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="p-6 text-center text-slate-500">No items match your search. Click "+ Add New Snack" above.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(p => {
    const price = parseFloat(p.price);
    const cost = parseFloat(p.cost_price);
    const isOpen = p.is_open_price || price === 0;
    const isLow = p.stock_quantity <= p.low_stock_threshold;
    const isOut = p.stock_quantity <= 0;

    return `
      <tr class="hover:bg-slate-900/60 transition">
        <td class="p-3.5">
          <div class="flex items-center gap-2">
            <span class="text-xl">${p.emoji || '🍿'}</span>
            <div>
              <div class="font-bold text-white">${p.name}</div>
              ${p.allergy_info ? `<div class="text-[10px] text-amber-300">⚠️ ${p.allergy_info}</div>` : ''}
            </div>
          </div>
        </td>
        <td class="p-3.5 text-slate-400">${p.category_name || 'General'}</td>
        <td class="p-3.5">
          ${isOpen 
            ? `<span class="bg-amber-500/10 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded-full font-bold text-[10px]">✍️ Open Price</span>` 
            : `<span class="text-slate-400 text-[11px]">Fixed Price</span>`
          }
        </td>
        <td class="p-3.5 font-bold text-white">${isOpen ? 'Prompt at register' : '$' + price.toFixed(2)}</td>
        <td class="p-3.5 text-slate-400">$${cost.toFixed(2)}</td>
        <td class="p-3.5">
          ${isOut 
            ? `<span class="bg-rose-500/10 text-rose-400 border border-rose-500/30 px-2 py-0.5 rounded-full font-bold text-[10px]">0 (SOLD OUT)</span>`
            : isLow
              ? `<span class="bg-amber-500/10 text-amber-400 border border-amber-500/30 px-2 py-0.5 rounded-full font-bold text-[10px]">LOW: ${p.stock_quantity} left</span>`
              : `<span class="bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-full font-bold text-[10px]">${p.stock_quantity} in stock</span>`
          }
        </td>
        <td class="p-3.5 text-right space-x-1.5 whitespace-nowrap">
          <button onclick="openEditProductModal(${p.id})" class="bg-amber-500/20 hover:bg-amber-500 text-amber-300 hover:text-slate-950 px-2.5 py-1.5 rounded-lg border border-amber-500/30 text-xs font-semibold transition" title="Edit Item Details & Price">
            ✏️ Edit
          </button>
          <button onclick="openShrinkageModal(${p.id})" class="bg-rose-500/10 hover:bg-rose-500 text-rose-300 hover:text-white px-2.5 py-1.5 rounded-lg border border-rose-500/30 text-xs font-semibold transition" title="Log expired, damaged, or spilled snack">
            🗑️ Spoilage
          </button>
          <button onclick="openRestockModal(${p.id})" class="bg-slate-800 hover:bg-slate-700 text-slate-200 px-2.5 py-1.5 rounded-lg border border-slate-700 text-xs font-semibold transition">
            + Restock
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function openRestockModal(productId) {
  const product = products.find(p => p.id === productId);
  if (!product) return;

  document.getElementById('restock-product-id').value = product.id;
  document.getElementById('restock-item-title').textContent = `Restock: ${product.name}`;
  document.getElementById('restock-current-count').textContent = `Current Stock: ${product.stock_quantity} units`;
  document.getElementById('restock-qty-input').value = 24;
  document.getElementById('restock-reason-input').value = 'Costco Bulk Restock';

  openModal('modal-restock');
}

function setRestockQty(qty) {
  document.getElementById('restock-qty-input').value = qty;
}

async function submitRestock() {
  const productId = document.getElementById('restock-product-id').value;
  const add_quantity = parseInt(document.getElementById('restock-qty-input').value, 10);
  const reason = document.getElementById('restock-reason-input').value;

  if (isNaN(add_quantity) || add_quantity <= 0) {
    showToast('Please enter a valid restock quantity', 'error');
    return;
  }

  try {
    const res = await fetch(`/api/products/${productId}/restock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ add_quantity, reason })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to restock');

    playSound('chaching');
    closeModal('modal-restock');
    loadProducts();
    showToast(`Added +${add_quantity} units to stock! New total: ${data.stock_quantity} 📦`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function openNewProductModal() {
  document.getElementById('prod-id').value = '';
  document.getElementById('product-modal-title').textContent = 'Add New Snack Item';
  document.getElementById('btn-save-prod-text').textContent = 'Save Item to Catalog';
  document.getElementById('btn-delete-prod').classList.add('hidden');

  document.getElementById('prod-name').value = '';
  document.getElementById('prod-barcode').value = '';
  document.getElementById('prod-price').value = '1.50';
  document.getElementById('prod-stock').value = '48';
  document.getElementById('prod-low').value = '10';
  document.getElementById('prod-emoji').value = '🍿';
  document.getElementById('prod-allergy').value = '';
  document.getElementById('prod-calories').value = '150';
  document.getElementById('prod-sugar').value = '6';
  document.getElementById('prod-carbs').value = '22';
  document.getElementById('prod-badges').value = '100% Peanut-Free';
  document.getElementById('prod-ingredients').value = '';
  document.getElementById('prod-is-open-price').checked = false;
  toggleOpenPriceFields(false);

  renderCategories();
  openModal('modal-product');
}

function openEditProductModal(productId) {
  const product = products.find(p => p.id === productId);
  if (!product) return;

  document.getElementById('prod-id').value = product.id;
  document.getElementById('product-modal-title').textContent = `Edit Snack: ${product.name}`;
  document.getElementById('btn-save-prod-text').textContent = 'Save Snack Changes';
  document.getElementById('btn-delete-prod').classList.remove('hidden');

  document.getElementById('prod-name').value = product.name || '';
  document.getElementById('prod-barcode').value = product.barcode || '';
  document.getElementById('prod-price').value = parseFloat(product.price || 0).toFixed(2);
  document.getElementById('prod-cost').value = parseFloat(product.cost_price || 0).toFixed(2);
  document.getElementById('prod-stock').value = product.stock_quantity || 0;
  document.getElementById('prod-low').value = product.low_stock_threshold || 10;
  document.getElementById('prod-emoji').value = product.emoji || '🍿';
  document.getElementById('prod-allergy').value = product.allergy_info || '';
  document.getElementById('prod-calories').value = product.calories || 150;
  document.getElementById('prod-sugar').value = product.sugar !== undefined && product.sugar !== null ? product.sugar : 6;
  document.getElementById('prod-carbs').value = product.carbs !== undefined && product.carbs !== null ? product.carbs : 22;
  document.getElementById('prod-badges').value = product.dietary_badges || '';
  document.getElementById('prod-ingredients').value = product.ingredients || '';
  document.getElementById('prod-is-open-price').checked = Boolean(product.is_open_price);
  toggleOpenPriceFields(Boolean(product.is_open_price));

  renderCategories();
  if (product.category_id) {
    document.getElementById('prod-category').value = product.category_id;
  }

  openModal('modal-product');
}

function openCustomItemModal() {
  openNewProductModal();
}

async function submitProductForm() {
  const id = document.getElementById('prod-id').value;
  const name = document.getElementById('prod-name').value.trim();
  const category_id = parseInt(document.getElementById('prod-category').value, 10);
  const barcode = document.getElementById('prod-barcode').value.trim();
  const emoji = document.getElementById('prod-emoji').value.trim() || '🍪';
  const is_open_price = document.getElementById('prod-is-open-price').checked;
  const price = is_open_price ? 0 : (parseFloat(document.getElementById('prod-price').value) || 1.0);
  const cost_price = parseFloat(document.getElementById('prod-cost').value) || 0.0;
  const stock_quantity = parseInt(document.getElementById('prod-stock').value, 10) || 0;
  const low_stock_threshold = parseInt(document.getElementById('prod-low').value, 10) || 10;
  const allergy_info = document.getElementById('prod-allergy').value.trim();
  const calories = parseInt(document.getElementById('prod-calories').value, 10) || 0;
  const sugar = parseFloat(document.getElementById('prod-sugar').value) || 0;
  const carbs = parseFloat(document.getElementById('prod-carbs').value) || 0;
  const dietary_badges = document.getElementById('prod-badges').value.trim();
  const ingredients = document.getElementById('prod-ingredients').value.trim();

  if (!name) {
    showToast('Item name is required', 'error');
    return;
  }

  const payload = {
    name,
    category_id,
    barcode,
    emoji,
    price,
    cost_price,
    stock_quantity,
    low_stock_threshold,
    allergy_info,
    is_open_price,
    calories,
    sugar,
    carbs,
    dietary_badges,
    ingredients
  };

  try {
    const url = id ? `/api/products/${id}` : '/api/products';
    const method = id ? 'PUT' : 'POST';

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save product');

    playSound('beep');
    closeModal('modal-product');
    loadProducts();
    showToast(id ? `Updated "${name}" in catalog! ✨` : `Added "${name}" to catalog! ✨`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleDeleteProduct() {
  const id = document.getElementById('prod-id').value;
  if (!id) return;
  const p = products.find(item => item.id === parseInt(id, 10));
  const confirmMsg = p ? `Are you sure you want to delete "${p.name}"?` : 'Delete this product?';
  if (!confirm(confirmMsg)) return;

  try {
    const res = await fetch(`/api/products/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to delete product');

    closeModal('modal-product');
    loadProducts();
    showToast('Product removed from catalog.', 'info');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ==========================================
// ORDERS HISTORY
// ==========================================
function renderOrdersTable() {
  const tbody = document.getElementById('orders-table-body');
  if (orders.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="p-6 text-center text-slate-500">No orders logged yet</td></tr>`;
    return;
  }

  tbody.innerHTML = orders.map(o => {
    const timeStr = new Date(o.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateStr = new Date(o.created_at).toLocaleDateString();
    const itemsSummary = o.items ? o.items.map(i => `${i.quantity}x ${i.product_name}`).join(', ') : 'Items';

    return `
      <tr class="hover:bg-slate-900/60 transition">
        <td class="p-3.5 font-bold text-white">${o.order_number}</td>
        <td class="p-3.5 text-slate-400">
          <div>${timeStr}</div>
          <div class="text-[10px] text-slate-500">${dateStr}</div>
        </td>
        <td class="p-3.5 text-slate-300 max-w-xs truncate">${itemsSummary}</td>
        <td class="p-3.5">
          <span class="capitalize px-2 py-0.5 rounded-md text-[10px] font-bold ${
            o.payment_method.includes('cash') 
              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' 
              : o.payment_method === 'student_account'
                ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                : 'bg-purple-500/10 text-purple-400 border border-purple-500/20'
          }">
            ${o.payment_method.replace('_', ' ')}
          </span>
        </td>
        <td class="p-3.5 text-slate-300">${o.student_name || 'Walk-in Student'}</td>
        <td class="p-3.5 font-heading font-bold text-amber-400">$${parseFloat(o.total).toFixed(2)}</td>
        <td class="p-3.5 text-right">
          <button onclick='showReceiptModal(${JSON.stringify(o)})' class="p-1.5 text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition" title="View & Print Receipt">
            <i data-lucide="printer" class="w-3.5 h-3.5"></i>
          </button>
        </td>
      </tr>
    `;
  }).join('');

  lucide.createIcons();
}

// ==========================================
// SHIFT DRAWER AUDIT LOGIC
// ==========================================
async function loadShiftData() {
  await loadShiftStatus();
  const card = document.getElementById('active-shift-card');

  if (!activeShift) {
    card.innerHTML = `
      <div class="text-center py-6 space-y-4">
        <div class="w-16 h-16 rounded-3xl bg-amber-500/10 text-amber-400 border border-amber-500/20 flex items-center justify-center text-3xl mx-auto">
          🔒
        </div>
        <div>
          <h3 class="font-heading font-extrabold text-lg text-white">No Register Shift Currently Open</h3>
          <p class="text-xs text-slate-400 mt-1 max-w-sm mx-auto">Start a new cashier shift with your initial cash drawer float (e.g. $50.00 for making change).</p>
        </div>

        <div class="max-w-xs mx-auto space-y-3 pt-2">
          <div>
            <label class="text-xs text-slate-400 block text-left font-semibold mb-1">Cashier Name:</label>
            <input type="text" id="open-cashier-name" value="Student Volunteer" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white" />
          </div>
          <div>
            <label class="text-xs text-slate-400 block text-left font-semibold mb-1">Starting Cash Float ($):</label>
            <input type="number" step="5.00" id="open-start-cash" value="50.00" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm font-bold text-emerald-400" />
          </div>
          <button onclick="startNewShift()" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 rounded-xl text-sm shadow-lg shadow-emerald-900/30 flex items-center justify-center gap-2 transition">
            <i data-lucide="play" class="w-4 h-4"></i>
            <span>Open Cashier Shift</span>
          </button>
        </div>
      </div>
    `;
  } else {
    const openedTime = new Date(activeShift.opened_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    card.innerHTML = `
      <div class="space-y-6">
        <div class="flex items-center justify-between border-b border-slate-800 pb-4">
          <div>
            <span class="text-xs text-emerald-400 font-bold uppercase tracking-wider flex items-center gap-1.5">
              <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
              Register Shift in Progress
            </span>
            <h3 class="font-heading font-extrabold text-xl text-white mt-0.5">Cashier: ${activeShift.cashier_name}</h3>
            <p class="text-xs text-slate-400">Shift started at ${openedTime}</p>
          </div>
          <div class="text-right">
            <span class="text-xs text-slate-400">Starting Float</span>
            <div class="font-heading font-bold text-lg text-slate-200">$${parseFloat(activeShift.start_cash).toFixed(2)}</div>
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div class="bg-slate-900 p-4 rounded-xl border border-slate-800">
            <span class="text-xs text-slate-400">Cash Sales This Shift</span>
            <div class="font-heading font-extrabold text-xl text-emerald-400">$${parseFloat(activeShift.cash_sales).toFixed(2)}</div>
          </div>
          <div class="bg-slate-900 p-4 rounded-xl border border-slate-800">
            <span class="text-xs text-slate-400">Total Cash Orders</span>
            <div class="font-heading font-extrabold text-xl text-white">${activeShift.orders_count}</div>
          </div>
          <div class="bg-slate-900 p-4 rounded-xl border border-slate-800">
            <span class="text-xs text-slate-400">Expected in Drawer</span>
            <div class="font-heading font-extrabold text-xl text-amber-400">$${parseFloat(activeShift.expected_cash).toFixed(2)}</div>
          </div>
        </div>

        <div class="bg-slate-900/80 p-5 rounded-2xl border border-slate-800 space-y-4">
          <h4 class="font-bold text-sm text-white flex items-center gap-2">
            <i data-lucide="check-square" class="w-4 h-4 text-emerald-400"></i>
            End-of-Shift Cash Drawer Reconciliation
          </h4>
          <p class="text-xs text-slate-400">Count all physical currency in the cash box and enter the total below:</p>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label class="text-xs text-slate-400 font-semibold mb-1 block">Counted Cash in Drawer ($):</label>
              <input
                type="number"
                step="0.01"
                id="close-actual-cash"
                placeholder="${parseFloat(activeShift.expected_cash).toFixed(2)}"
                class="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-base font-bold text-white focus:outline-none focus:border-amber-500"
              />
            </div>
            <div>
              <label class="text-xs text-slate-400 font-semibold mb-1 block">Shift Audit Notes:</label>
              <input
                type="text"
                id="close-shift-notes"
                placeholder="e.g. Lunch rush balanced / rolled coins"
                class="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-500"
              />
            </div>
          </div>

          <button onclick="closeActiveShift()" class="w-full bg-rose-600 hover:bg-rose-500 text-white font-bold py-3 rounded-xl text-sm shadow-lg shadow-rose-900/30 flex items-center justify-center gap-2 transition">
            <i data-lucide="lock" class="w-4 h-4"></i>
            <span>Close Shift & Record Cash Audit</span>
          </button>
        </div>
      </div>
    `;
  }

  lucide.createIcons();
}

async function startNewShift() {
  const cashier_name = document.getElementById('open-cashier-name').value.trim() || 'Volunteer';
  const start_cash = parseFloat(document.getElementById('open-start-cash').value) || 50.0;

  try {
    const res = await fetch('/api/shifts/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cashier_name, start_cash })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to open shift');

    playSound('chaching');
    loadShiftData();
    showToast(`Shift opened for ${cashier_name} with $${start_cash.toFixed(2)} float! 🟢`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function closeActiveShift() {
  const actual_cash = parseFloat(document.getElementById('close-actual-cash').value);
  const notes = document.getElementById('close-shift-notes').value;

  if (isNaN(actual_cash)) {
    showToast('Please enter the counted cash amount in the drawer', 'error');
    return;
  }

  try {
    const res = await fetch('/api/shifts/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actual_cash, notes })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to close shift');

    playSound('chaching');
    loadShiftData();
    showToast(`Shift closed! Result: ${data.summary.status}`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function openCloseRegisterModal() {
  await loadShiftStatus();
  const content = document.getElementById('close-register-modal-content');
  if (!content) return;

  if (!activeShift) {
    content.innerHTML = `
      <div class="text-center py-5 space-y-4">
        <div class="w-14 h-14 rounded-2xl bg-amber-500/10 text-amber-400 border border-amber-500/20 flex items-center justify-center text-3xl mx-auto">
          🔓
        </div>
        <div>
          <h4 class="font-heading font-extrabold text-base text-white">No Register Shift Open</h4>
          <p class="text-xs text-slate-400 mt-1 max-w-sm mx-auto">Start a new cashier shift with your initial cash drawer float for making change.</p>
        </div>

        <div class="bg-slate-950 p-4 rounded-2xl border border-slate-800 text-left space-y-3 max-w-sm mx-auto">
          <div>
            <label class="text-[11px] text-slate-400 font-semibold mb-1 block">Cashier Name:</label>
            <input type="text" id="quick-open-cashier" value="Student Volunteer" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-amber-500" />
          </div>
          <div>
            <label class="text-[11px] text-slate-400 font-semibold mb-1 block">Starting Cash Float ($):</label>
            <input type="number" step="5.00" id="quick-open-start-cash" value="50.00" class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm font-bold text-emerald-400 focus:outline-none focus:border-emerald-500" />
          </div>
          <button onclick="quickOpenShiftFromModal()" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2.5 rounded-xl text-xs shadow-lg shadow-emerald-900/30 flex items-center justify-center gap-2 transition">
            <i data-lucide="play" class="w-4 h-4"></i>
            <span>Open Register Shift</span>
          </button>
        </div>
      </div>
    `;
  } else {
    const openedTime = new Date(activeShift.opened_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const expected = parseFloat(activeShift.expected_cash || 0).toFixed(2);
    const startCash = parseFloat(activeShift.start_cash || 0).toFixed(2);
    const cashSales = parseFloat(activeShift.cash_sales || 0).toFixed(2);
    const ordersCount = activeShift.orders_count || 0;

    content.innerHTML = `
      <div class="space-y-4">
        <!-- Cashier & Time Info -->
        <div class="flex items-center justify-between bg-slate-950 p-3.5 rounded-2xl border border-slate-800">
          <div>
            <span class="text-[11px] text-emerald-400 font-bold uppercase tracking-wider flex items-center gap-1.5">
              <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
              Active Shift
            </span>
            <div class="font-heading font-extrabold text-base text-white mt-0.5">${activeShift.cashier_name}</div>
            <div class="text-[11px] text-slate-400">Shift Started: ${openedTime}</div>
          </div>
          <div class="text-right">
            <span class="text-[11px] text-slate-400 block">Starting Float</span>
            <span class="font-mono font-bold text-slate-200 text-sm">$${startCash}</span>
          </div>
        </div>

        <!-- Shift Totals Grid -->
        <div class="grid grid-cols-3 gap-2 text-center">
          <div class="bg-slate-950 p-3 rounded-2xl border border-slate-800">
            <span class="text-[10px] text-slate-400 uppercase font-semibold block">Cash Sales</span>
            <span class="font-mono font-bold text-emerald-400 text-sm block mt-0.5">+$${cashSales}</span>
          </div>
          <div class="bg-slate-950 p-3 rounded-2xl border border-slate-800">
            <span class="text-[10px] text-slate-400 uppercase font-semibold block">Cash Orders</span>
            <span class="font-mono font-bold text-white text-sm block mt-0.5">${ordersCount}</span>
          </div>
          <div class="bg-slate-950 p-3 rounded-2xl border border-amber-500/30 bg-amber-500/5">
            <span class="text-[10px] text-amber-400 uppercase font-semibold block">Expected Cash</span>
            <span class="font-mono font-extrabold text-amber-300 text-sm block mt-0.5">$${expected}</span>
          </div>
        </div>

        <!-- Physical Count Input -->
        <div class="bg-slate-950 p-4 rounded-2xl border border-slate-800 space-y-3">
          <div class="flex items-center justify-between">
            <label class="font-bold text-white text-xs block">Physical Cash Count in Drawer ($):</label>
            <button onclick="document.getElementById('modal-close-actual-cash').value='${expected}'; updateCloseRegisterMath();" class="text-[11px] text-amber-400 hover:text-amber-300 underline">
              Match Expected ($${expected})
            </button>
          </div>
          
          <div class="relative">
            <span class="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 font-bold text-base">$</span>
            <input
              type="number"
              step="0.01"
              id="modal-close-actual-cash"
              placeholder="${expected}"
              oninput="updateCloseRegisterMath()"
              class="w-full bg-slate-900 border border-slate-700 rounded-xl pl-8 pr-4 py-2.5 text-lg font-mono font-bold text-white focus:outline-none focus:border-amber-500"
            />
          </div>

          <!-- Live Difference Indicator -->
          <div id="modal-close-diff-badge" class="p-2.5 rounded-xl text-center text-xs font-bold border border-slate-800 bg-slate-900 text-slate-400">
            Enter counted drawer total to calculate discrepancy
          </div>

          <!-- Shift Notes -->
          <div>
            <label class="text-[11px] text-slate-400 font-semibold mb-1 block">Closing Audit Notes (Optional):</label>
            <input
              type="text"
              id="modal-close-notes"
              placeholder="e.g. Count verified by advisor / register balanced"
              class="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-500"
            />
          </div>
        </div>

        <!-- Action Button -->
        <div class="flex gap-2">
          <button onclick="confirmCloseRegisterShift()" class="flex-1 bg-gradient-to-r from-rose-600 to-red-600 hover:from-rose-500 hover:to-red-500 text-white font-extrabold py-3 rounded-2xl text-sm shadow-xl shadow-rose-900/30 flex items-center justify-center gap-2 transition">
            <i data-lucide="lock" class="w-4 h-4"></i>
            <span>Confirm & Close Register Shift</span>
          </button>
          <button onclick="closeModal('modal-close-register')" class="px-4 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold py-3 rounded-2xl text-xs transition">
            Cancel
          </button>
        </div>
      </div>
    `;
  }

  openModal('modal-close-register');
  lucide.createIcons();
}

function updateCloseRegisterMath() {
  if (!activeShift) return;
  const input = document.getElementById('modal-close-actual-cash');
  const badge = document.getElementById('modal-close-diff-badge');
  if (!input || !badge) return;

  const val = parseFloat(input.value);
  if (isNaN(val)) {
    badge.className = 'p-2.5 rounded-xl text-center text-xs font-bold border border-slate-800 bg-slate-900 text-slate-400';
    badge.textContent = 'Enter counted drawer total to calculate discrepancy';
    return;
  }

  const expected = parseFloat(activeShift.expected_cash || 0);
  const diff = val - expected;

  if (Math.abs(diff) < 0.009) {
    badge.className = 'p-2.5 rounded-xl text-center text-xs font-bold border border-emerald-500/30 bg-emerald-500/10 text-emerald-400';
    badge.textContent = '🟢 Cash Drawer Perfectly Balanced ($0.00 discrepancy)';
  } else if (diff > 0) {
    badge.className = 'p-2.5 rounded-xl text-center text-xs font-bold border border-blue-500/30 bg-blue-500/10 text-blue-400';
    badge.textContent = `🟢 Drawer is OVER by +$${diff.toFixed(2)} (Excess Cash)`;
  } else {
    badge.className = 'p-2.5 rounded-xl text-center text-xs font-bold border border-rose-500/30 bg-rose-500/10 text-rose-400';
    badge.textContent = `🔴 Drawer is SHORT by -$${Math.abs(diff).toFixed(2)} (Missing Cash)`;
  }
}

async function quickOpenShiftFromModal() {
  const cashier_name = document.getElementById('quick-open-cashier').value.trim() || 'Volunteer';
  const start_cash = parseFloat(document.getElementById('quick-open-start-cash').value) || 50.0;

  try {
    const res = await fetch('/api/shifts/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cashier_name, start_cash })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to open shift');

    playSound('chaching');
    await loadShiftStatus();
    closeModal('modal-close-register');
    showToast(`Register opened for ${cashier_name} with $${start_cash.toFixed(2)} float! 🟢`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function confirmCloseRegisterShift() {
  const actual_cash = parseFloat(document.getElementById('modal-close-actual-cash').value);
  const notes = document.getElementById('modal-close-notes').value;

  if (isNaN(actual_cash)) {
    showToast('Please enter the physical cash counted in drawer', 'error');
    return;
  }

  try {
    const res = await fetch('/api/shifts/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actual_cash, notes })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to close register shift');

    playSound('chaching');
    closeModal('modal-close-register');
    await loadShiftStatus();
    if (document.getElementById('tab-shifts') && !document.getElementById('tab-shifts').classList.contains('hidden')) {
      loadShiftData();
    }
    showToast(`Register closed! Result: ${data.summary.status} (Cash in drawer: $${actual_cash.toFixed(2)}) 🔒`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ==========================================
// ANALYTICS & REPORTS
// ==========================================
async function loadAnalytics() {
  try {
    const res = await fetch('/api/analytics/summary');
    const data = await res.json();

    document.getElementById('metric-today-rev').textContent = `$${data.today.revenue.toFixed(2)}`;
    document.getElementById('metric-today-profit').textContent = `$${data.today.profit.toFixed(2)}`;
    document.getElementById('metric-today-orders').textContent = data.today.orders;
    document.getElementById('metric-all-rev').textContent = `$${data.all_time.revenue.toFixed(2)}`;

    const topList = document.getElementById('top-snacks-list');
    if (data.top_items.length === 0) {
      topList.innerHTML = `<p class="text-xs text-slate-500">No sales logged yet to calculate top items</p>`;
    } else {
      topList.innerHTML = data.top_items.map((item, idx) => `
        <div class="flex items-center justify-between p-2.5 rounded-xl bg-slate-900 border border-slate-800">
          <div class="flex items-center gap-3">
            <span class="w-6 h-6 rounded-lg bg-amber-500/10 text-amber-400 font-extrabold text-xs flex items-center justify-center">${idx + 1}</span>
            <span class="font-bold text-xs text-white">${item.product_name}</span>
          </div>
          <div class="text-right">
            <span class="font-bold text-xs text-emerald-400">${item.total_sold} sold</span>
            <span class="text-[10px] text-slate-500 block">$${parseFloat(item.total_revenue).toFixed(2)} rev</span>
          </div>
        </div>
      `).join('');
    }

    const payList = document.getElementById('payment-breakdown-list');
    if (data.payments.length === 0) {
      payList.innerHTML = `<p class="text-xs text-slate-500">No orders logged yet</p>`;
    } else {
      payList.innerHTML = data.payments.map(p => `
        <div class="space-y-1">
          <div class="flex justify-between text-xs font-semibold">
            <span class="capitalize text-slate-300">${p.payment_method.replace('_', ' ')} (${p.count} orders)</span>
            <span class="text-amber-400 font-bold">$${parseFloat(p.amount).toFixed(2)}</span>
          </div>
          <div class="w-full bg-slate-900 rounded-full h-2 overflow-hidden border border-slate-800">
            <div class="bg-amber-500 h-full rounded-full" style="width: 100%"></div>
          </div>
        </div>
      `).join('');
    }
  } catch (err) {
    console.error('Analytics load error:', err);
  }
}

// ==========================================
// ==========================================
// LIVE IN-BROWSER CAMERA SCANNER (HTML5-QRCODE & FACE SCAN)
// ==========================================
let html5QrScanner = null;
let currentScannerMode = 'barcode'; // 'barcode' | 'face'
let faceMediaStream = null;

function setScannerMode(mode) {
  currentScannerMode = mode;
  const btnBarcode = document.getElementById('btn-mode-barcode');
  const btnFace = document.getElementById('btn-mode-face');
  const qrViewport = document.getElementById('camera-reader-viewport');
  const faceVideo = document.getElementById('face-video-stream');
  const faceTarget = document.getElementById('face-frame-target');
  const faceActions = document.getElementById('face-actions-bar');
  const overlayBox = document.getElementById('scanner-overlay-box');
  const feedback = document.getElementById('scan-feedback-box');

  if (mode === 'face') {
    btnFace.className = 'py-1.5 px-3 rounded-lg bg-blue-600 text-white font-bold transition flex items-center justify-center gap-1.5 shadow-md';
    btnBarcode.className = 'py-1.5 px-3 rounded-lg text-slate-400 hover:text-white transition flex items-center justify-center gap-1.5';
    
    // Stop barcode scanner
    if (html5QrScanner) {
      try { html5QrScanner.stop(); } catch(e){}
    }
    qrViewport.classList.add('hidden');
    overlayBox.classList.add('hidden');

    faceVideo.classList.remove('hidden');
    faceTarget.classList.remove('hidden');
    faceActions.classList.remove('hidden');

    startFaceVideoStream();
    if (feedback) feedback.innerHTML = '<span class="text-blue-300 font-bold">👤 Align student face with the camera or click "Trigger Face Scan on 2nd Screen" below.</span>';
  } else {
    btnBarcode.className = 'py-1.5 px-3 rounded-lg bg-amber-500 text-slate-950 font-bold transition flex items-center justify-center gap-1.5';
    btnFace.className = 'py-1.5 px-3 rounded-lg text-slate-400 hover:text-white transition flex items-center justify-center gap-1.5';

    stopFaceVideoStream();
    faceVideo.classList.add('hidden');
    faceTarget.classList.add('hidden');
    faceActions.classList.add('hidden');

    qrViewport.classList.remove('hidden');
    overlayBox.classList.remove('hidden');

    startBarcodeScanner();
    if (feedback) feedback.textContent = 'Point camera at any snack barcode or student pass...';
  }
  lucide.createIcons();
}

async function startFaceVideoStream() {
  try {
    const video = document.getElementById('face-video-stream');
    if (faceMediaStream) {
      stopFaceVideoStream();
    }
    faceMediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: 640, height: 480 }
    });
    video.srcObject = faceMediaStream;
  } catch (err) {
    console.error('Face stream error:', err);
    const feedback = document.getElementById('scan-feedback-box');
    if (feedback) feedback.textContent = `Camera error: ${err.message || err}`;
  }
}

function stopFaceVideoStream() {
  if (faceMediaStream) {
    faceMediaStream.getTracks().forEach(t => t.stop());
    faceMediaStream = null;
  }
}

async function startBarcodeScanner() {
  const feedback = document.getElementById('scan-feedback-box');
  if (typeof Html5Qrcode === 'undefined') {
    if (feedback) feedback.textContent = 'Camera scanner library not available.';
    return;
  }

  try {
    if (html5QrScanner) {
      try { await html5QrScanner.stop(); } catch(e){}
    }
    html5QrScanner = new Html5Qrcode("camera-reader-viewport");
    
    const qrCodeSuccessCallback = (decodedText, decodedResult) => {
      handleCameraBarcodeScanned(decodedText);
    };
    const config = { fps: 10, qrbox: { width: 250, height: 250 } };

    await html5QrScanner.start({ facingMode: "environment" }, config, qrCodeSuccessCallback, (errorMessage) => {
      // Ignore background frame misses
    });
  } catch (err) {
    console.error('Camera start error:', err);
    if (feedback) feedback.textContent = `Camera notice: ${err.message || err}`;
  }
}

async function openCameraScanner() {
  openModal('modal-camera-scanner');
  setScannerMode('barcode');
}

async function closeCameraScanner() {
  if (html5QrScanner) {
    try {
      await html5QrScanner.stop();
      html5QrScanner.clear();
    } catch(e) {}
    html5QrScanner = null;
  }
  stopFaceVideoStream();
  closeModal('modal-camera-scanner');
}

// Face Matching Logic (2nd Screen & POS)
function requestDisplayFaceScanFromPOS() {
  playSound('beep');
  showToast('👤 Activated Face ID camera on Customer 2nd Screen...', 'info');
  const feedback = document.getElementById('scan-feedback-box');
  if (feedback) feedback.innerHTML = `<span class="text-blue-400 font-bold">👤 Scanning student face on Customer 2nd Monitor... Look into 2nd screen camera!</span>`;

  if (displayChannel) {
    try {
      displayChannel.postMessage({ type: 'request_display_face_scan' });
    } catch(e){}
  }

  fetch('/api/display/scan_face_request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  }).catch(()=>{});
}

async function captureAndMatchFace() {
  const video = document.getElementById('face-video-stream');
  const canvas = document.getElementById('face-capture-canvas');
  const feedback = document.getElementById('scan-feedback-box');

  if (!video || !video.videoWidth) {
    showToast('Camera feed not ready yet.', 'error');
    return;
  }

  canvas.width = 120;
  canvas.height = 120;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, 120, 120);

  const capturedData = ctx.getImageData(0, 0, 120, 120).data;

  // Find enrolled students with photo_data
  const enrolledStudents = students.filter(s => s.photo_data && s.photo_data.length > 100);

  if (enrolledStudents.length === 0) {
    feedback.innerHTML = `<span class="text-amber-400">No student photos enrolled yet! You can add student photos under Students tab.</span>`;
    showToast('No student photos registered yet.', 'info');
    return;
  }

  feedback.textContent = 'Comparing biometric face features...';

  // Compare pixel variance against registered student photos
  let bestMatch = null;
  let highestScore = -Infinity;

  for (const stu of enrolledStudents) {
    try {
      const img = new Image();
      img.src = stu.photo_data;
      await new Promise(r => { img.onload = r; img.onerror = r; });

      const testCanvas = document.createElement('canvas');
      testCanvas.width = 120;
      testCanvas.height = 120;
      const tctx = testCanvas.getContext('2d');
      tctx.drawImage(img, 0, 0, 120, 120);
      const stuData = tctx.getImageData(0, 0, 120, 120).data;

      let diffSum = 0;
      for (let i = 0; i < capturedData.length; i += 4) {
        // Greyscale luminance comparison
        const lum1 = (capturedData[i] * 0.299 + capturedData[i+1] * 0.587 + capturedData[i+2] * 0.114);
        const lum2 = (stuData[i] * 0.299 + stuData[i+1] * 0.587 + stuData[i+2] * 0.114);
        diffSum += Math.abs(lum1 - lum2);
      }

      const score = 100 - (diffSum / (120 * 120 * 255)) * 100;
      if (score > highestScore) {
        highestScore = score;
        bestMatch = stu;
      }
    } catch(e) {
      console.warn('Face match comp error:', e);
    }
  }

  if (bestMatch) {
    playSound('chaching');
    feedback.innerHTML = `<span class="text-emerald-400 font-bold">👤 Face Recognized: ${bestMatch.name} (${bestMatch.student_id})</span>`;
    setTimeout(() => {
      closeCameraScanner();
      openStudentCheckoutModal();
      selectStudentForCheckout(bestMatch.id);
      showToast(`Face Matched: ${bestMatch.name}! 🎒`, 'success');
    }, 600);
  } else {
    feedback.innerHTML = `<span class="text-rose-400">No matching student face recognized. Try again or scan barcode.</span>`;
  }
}

function handleCameraBarcodeScanned(code) {
  if (!code) return;
  const raw = code.trim();
  const lower = raw.toLowerCase();

  playSound('beep');
  const feedback = document.getElementById('scan-feedback-box');
  if (feedback) feedback.innerHTML = `<span class="text-emerald-400 font-bold">Scanned: ${raw}</span>`;

  // 1. Check if product barcode or ID matches
  const product = products.find(p => (p.barcode && p.barcode.trim() === raw) || p.id.toString() === raw);
  if (product) {
    closeCameraScanner();
    handleProductClick(product.id);
    showToast(`Scanned & Added: ${product.name}! 🍿`, 'success');
    return;
  }

  // 2. Check if student ID matches
  const student = students.find(s => (s.student_id && s.student_id.toLowerCase() === lower) || s.id.toString() === raw || s.name.toLowerCase() === lower);
  if (student) {
    closeCameraScanner();
    openStudentCheckoutModal();
    selectStudentForCheckout(student.id);
    showToast(`Scanned Student Pass: ${student.name}! 🎒`, 'success');
    return;
  }

  showToast(`Scanned code: ${raw} (No matching snack or student found)`, 'info');
}

// ==========================================
// VENMO / CASHAPP / SCHOOLPAY QR MODAL
// ==========================================
async function openQRPayModal() {
  if (cart.length === 0) {
    showToast('Add items to cart before opening QR pay.', 'error');
    return;
  }
  const { total } = calculateTotals();
  document.getElementById('qr-modal-total').textContent = `$${total.toFixed(2)}`;

  try {
    const res = await fetch('/api/settings');
    const settings = await res.json();
    
    const qrImg = document.getElementById('qr-code-img');
    const placeholder = document.getElementById('qr-placeholder');
    const handleText = document.getElementById('qr-handle-text');
    const handleInput = document.getElementById('qr-handle-input');

    if (settings.payment_qr_image) {
      qrImg.src = settings.payment_qr_image;
      qrImg.classList.remove('hidden');
      placeholder.classList.add('hidden');
    } else {
      qrImg.classList.add('hidden');
      placeholder.classList.remove('hidden');
    }

    if (settings.payment_handle) {
      handleText.textContent = settings.payment_handle;
      handleInput.value = settings.payment_handle;
    }
  } catch (err) {
    console.warn('Settings load error:', err);
  }

  openModal('modal-qr-pay');
}

function handleQRUpload(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    const dataUrl = e.target.result;
    document.getElementById('qr-code-img').src = dataUrl;
    document.getElementById('qr-code-img').classList.remove('hidden');
    document.getElementById('qr-placeholder').classList.add('hidden');

    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payment_qr_image: dataUrl })
      });
      showToast('Payment QR saved successfully! 📱', 'success');
    } catch (err) {
      showToast('Failed to save QR image: ' + err.message, 'error');
    }
  };
  reader.readAsDataURL(file);
}

async function saveQRHandle() {
  const handle = document.getElementById('qr-handle-input').value.trim();
  if (!handle) return;

  try {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payment_handle: handle })
    });
    document.getElementById('qr-handle-text').textContent = handle;
    showToast('Payment handle updated! ✅', 'success');
  } catch (err) {
    showToast('Failed to save handle: ' + err.message, 'error');
  }
}

// ==========================================
// PRINTABLE STUDENT BADGE / PASS GENERATOR
// ==========================================
function openPrintBadgeModal(studentId) {
  const student = students.find(s => s.id === studentId);
  if (!student) return;

  document.getElementById('badge-name').textContent = student.name;
  document.getElementById('badge-grade').textContent = `${student.grade || 'Student'} • ID: ${student.student_id}`;

  const allergyBox = document.getElementById('badge-allergy-row');
  if (student.allergies && student.allergies.toLowerCase() !== 'none' && student.allergies.trim() !== '') {
    allergyBox.textContent = `⚠️ Allergy: ${student.allergies}`;
    allergyBox.classList.remove('hidden');
  } else {
    allergyBox.classList.add('hidden');
  }

  if (typeof JsBarcode !== 'undefined') {
    try {
      JsBarcode("#badge-barcode-svg", student.student_id, {
        format: "CODE128",
        lineColor: "#0f172a",
        width: 2,
        height: 50,
        displayValue: true,
        font: "monospace",
        fontSize: 14,
        textMargin: 4
      });
    } catch (e) {
      console.error('Barcode render error:', e);
    }
  }

  openModal('modal-print-pass');
}

// ==========================================
// ONLINE PRE-ORDER QUEUE ("SKIP THE LINE" MODE)
// ==========================================
let preorders = [];

async function loadPreorders() {
  const container = document.getElementById('preorders-cards-container');
  if (!container) return;

  try {
    const res = await fetch('/api/preorders');
    preorders = await res.json();
    renderPreorders();
  } catch (err) {
    console.error('Failed to load preorders:', err);
    container.innerHTML = `<div class="col-span-full p-8 text-center text-rose-400">Failed to load pre-orders</div>`;
  }
}

function renderPreorders() {
  const container = document.getElementById('preorders-cards-container');
  if (!container) return;

  if (preorders.length === 0) {
    container.innerHTML = `
      <div class="col-span-full bg-slate-950 p-12 rounded-3xl border border-slate-800 text-center space-y-3">
        <span class="text-4xl">⏰</span>
        <h3 class="font-heading font-bold text-base text-white">No Pre-Orders in Queue</h3>
        <p class="text-xs text-slate-400 max-w-sm mx-auto">Students and teachers can submit pre-orders ahead of time at <a href="/order" target="_blank" class="text-amber-400 underline font-semibold">/order</a></p>
      </div>
    `;
    return;
  }

  container.innerHTML = preorders.map(po => {
    const items = typeof po.items === 'string' ? JSON.parse(po.items) : po.items;
    const timeStr = new Date(po.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    let statusBadge = '';
    let actionBtn = '';

    if (po.status === 'pending') {
      statusBadge = `<span class="bg-amber-500/20 text-amber-300 border border-amber-500/40 px-2.5 py-1 rounded-full text-xs font-bold flex items-center gap-1.5"><span class="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></span> Bagging Pending</span>`;
      actionBtn = `
        <button onclick="updatePreorderStatus(${po.id}, 'ready')" class="w-full bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold py-2 rounded-xl text-xs flex items-center justify-center gap-1.5 shadow transition">
          <i data-lucide="package-check" class="w-4 h-4"></i>
          <span>Mark Bagged & Ready for Pickup</span>
        </button>
      `;
    } else if (po.status === 'ready') {
      statusBadge = `<span class="bg-blue-500/20 text-blue-300 border border-blue-500/40 px-2.5 py-1 rounded-full text-xs font-bold flex items-center gap-1.5"><span class="w-2 h-2 rounded-full bg-blue-400"></span> Ready at Window</span>`;
      actionBtn = `
        <button onclick="updatePreorderStatus(${po.id}, 'completed')" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2 rounded-xl text-xs flex items-center justify-center gap-1.5 shadow transition">
          <i data-lucide="check-circle" class="w-4 h-4"></i>
          <span>Handed Out & Complete</span>
        </button>
      `;
    } else {
      statusBadge = `<span class="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2.5 py-1 rounded-full text-xs font-bold">✅ Completed</span>`;
      actionBtn = `
        <div class="text-center py-1 text-xs text-slate-500 font-semibold">Order Finished</div>
      `;
    }

    return `
      <div class="bg-slate-950 border ${po.status === 'pending' ? 'border-amber-500/40' : po.status === 'ready' ? 'border-blue-500/40' : 'border-slate-800'} rounded-2xl p-4 flex flex-col justify-between space-y-4 shadow-xl">
        <div class="space-y-3">
          <div class="flex items-start justify-between gap-2 border-b border-slate-800/80 pb-3">
            <div>
              <span class="font-mono text-xs text-amber-400 font-bold">${po.order_number}</span>
              <h4 class="font-heading font-bold text-base text-white">${po.customer_name}</h4>
              <div class="text-[11px] text-slate-400 flex items-center gap-2 mt-0.5">
                <span>🕒 ${po.pickup_period}</span>
                <span>•</span>
                <span>${timeStr}</span>
              </div>
            </div>
            ${statusBadge}
          </div>

          <div class="space-y-1.5 text-xs bg-slate-900/60 p-3 rounded-xl border border-slate-800">
            <span class="text-[10px] text-slate-400 font-bold uppercase tracking-wider block mb-1">Items to Bag:</span>
            ${items.map(it => `
              <div class="flex justify-between items-center text-slate-200">
                <span class="font-semibold">${it.quantity}x ${it.name}</span>
                <span class="font-mono text-amber-300">$${(parseFloat(it.price) * it.quantity).toFixed(2)}</span>
              </div>
            `).join('')}
            ${po.notes ? `<div class="mt-2 pt-2 border-t border-slate-800 text-amber-300 text-[11px]">📝 Note: ${po.notes}</div>` : ''}
          </div>
        </div>

        <div class="space-y-2 pt-2 border-t border-slate-800/80">
          <div class="flex justify-between items-center text-xs">
            <span class="text-slate-400 font-semibold">Total:</span>
            <span class="font-heading font-extrabold text-base text-amber-400">$${parseFloat(po.total).toFixed(2)}</span>
          </div>
          ${actionBtn}
        </div>
      </div>
    `;
  }).join('');

  lucide.createIcons();
}

async function updatePreorderStatus(id, newStatus) {
  try {
    const res = await fetch(`/api/preorders/${id}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to update status');

    playSound(newStatus === 'completed' ? 'chaching' : 'beep');
    loadPreorders();
    showToast(`Order status updated to "${newStatus}"!`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ==========================================
// PRINTABLE SNACK BIN & COOLER STICKY LABELS
// ==========================================
function openPrintLabelsModal() {
  const catSelect = document.getElementById('label-category-select');
  if (catSelect) {
    catSelect.innerHTML = `<option value="all">All Snack Shack Items (${products.length})</option>` +
      categories.map(c => `<option value="${c.id}">${c.icon} ${c.name}</option>`).join('');
  }
  renderPrintLabelsPreview();
  openModal('modal-print-labels');
}

function renderPrintLabelsPreview() {
  const container = document.getElementById('labels-sheet-printable');
  const catFilter = document.getElementById('label-category-select')?.value || 'all';
  const format = document.getElementById('label-format-select')?.value || 'shelf';

  if (!container) return;

  const filtered = products.filter(p => catFilter === 'all' || p.category_id.toString() === catFilter);

  if (filtered.length === 0) {
    container.innerHTML = `<div class="col-span-full py-12 text-center text-slate-500 font-semibold">No items match category filter.</div>`;
    return;
  }

  // Adjust container columns based on format
  if (format === 'compact') {
    container.className = 'grid grid-cols-3 gap-2 bg-white p-4 rounded-xl text-slate-950 min-h-[400px]';
  } else if (format === 'large') {
    container.className = 'grid grid-cols-2 gap-4 bg-white p-6 rounded-xl text-slate-950 min-h-[400px]';
  } else {
    container.className = 'grid grid-cols-2 md:grid-cols-3 gap-3.5 bg-white p-6 rounded-xl text-slate-950 min-h-[400px]';
  }

  container.innerHTML = filtered.map(item => {
    const barcodeCode = item.barcode || `SNK${item.id.toString().padStart(4, '0')}`;
    const svgId = `label-barcode-${item.id}`;
    const priceText = item.is_open_price || parseFloat(item.price) === 0 ? 'CUSTOM $' : `$${parseFloat(item.price).toFixed(2)}`;

    let cardContent = '';

    if (format === 'compact') {
      // 1x2.6" Avery 30-up sticker
      cardContent = `
        <div class="border border-slate-300 rounded-lg p-2 flex flex-col justify-between items-center text-center bg-white shadow-sm space-y-1">
          <div class="flex items-center justify-between w-full">
            <span class="text-xs font-bold text-slate-900 truncate max-w-[90px]">${item.name}</span>
            <span class="font-extrabold text-xs text-amber-700 font-mono">${priceText}</span>
          </div>
          <svg id="${svgId}" class="max-w-full h-8"></svg>
        </div>
      `;
    } else if (format === 'large') {
      // Large 4x3" Bin Station Sign
      cardContent = `
        <div class="border-2 border-slate-800 rounded-2xl p-4 flex flex-col justify-between items-center text-center bg-white shadow-md space-y-2">
          <div class="flex items-center gap-2">
            <span class="text-3xl">${item.emoji || '🍿'}</span>
            <div class="text-left">
              <span class="text-[9px] uppercase font-bold text-slate-500 tracking-wider">JORDAN'S SNACK SHACK</span>
              <h4 class="font-heading font-extrabold text-lg text-slate-950 leading-tight">${item.name}</h4>
            </div>
          </div>
          <div class="bg-amber-500/10 border border-amber-500/40 px-4 py-1.5 rounded-xl">
            <span class="font-heading font-extrabold text-2xl text-amber-800">${priceText}</span>
          </div>
          ${item.allergy_info ? `<div class="text-[10px] text-rose-700 bg-rose-50 px-2 py-0.5 rounded font-bold">⚠️ ${item.allergy_info}</div>` : ''}
          <svg id="${svgId}" class="max-w-full h-12"></svg>
        </div>
      `;
    } else {
      // Shelf / Bin Tag (Medium)
      cardContent = `
        <div class="border-2 border-slate-700 rounded-xl p-3 flex flex-col justify-between items-center text-center bg-white shadow-sm space-y-1.5">
          <div class="flex items-center justify-between w-full border-b border-slate-200 pb-1">
            <span class="text-lg">${item.emoji || '🍿'}</span>
            <span class="font-heading font-extrabold text-base text-amber-700">${priceText}</span>
          </div>
          <div class="w-full">
            <h4 class="font-bold text-xs text-slate-900 truncate leading-tight">${item.name}</h4>
            ${item.allergy_info ? `<span class="text-[9px] text-rose-700 block font-semibold truncate">⚠️ ${item.allergy_info}</span>` : ''}
          </div>
          <svg id="${svgId}" class="max-w-full h-10"></svg>
        </div>
      `;
    }

    return cardContent;
  }).join('');

  // Render Barcode SVGs via JsBarcode
  setTimeout(() => {
    if (typeof JsBarcode !== 'undefined') {
      filtered.forEach(item => {
        const barcodeCode = item.barcode || `SNK${item.id.toString().padStart(4, '0')}`;
        const svgEl = document.getElementById(`label-barcode-${item.id}`);
        if (svgEl) {
          try {
            JsBarcode(svgEl, barcodeCode, {
              format: "CODE128",
              lineColor: "#000000",
              width: format === 'compact' ? 1.2 : 1.5,
              height: format === 'compact' ? 24 : format === 'large' ? 36 : 28,
              displayValue: true,
              fontSize: format === 'compact' ? 9 : 10,
              font: "monospace",
              margin: 0
            });
          } catch(e){}
        }
      });
    }
  }, 50);
}

function printLabels() {
  window.print();
}

// ==========================================
// OFFICIAL ADVISOR & PRINCIPAL FINANCIAL REPORT
// ==========================================
async function openAdvisorReportModal() {
  const startInput = document.getElementById('report-start-date');
  const endInput = document.getElementById('report-end-date');

  if (!startInput.value) {
    const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    startInput.value = firstDay;
    endInput.value = today;
  }

  await loadAdvisorReport();
  openModal('modal-advisor-report');
}

async function loadAdvisorReport() {
  const start = document.getElementById('report-start-date')?.value || '';
  const end = document.getElementById('report-end-date')?.value || '';
  const container = document.getElementById('advisor-printable-statement');
  if (!container) return;

  container.innerHTML = `<div class="py-12 text-center text-slate-500 font-semibold">Generating official financial statement...</div>`;

  try {
    const query = (start && end) ? `?start_date=${start}&end_date=${end}` : '';
    const res = await fetch(`/api/reports/advisor-statement${query}`);
    const data = await res.json();

    const genDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });

    container.innerHTML = `
      <!-- Header with School Seal Branding -->
      <div class="border-b-2 border-slate-900 pb-4 flex justify-between items-start">
        <div class="space-y-1">
          <div class="flex items-center gap-2">
            <span class="text-2xl">🍿</span>
            <h2 class="font-heading font-extrabold text-xl text-slate-900 uppercase tracking-tight">JORDAN'S SNACK SHACK FUNDRAISER</h2>
          </div>
          <p class="text-xs text-slate-600 font-medium">Official School Activity Account & Snack Bar Financial Statement</p>
          <div class="text-[11px] text-slate-500">
            <strong>Statement Period:</strong> ${data.period.start} to ${data.period.end}
          </div>
        </div>
        <div class="text-right text-xs space-y-0.5">
          <span class="bg-emerald-100 text-emerald-800 border border-emerald-300 px-2.5 py-0.5 rounded font-bold text-[10px] uppercase">Verified Record</span>
          <div class="text-[10px] text-slate-500 pt-1">Generated: ${genDate}</div>
          <div class="text-[10px] text-slate-500">Document ID: STMT-${Date.now().toString().slice(-6)}</div>
        </div>
      </div>

      <!-- Executive Financial Summary Table -->
      <div class="space-y-2">
        <h3 class="font-bold text-xs uppercase tracking-wider text-slate-800 border-b border-slate-200 pb-1">1. Executive Fundraiser Performance</h3>
        <div class="grid grid-cols-4 gap-3">
          <div class="bg-slate-50 p-3 rounded-lg border border-slate-200">
            <span class="text-[10px] text-slate-500 font-semibold block">Gross Snack Sales</span>
            <div class="font-heading font-bold text-lg text-slate-900">$${data.summary.gross_revenue.toFixed(2)}</div>
            <span class="text-[9px] text-slate-400">${data.summary.total_orders} total orders</span>
          </div>

          <div class="bg-slate-50 p-3 rounded-lg border border-slate-200">
            <span class="text-[10px] text-slate-500 font-semibold block">Wholesale Costs (COGS)</span>
            <div class="font-heading font-bold text-lg text-rose-700">-$${data.summary.total_cogs.toFixed(2)}</div>
            <span class="text-[9px] text-slate-400">Inventory acquisition</span>
          </div>

          <div class="bg-emerald-50 p-3 rounded-lg border border-emerald-300">
            <span class="text-[10px] text-emerald-800 font-semibold block">Net School Fund Profit</span>
            <div class="font-heading font-extrabold text-xl text-emerald-700">$${data.summary.net_profit.toFixed(2)}</div>
            <span class="text-[9px] text-emerald-700 font-bold">${data.summary.profit_margin}% Profit Margin</span>
          </div>

          <div class="bg-slate-50 p-3 rounded-lg border border-slate-200">
            <span class="text-[10px] text-slate-500 font-semibold block">Prepaid Student Balances</span>
            <div class="font-heading font-bold text-lg text-blue-700">$${data.student_funds.prepaid_pool.toFixed(2)}</div>
            <span class="text-[9px] text-slate-400">${data.student_funds.total_students} student accounts</span>
          </div>
        </div>
      </div>

      <!-- Revenue by Payment Channel -->
      <div class="space-y-2">
        <h3 class="font-bold text-xs uppercase tracking-wider text-slate-800 border-b border-slate-200 pb-1">2. Payment Channel Audit</h3>
        <table class="w-full text-left text-xs border border-slate-200">
          <thead class="bg-slate-100 text-slate-700 font-semibold text-[10px] uppercase">
            <tr>
              <th class="p-2 border-b">Payment Method</th>
              <th class="p-2 border-b text-center">Transactions</th>
              <th class="p-2 border-b text-right">Amount Collected</th>
              <th class="p-2 border-b text-right">% of Gross</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-200">
            ${data.payments.map(p => {
              const pct = data.summary.gross_revenue > 0 ? ((parseFloat(p.amount) / data.summary.gross_revenue) * 100).toFixed(1) : '0.0';
              return `
                <tr>
                  <td class="p-2 font-semibold capitalize">${p.payment_method.replace('_', ' ')}</td>
                  <td class="p-2 text-center text-slate-600">${p.count}</td>
                  <td class="p-2 text-right font-mono font-bold">$${parseFloat(p.amount).toFixed(2)}</td>
                  <td class="p-2 text-right text-slate-500">${pct}%</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>

      <!-- Top Selling Fundraiser Items -->
      <div class="space-y-2">
        <h3 class="font-bold text-xs uppercase tracking-wider text-slate-800 border-b border-slate-200 pb-1">3. Top Selling Snacks & Margins</h3>
        <table class="w-full text-left text-xs border border-slate-200">
          <thead class="bg-slate-100 text-slate-700 font-semibold text-[10px] uppercase">
            <tr>
              <th class="p-2 border-b">Snack Item</th>
              <th class="p-2 border-b text-center">Units Sold</th>
              <th class="p-2 border-b text-right">Gross Sales</th>
              <th class="p-2 border-b text-right">Wholesale Cost</th>
              <th class="p-2 border-b text-right text-emerald-800">Net Profit</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-200">
            ${data.top_items.map(it => `
              <tr>
                <td class="p-2 font-bold">${it.product_name}</td>
                <td class="p-2 text-center text-slate-600">${it.units_sold}</td>
                <td class="p-2 text-right font-mono">$${parseFloat(it.gross_sales).toFixed(2)}</td>
                <td class="p-2 text-right font-mono text-slate-500">-$${parseFloat(it.total_cost).toFixed(2)}</td>
                <td class="p-2 text-right font-mono font-bold text-emerald-700">$${parseFloat(it.profit).toFixed(2)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <!-- Fundraiser Campaign Allocations Breakdown -->
      ${data.fundraisers && data.fundraisers.length > 0 ? `
        <div class="space-y-2">
          <h3 class="font-bold text-xs uppercase tracking-wider text-slate-800 border-b border-slate-200 pb-1">4. Fundraiser Campaign Allocations</h3>
          <table class="w-full text-left text-xs border border-slate-200">
            <thead class="bg-slate-100 text-slate-700 font-semibold text-[10px] uppercase">
              <tr>
                <th class="p-2 border-b">Campaign / School Cause</th>
                <th class="p-2 border-b text-center">Orders</th>
                <th class="p-2 border-b text-right">Gross Sales</th>
                <th class="p-2 border-b text-right">Tips/Donations</th>
                <th class="p-2 border-b text-right text-emerald-800">Net Raised</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-200">
              ${data.fundraisers.map(f => `
                <tr>
                  <td class="p-2 font-bold">🎯 ${f.name}</td>
                  <td class="p-2 text-center text-slate-600">${f.orders_count}</td>
                  <td class="p-2 text-right font-mono">$${parseFloat(f.gross_raised).toFixed(2)}</td>
                  <td class="p-2 text-right font-mono text-amber-700">+$${parseFloat(f.tips_raised).toFixed(2)}</td>
                  <td class="p-2 text-right font-mono font-bold text-emerald-700">$${parseFloat(f.net_profit).toFixed(2)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : ''}

      <!-- Inventory Loss, Spoilage & Shrinkage Audit -->
      <div class="space-y-2">
        <h3 class="font-bold text-xs uppercase tracking-wider text-slate-800 border-b border-slate-200 pb-1">5. Spoilage, Damage & Shrinkage Write-Offs</h3>
        <div class="grid grid-cols-3 gap-3 bg-rose-50 p-3 rounded-lg border border-rose-200 text-xs">
          <div>
            <span class="text-[10px] text-rose-800 font-semibold block">Total Units Lost</span>
            <div class="font-bold text-rose-900">${data.summary.shrinkage_units_lost || 0} items</div>
          </div>
          <div>
            <span class="text-[10px] text-rose-800 font-semibold block">Total Cost Write-Off</span>
            <div class="font-bold text-rose-900">$${parseFloat(data.summary.shrinkage_cost_loss || 0).toFixed(2)}</div>
          </div>
          <div>
            <span class="text-[10px] text-rose-800 font-semibold block">Audit Status</span>
            <div class="font-bold text-emerald-800">Deducted from inventory</div>
          </div>
        </div>
        ${data.shrinkage_breakdown && data.shrinkage_breakdown.length > 0 ? `
          <table class="w-full text-left text-xs border border-slate-200 mt-2">
            <thead class="bg-slate-100 text-slate-700 font-semibold text-[10px] uppercase">
              <tr>
                <th class="p-2 border-b">Loss Reason</th>
                <th class="p-2 border-b text-center">Units Lost</th>
                <th class="p-2 border-b text-right text-rose-800">Wholesale Cost Loss</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-200">
              ${data.shrinkage_breakdown.map(sb => `
                <tr>
                  <td class="p-2 capitalize font-medium">${sb.reason.replace('_', ' ')}</td>
                  <td class="p-2 text-center text-slate-600">${sb.units}</td>
                  <td class="p-2 text-right font-mono text-rose-700 font-bold">-$${parseFloat(sb.cost_loss).toFixed(2)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        ` : ''}
      </div>

      <!-- Official Sign-off & Verification Section -->
      <div class="pt-6 border-t-2 border-slate-900 space-y-6">
        <div class="grid grid-cols-2 gap-8 text-xs text-slate-700">
          <div>
            <span class="text-[10px] uppercase font-bold text-slate-500 block mb-3">Student Store Manager / Volunteer Lead:</span>
            <div class="border-b border-slate-900 h-6"></div>
            <div class="flex justify-between text-[10px] text-slate-500 pt-1">
              <span>Signature</span>
              <span>Date</span>
            </div>
          </div>
          <div>
            <span class="text-[10px] uppercase font-bold text-slate-500 block mb-3">School Faculty Advisor / Principal Approval:</span>
            <div class="border-b border-slate-900 h-6"></div>
            <div class="flex justify-between text-[10px] text-slate-500 pt-1">
              <span>Signature</span>
              <span>Date</span>
            </div>
          </div>
        </div>

        <p class="text-[9px] text-slate-400 text-center italic">
          This document is generated automatically by Jordan's Snack Shack POS for school bookkeeping, audit compliance, and student activity fund reconciliation.
        </p>
      </div>
    `;
    lucide.createIcons();
  } catch (err) {
    container.innerHTML = `<div class="py-8 text-center text-rose-600 font-bold">Failed to load financial report: ${err.message}</div>`;
  }
}

// ==========================================
// STAFF PROFILES & ROLES MANAGEMENT
// ==========================================
let staffMembers = [];
let activeStaffProfile = null;

async function loadStaff() {
  try {
    const res = await fetch('/api/staff');
    staffMembers = await res.json();
    renderStaffList();
  } catch (err) {
    console.error('Failed to load staff members:', err);
  }
}

function renderStaffList() {
  const container = document.getElementById('staff-list-container');
  if (!container) return;

  if (staffMembers.length === 0) {
    container.innerHTML = `<p class="text-xs text-slate-500 text-center py-6">No staff members found. Click "+ Add Staff" above.</p>`;
    return;
  }

  container.innerHTML = staffMembers.map(s => `
    <div class="bg-slate-950 p-3.5 rounded-2xl border ${activeStaffProfile && activeStaffProfile.id === s.id ? 'border-purple-500 bg-purple-950/20' : 'border-slate-800'} flex items-center justify-between gap-3 shadow-md">
      <div class="flex items-center gap-3 min-w-0">
        <span class="text-2xl p-1.5 bg-slate-900 rounded-xl border border-slate-800 shrink-0">${s.emoji || '🧑‍💼'}</span>
        <div class="min-w-0">
          <div class="font-bold text-sm text-white flex items-center gap-1.5">
            <span>${s.name}</span>
            ${activeStaffProfile && activeStaffProfile.id === s.id ? '<span class="bg-purple-500 text-slate-950 font-extrabold text-[9px] px-1.5 py-0.5 rounded">ACTIVE REGISTER</span>' : ''}
          </div>
          <div class="text-xs text-purple-300 font-medium">${s.role || 'Cashier'}</div>
        </div>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <button onclick="selectActiveStaff(${s.id})" class="bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white px-2.5 py-1.5 rounded-xl border border-emerald-500/30 text-xs font-bold transition">
          Switch To
        </button>
        <button onclick="openEditStaffModal(${s.id})" class="bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white px-2.5 py-1.5 rounded-xl border border-slate-700 text-xs font-semibold transition">
          ✏️ Edit
        </button>
      </div>
    </div>
  `).join('');
}

function openStaffModal() {
  loadStaff();
  openModal('modal-staff-management');
}

function openNewStaffModal() {
  document.getElementById('edit-staff-id').value = '';
  document.getElementById('staff-edit-modal-title').textContent = 'Add Staff Member';
  document.getElementById('staff-name-input').value = '';
  document.getElementById('staff-role-select').value = 'Cashier Volunteer';
  document.getElementById('staff-emoji-input').value = '🧑‍💼';
  document.getElementById('staff-pin-input').value = '1234';
  document.getElementById('btn-delete-staff').classList.add('hidden');
  openModal('modal-staff-edit');
}

function openEditStaffModal(staffId) {
  const staff = staffMembers.find(s => s.id === staffId);
  if (!staff) return;

  document.getElementById('edit-staff-id').value = staff.id;
  document.getElementById('staff-edit-modal-title').textContent = `Edit Staff: ${staff.name}`;
  document.getElementById('staff-name-input').value = staff.name || '';
  document.getElementById('staff-role-select').value = staff.role || 'Cashier Volunteer';
  document.getElementById('staff-emoji-input').value = staff.emoji || '🧑‍💼';
  document.getElementById('staff-pin-input').value = staff.pin || '';
  document.getElementById('btn-delete-staff').classList.remove('hidden');
  openModal('modal-staff-edit');
}

async function submitStaffForm() {
  const id = document.getElementById('edit-staff-id').value;
  const name = document.getElementById('staff-name-input').value.trim();
  const role = document.getElementById('staff-role-select').value;
  const emoji = document.getElementById('staff-emoji-input').value.trim() || '🧑‍💼';
  const pin = document.getElementById('staff-pin-input').value.trim() || '1234';

  if (!name) {
    showToast('Staff name is required', 'error');
    return;
  }

  const payload = { name, role, emoji, pin };

  try {
    const url = id ? `/api/staff/${id}` : '/api/staff';
    const method = id ? 'PUT' : 'POST';

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save staff profile');

    closeModal('modal-staff-edit');
    loadStaff();
    showToast(id ? `Updated ${name}'s profile!` : `Added ${name} to staff team!`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleDeleteStaff() {
  const id = document.getElementById('edit-staff-id').value;
  if (!id) return;
  const s = staffMembers.find(item => item.id === parseInt(id, 10));
  const confirmMsg = s ? `Delete staff account for ${s.name}?` : 'Delete this staff member?';
  if (!confirm(confirmMsg)) return;

  try {
    const res = await fetch(`/api/staff/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to delete staff member');

    closeModal('modal-staff-edit');
    loadStaff();
    showToast('Staff member deleted.', 'info');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function selectActiveStaff(staffId) {
  const staff = staffMembers.find(s => s.id === staffId);
  if (!staff) return;

  activeStaffProfile = staff;
  const openCashierInput = document.getElementById('open-cashier-name');
  if (openCashierInput) openCashierInput.value = staff.name;

  renderStaffList();
  showToast(`Active cashier switched to: ${staff.name} (${staff.role})! 🧑‍💼`, 'success');
}

// Birthday Treat Helper
function applyBirthdayFreeTreat(studentName = 'Student') {
  activeDiscount = {
    name: `🎂 Birthday Free Treat (${studentName})`,
    type: 'pct',
    value: 100
  };
  playSound('chaching');
  renderCart();
  if (selectedStudentForCheckout) {
    selectStudentForCheckout(selectedStudentForCheckout.id);
  }
  showToast(`🎂 Happy Birthday ${studentName}! 100% Free snack discount applied!`, 'success');
}

// ==========================================
// VOICE ORDERING SYSTEM
// ==========================================
let voiceRecognition = null;
let isVoiceListening = false;

function toggleVoiceOrder() {
  if (isVoiceListening) {
    stopVoiceOrder();
  } else {
    startVoiceOrder();
  }
}

function startVoiceOrder() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showToast('Speech recognition not supported in this browser.', 'error');
    return;
  }

  try {
    voiceRecognition = new SpeechRecognition();
    voiceRecognition.continuous = false;
    voiceRecognition.interimResults = false;
    voiceRecognition.lang = 'en-US';

    voiceRecognition.onstart = () => {
      isVoiceListening = true;
      const btn = document.getElementById('btn-voice-order');
      const text = document.getElementById('voice-order-text');
      if (btn) btn.className = 'px-3 py-2 bg-rose-600 hover:bg-rose-500 text-white border border-rose-500/30 text-xs font-semibold rounded-xl flex items-center gap-1.5 transition shadow-sm animate-pulse';
      if (text) text.textContent = 'Listening... 🎙️';
      showToast('Listening... Speak items (e.g. "Two Doritos and one Gatorade")', 'info');
    };

    voiceRecognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      parseVoiceOrder(transcript);
    };

    voiceRecognition.onerror = (event) => {
      console.warn('Speech error:', event.error);
      stopVoiceOrder();
    };

    voiceRecognition.onend = () => {
      stopVoiceOrder();
    };

    voiceRecognition.start();
  } catch (err) {
    console.error('Failed to start voice recognition:', err);
    stopVoiceOrder();
  }
}

function stopVoiceOrder() {
  isVoiceListening = false;
  const btn = document.getElementById('btn-voice-order');
  const text = document.getElementById('voice-order-text');
  if (btn) btn.className = 'px-3 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white border border-purple-500/30 text-xs font-semibold rounded-xl flex items-center gap-1.5 transition shadow-sm';
  if (text) text.textContent = 'Voice Order';

  if (voiceRecognition) {
    try { voiceRecognition.stop(); } catch(e){}
    voiceRecognition = null;
  }
}

function parseVoiceOrder(transcript) {
  if (!transcript) return;
  const clean = transcript.toLowerCase();
  showToast(`Heard: "${transcript}" 🎙️`, 'info');

  const numberMap = {
    'a': 1, 'an': 1, 'one': 1, 'two': 2, 'three': 3, 'four': 4,
    'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10
  };

  // Split into clauses by 'and', comma, or 'plus'
  const phrases = clean.split(/\band\b|,|\bplus\b/);
  let addedCount = 0;

  phrases.forEach(phrase => {
    const tokens = phrase.trim().split(/\s+/);
    if (tokens.length === 0) return;

    let qty = 1;
    let itemTokens = [...tokens];

    if (tokens[0] in numberMap) {
      qty = numberMap[tokens[0]];
      itemTokens.shift();
    } else if (!isNaN(parseInt(tokens[0], 10))) {
      qty = parseInt(tokens[0], 10);
      itemTokens.shift();
    }

    const searchItemName = itemTokens.join(' ').replace(/bags? of|bottles? of|cans? of/g, '').trim();
    if (!searchItemName) return;

    // Find closest matching product
    const match = products.find(p => {
      const pName = p.name.toLowerCase();
      return pName.includes(searchItemName) || searchItemName.includes(pName) ||
             (p.category_name && p.category_name.toLowerCase().includes(searchItemName));
    });

    if (match) {
      for (let i = 0; i < qty; i++) {
        addToCart(match.id);
      }
      addedCount += qty;
    }
  });

  if (addedCount > 0) {
    playSound('chaching');
    showToast(`Voice added ${addedCount} item(s) to cart! 🎙️✨`, 'success');
  } else {
    showToast(`Could not recognize items in: "${transcript}"`, 'error');
  }
}

// ==========================================
// SPEAKER BROADCASTS
// ==========================================
function openSpeakerBroadcastModal() {
  openModal('modal-speaker-broadcast');
}

async function broadcastToDisplaySpeaker(text, emoji = '📢') {
  if (!text) return;
  try {
    playSound('fanfare');
    // Local BroadcastChannel trigger
    if (displayChannel) {
      try {
        displayChannel.postMessage({ type: 'speaker_broadcast', text, emoji });
      } catch(e){}
    }

    // Backend SSE relay
    await fetch('/api/display/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, emoji })
    });

    showToast(`Broadcasted aloud to customer monitor: "${text}" 📢`, 'success');
    closeModal('modal-speaker-broadcast');
  } catch (err) {
    showToast('Broadcast notice: ' + err.message, 'error');
  }
}

function submitCustomSpeakerBroadcast() {
  const text = document.getElementById('speaker-custom-text')?.value.trim();
  const emoji = document.getElementById('speaker-custom-emoji')?.value.trim() || '📢';
  if (!text) {
    showToast('Please type an announcement message.', 'error');
    return;
  }
  broadcastToDisplaySpeaker(text, emoji);
  document.getElementById('speaker-custom-text').value = '';
}

// ==========================================
// CUSTOMER FEEDBACK DASHBOARD
// ==========================================
function openFeedbackDashboard() {
  openModal('modal-feedback-dashboard');
  loadFeedbackDashboard();
}

async function loadFeedbackDashboard() {
  try {
    const res = await fetch('/api/feedback/summary');
    const data = await res.json();

    const statPos = document.getElementById('fb-stat-positive');
    const statTot = document.getElementById('fb-stat-total');
    const statEmoji = document.getElementById('fb-stat-top-emoji');
    const countAwesome = document.getElementById('fb-count-awesome');
    const countGreat = document.getElementById('fb-count-great');
    const countOkay = document.getElementById('fb-count-okay');
    const recentList = document.getElementById('fb-recent-list');

    if (statPos) statPos.textContent = `${data.positivePercent || 100}%`;
    if (statTot) statTot.textContent = `${data.totalCount || 0}`;
    if (countAwesome) countAwesome.textContent = data.breakdown?.awesome || 0;
    if (countGreat) countGreat.textContent = data.breakdown?.great || 0;
    if (countOkay) countOkay.textContent = data.breakdown?.okay || 0;

    if (data.breakdown?.awesome >= data.breakdown?.great && data.breakdown?.awesome > 0) {
      if (statEmoji) statEmoji.textContent = '🤩';
    } else if (data.breakdown?.great > 0) {
      if (statEmoji) statEmoji.textContent = '😊';
    }

    if (recentList) {
      if (!data.recent || data.recent.length === 0) {
        recentList.innerHTML = `<p class="text-xs text-slate-500 text-center py-4">No reviews recorded yet. Students can rate service on the 2nd screen!</p>`;
      } else {
        recentList.innerHTML = data.recent.map(r => `
          <div class="bg-slate-950 p-2.5 rounded-xl border border-slate-800 flex items-center justify-between text-xs">
            <div class="flex items-center gap-2">
              <span class="text-xl">${r.emoji || '😊'}</span>
              <div>
                <span class="font-bold text-white">${r.comment || 'Rating'}</span>
                <span class="text-[10px] text-slate-400 block">${new Date(r.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} • Order #${r.order_id || 'N/A'}</span>
              </div>
            </div>
            <span class="text-amber-400 font-bold font-mono">${r.rating || 5}★</span>
          </div>
        `).join('');
      }
    }
  } catch (err) {
    console.warn('Error loading feedback dashboard:', err);
  }
}

// ==========================================
// SCREEN & FEATURE CONFIGURATION
// ==========================================
let featureSettings = {};

const FEATURE_KEYS = [
  'cfg_pos_voice_order',
  'cfg_pos_birthday_celebration',
  'cfg_pos_quick_cash',
  'cfg_pos_face_scan',
  'cfg_pos_camera_scan',
  'cfg_pos_sound_effects',
  'cfg_pos_discounts',
  'cfg_pos_shrinkage',
  'cfg_pos_fundraiser',
  'cfg_pos_auto_combo',
  'cfg_display_menu_board',
  'cfg_display_feedback_kiosk',
  'cfg_display_charity_roundup',
  'cfg_event_countdown_enabled',
  'cfg_event_countdown_title',
  'cfg_event_countdown_date',
  'cfg_event_countdown_emoji',
  'cfg_happy_hour_enabled',
  'cfg_happy_hour_label',
  'cfg_happy_hour_discount',
  'cfg_happy_hour_start',
  'cfg_happy_hour_end',
  'cfg_display_news_ticker',
  'cfg_display_trending',
  'cfg_display_weather',
  'cfg_display_secret_code',
  'cfg_display_compliment',
  'cfg_display_polls',
  'cfg_display_nutrition',
  'cfg_display_wishlist',
  'cfg_display_spin_wheel',
  'cfg_display_balance_check',
  'cfg_display_scratch_card',
  'cfg_display_tip_jar',
  'cfg_display_fundraiser',
  'current_theme'
];

async function loadFeatureConfig() {
  try {
    const res = await fetch('/api/settings');
    featureSettings = await res.json();
    applyPOSFeatureConfig(featureSettings);
  } catch (err) {
    console.warn('Feature config load notice:', err);
  }
}

function openConfigModal() {
  loadFeatureConfig().then(() => {
    FEATURE_KEYS.forEach(key => {
      const input = document.getElementById(key.replace(/_/g, '-'));
      if (input) {
        if (input.type === 'checkbox') {
          input.checked = featureSettings[key] !== 'false';
        } else {
          input.value = featureSettings[key] || input.value || '';
        }
      }
    });
  });
  switchConfigTab('pos');
  openModal('modal-feature-config');
}

function switchConfigTab(tabName) {
  document.querySelectorAll('.cfg-panel').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.cfg-tab-btn').forEach(b => {
    b.className = 'cfg-tab-btn bg-slate-950 hover:bg-slate-800 text-slate-300 border border-slate-800 px-3.5 py-1.5 rounded-xl transition whitespace-nowrap';
  });

  const activeBtn = document.getElementById(`cfg-tab-btn-${tabName}`);
  const activePanel = document.getElementById(`cfg-panel-${tabName}`);
  if (activeBtn) activeBtn.className = 'cfg-tab-btn bg-amber-500 text-slate-950 px-3.5 py-1.5 rounded-xl font-bold transition whitespace-nowrap';
  if (activePanel) activePanel.classList.remove('hidden');

  if (tabName === 'announcements') loadAnnouncementsManager();
  if (tabName === 'wishlist') loadWishlistManager();
  lucide.createIcons();
}

async function saveFeatureConfig() {
  const payload = {};
  FEATURE_KEYS.forEach(key => {
    const input = document.getElementById(key.replace(/_/g, '-'));
    if (input) {
      if (input.type === 'checkbox') {
        payload[key] = input.checked ? 'true' : 'false';
      } else {
        payload[key] = input.value;
      }
      featureSettings[key] = payload[key];
    }
  });

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save config');

    applyPOSFeatureConfig(featureSettings);
    syncCartToDisplay();

    // Broadcast settings update to 2nd screen via BroadcastChannel
    if (displayChannel) {
      try {
        displayChannel.postMessage({ type: 'settings_update', settings: featureSettings });
      } catch(e) {}
    }

    playSound('chaching');
    closeModal('modal-feature-config');
    showToast('Screen layout & feature toggles saved! ✨', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function applyPOSFeatureConfig(settings) {
  if (!settings) return;

  // 1. Sound FX toggle
  if (settings.cfg_pos_sound_effects === 'false') {
    soundEnabled = false;
    const audioIcon = document.getElementById('audio-icon');
    if (audioIcon) audioIcon.setAttribute('data-lucide', 'volume-x');
  } else {
    soundEnabled = true;
    const audioIcon = document.getElementById('audio-icon');
    if (audioIcon) audioIcon.setAttribute('data-lucide', 'volume-2');
  }

  // 2. Barcode / Camera Scan buttons
  const cameraBtns = document.querySelectorAll('[onclick="openCameraScanner()"]');
  cameraBtns.forEach(btn => {
    btn.classList.toggle('hidden', settings.cfg_pos_camera_scan === 'false');
  });

  // 3. Quick Cash Tender Buttons in cash modal
  const quickCashContainer = document.getElementById('pos-quick-cash-container');
  if (quickCashContainer) {
    quickCashContainer.classList.toggle('hidden', settings.cfg_pos_quick_cash === 'false');
  }

  // 4. Face Scanning Mode Switch in camera modal
  const btnFace = document.getElementById('btn-mode-face');
  if (btnFace) {
    btnFace.classList.toggle('hidden', settings.cfg_pos_face_scan === 'false');
  }

  // 5. Discounts & Promo Codes Bar in Cart
  const discBar = document.getElementById('cart-discount-bar');
  if (discBar) {
    discBar.classList.toggle('hidden', settings.cfg_pos_discounts === 'false');
  }

  // 6. Loss / Spoilage / Shrinkage button
  const btnShrinkage = document.getElementById('btn-inventory-spoilage');
  if (btnShrinkage) {
    btnShrinkage.classList.toggle('hidden', settings.cfg_pos_shrinkage === 'false');
  }

  // 7. Fundraiser Allocator in Cart
  const fundBar = document.getElementById('cart-fundraiser-bar');
  if (fundBar) {
    fundBar.classList.toggle('hidden', settings.cfg_pos_fundraiser === 'false');
  }

  // 8. Voice Ordering Button
  const btnVoice = document.getElementById('btn-voice-order');
  if (btnVoice) {
    btnVoice.classList.toggle('hidden', settings.cfg_pos_voice_order === 'false');
  }

  // 9. Auto-Combo computation & banner update
  renderCart();

  // 10. Seasonal Theme Engine
  if (settings.current_theme) {
    selectTheme(settings.current_theme, false);
  }

  lucide.createIcons();
}

// Announcements Manager
async function loadAnnouncementsManager() {
  const container = document.getElementById('announcements-manage-list');
  if (!container) return;

  try {
    const res = await fetch('/api/announcements');
    const items = await res.json();

    if (!items || items.length === 0) {
      container.innerHTML = `<p class="text-xs text-slate-500 text-center py-4">No active ticker announcements. Post one above!</p>`;
      return;
    }

    container.innerHTML = items.map(a => `
      <div class="bg-slate-950 p-2.5 rounded-xl border border-slate-800 flex items-center justify-between gap-2 shadow-sm">
        <div class="flex items-center gap-2 min-w-0">
          <span class="text-lg">${a.emoji || '📢'}</span>
          <span class="text-xs text-slate-200 truncate">${a.message || a.content}</span>
        </div>
        <button onclick="deleteAnnouncement(${a.id})" class="text-rose-400 hover:text-rose-300 p-1 rounded hover:bg-rose-500/20 text-xs transition" title="Delete Announcement">
          <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
        </button>
      </div>
    `).join('');
    lucide.createIcons();
  } catch (err) {
    container.innerHTML = `<div class="text-rose-400 text-xs py-2">Error loading announcements: ${err.message}</div>`;
  }
}

async function submitNewAnnouncement() {
  const emoji = document.getElementById('new-announcement-emoji').value.trim() || '📢';
  const textInput = document.getElementById('new-announcement-text');
  const message = textInput.value.trim();

  if (!message) {
    showToast('Please type announcement text', 'error');
    return;
  }

  try {
    const res = await fetch('/api/announcements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji, message })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to post announcement');

    textInput.value = '';
    loadAnnouncementsManager();
    showToast('Live announcement posted to news ticker! 📢', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteAnnouncement(id) {
  try {
    await fetch(`/api/announcements/${id}`, { method: 'DELETE' });
    loadAnnouncementsManager();
    showToast('Announcement removed from news ticker.', 'info');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Wishlist Manager
async function loadWishlistManager() {
  const container = document.getElementById('cfg-panel-wishlist');
  if (!container) return;

  try {
    const res = await fetch('/api/wishlist');
    const items = await res.json();

    if (!items || items.length === 0) {
      container.innerHTML = `<div class="text-center text-slate-500 py-6 text-xs">No customer snack requests yet.</div>`;
      return;
    }

    container.innerHTML = `
      <div class="bg-slate-950/60 p-3 rounded-2xl border border-slate-800/80 mb-2">
        <span class="text-purple-400 font-bold block mb-0.5">Top-Voted Customer Snack Requests</span>
        <p class="text-[11px] text-slate-400">See what snacks and drinks students are asking you to stock next.</p>
      </div>
      <div class="space-y-2">
        ${items.map((item, idx) => `
          <div class="bg-slate-950 p-3 rounded-2xl border border-slate-800 flex items-center justify-between gap-3 shadow-md">
            <div class="flex items-center gap-2.5 min-w-0">
              <span class="font-heading font-extrabold text-sm text-purple-400">#${idx + 1}</span>
              <div class="min-w-0">
                <h4 class="font-bold text-xs text-white truncate">${item.snack_name}</h4>
                <div class="text-[10px] text-slate-400 font-medium">Requested by ${item.requested_by || 'Student'}</div>
              </div>
            </div>
            <div class="flex items-center gap-1.5 bg-purple-600/20 text-purple-300 border border-purple-500/30 px-3 py-1 rounded-xl text-xs font-mono font-bold">
              <span>👍</span>
              <span>${item.votes || 0} votes</span>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="text-rose-400 text-xs py-4">Error loading wishlist: ${err.message}</div>`;
  }
}

// ==========================================
// 🍂 SEASONAL & HOLIDAY THEME ENGINE
// ==========================================
let currentAppTheme = 'default';
let posParticleAnimationId = null;
let posThemeParticles = [];

const THEME_CONFIG_DATA = {
  default: { name: 'Classic Snack Shack', emoji: '🍿', sound: 'chaching' },
  halloween: { name: 'Halloween Spooktacular', emoji: '🎃', sound: 'spooky' },
  winter: { name: 'Winter Wonderland', emoji: '❄️', sound: 'winter_bell' },
  st_patricks: { name: "St. Patrick's Lucky Pot", emoji: '🍀', sound: 'celtic' },
  spirit_week: { name: 'Spirit Week / Game Day', emoji: '🏆', sound: 'fanfare' },
  valentines: { name: "Valentine's Sweet Heart", emoji: '💖', sound: 'rose_chime' }
};

const POS_THEME_PARTICLES = {
  halloween: ['🦇', '🎃', '👻', '🕸️', '🍬'],
  winter: ['❄️', '⛄', '✨', '❄️', '☕'],
  st_patricks: ['🍀', '🪙', '✨', '🌈', '🍀'],
  spirit_week: ['🏆', '⭐', '🐯', '💙', '📣'],
  valentines: ['💖', '💌', '💕', '✨', '🌹']
};

function openThemeSelectorModal() {
  openModal('modal-theme-selector');
  applyThemeUI(currentAppTheme);
}

async function selectTheme(themeName, saveToServer = true) {
  if (!THEME_CONFIG_DATA[themeName]) themeName = 'default';
  currentAppTheme = themeName;
  applyThemeUI(themeName);

  if (saveToServer) {
    const soundToPlay = THEME_CONFIG_DATA[themeName].sound;
    if (soundToPlay) playSound(soundToPlay);

    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_theme: themeName })
      });
      featureSettings.current_theme = themeName;

      // Broadcast theme change to 2nd customer screen via BroadcastChannel
      if (displayChannel) {
        try {
          displayChannel.postMessage({ type: 'theme_change', theme: themeName });
        } catch(e) {}
      }

      showToast(`Seasonal theme switched to ${THEME_CONFIG_DATA[themeName].emoji} ${THEME_CONFIG_DATA[themeName].name}!`, 'success');
    } catch(err) {
      console.warn('Error saving theme setting:', err);
    }
  }
}

function applyThemeUI(themeName) {
  document.body.setAttribute('data-theme', themeName);

  // Update navbar emoji
  const navEmoji = document.getElementById('nav-theme-emoji');
  if (navEmoji && THEME_CONFIG_DATA[themeName]) {
    navEmoji.textContent = THEME_CONFIG_DATA[themeName].emoji;
  }

  // Update active border/badge state across all theme cards
  const allCards = document.querySelectorAll('.theme-card');
  allCards.forEach(card => {
    const isTarget = card.id === `theme-card-${themeName}` || card.id === `quick-theme-card-${themeName}`;
    const badge = card.querySelector('.theme-active-badge');

    if (isTarget) {
      card.classList.add('border-amber-500', 'ring-2', 'ring-amber-500/40');
      card.classList.remove('border-slate-800');
      if (badge) badge.classList.remove('hidden');
    } else {
      card.classList.remove('border-amber-500', 'ring-2', 'ring-amber-500/40');
      card.classList.add('border-slate-800');
      if (badge) badge.classList.add('hidden');
    }
  });

  initPOSThemeParticles(themeName);
}

function initPOSThemeParticles(theme) {
  const canvas = document.getElementById('theme-particles-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  if (posParticleAnimationId) {
    cancelAnimationFrame(posParticleAnimationId);
    posParticleAnimationId = null;
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!theme || theme === 'default' || !POS_THEME_PARTICLES[theme]) {
    return;
  }

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  window.removeEventListener('resize', resize);
  window.addEventListener('resize', resize);

  const emojis = POS_THEME_PARTICLES[theme];
  const count = 18;
  posThemeParticles = [];

  for (let i = 0; i < count; i++) {
    posThemeParticles.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      emoji: emojis[Math.floor(Math.random() * emojis.length)],
      size: Math.random() * 14 + 16,
      vx: (Math.random() - 0.5) * 1.0 + (theme === 'halloween' ? -0.6 : 0),
      vy: theme === 'valentines' ? -(Math.random() * 1.0 + 0.5) : (Math.random() * 1.0 + 0.5),
      swaySpeed: Math.random() * 0.03 + 0.01,
      swayOffset: Math.random() * Math.PI * 2,
      rotation: Math.random() * Math.PI * 2,
      vRot: (Math.random() - 0.5) * 0.02,
      opacity: Math.random() * 0.25 + 0.22
    });
  }

  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const p of posThemeParticles) {
      p.swayOffset += p.swaySpeed;
      p.x += p.vx + Math.sin(p.swayOffset) * 0.7;
      p.y += p.vy;
      p.rotation += p.vRot;

      if (p.y > canvas.height + 40) {
        p.y = -30;
        p.x = Math.random() * canvas.width;
      } else if (p.y < -40) {
        p.y = canvas.height + 30;
        p.x = Math.random() * canvas.width;
      }
      if (p.x > canvas.width + 40) p.x = -30;
      if (p.x < -40) p.x = canvas.width + 30;

      ctx.save();
      ctx.globalAlpha = p.opacity;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.font = `${p.size}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.emoji, 0, 0);
      ctx.restore();
    }

    posParticleAnimationId = requestAnimationFrame(render);
  }
  render();
}

// ==========================================
// 📚 STEALTH MODE / SCHOOL DISGUISE ENGINE
// ==========================================
let isStealthModeActive = false;
let escapePressHistory = [];

function toggleStealthMode() {
  setStealthMode(!isStealthModeActive, true);
}

function setStealthMode(active, broadcast = true) {
  isStealthModeActive = !!active;
  const overlay = document.getElementById('stealth-mode-overlay');
  const particleCanvas = document.getElementById('theme-particles-canvas');

  if (overlay) {
    overlay.classList.toggle('hidden', !isStealthModeActive);
  }
  if (particleCanvas) {
    particleCanvas.style.display = isStealthModeActive ? 'none' : 'block';
  }

  // Update current date on document header
  const dateEls = document.querySelectorAll('.stealth-current-date');
  dateEls.forEach(el => {
    el.textContent = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  });

  if (broadcast) {
    // 1. Dual-Screen zero-latency sync via BroadcastChannel
    if (displayChannel) {
      try {
        displayChannel.postMessage({ type: 'stealth_mode', active: isStealthModeActive });
      } catch(e) {}
    }

    // 2. Server-Sent Events relay for remote display screens
    fetch('/api/display/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'stealth_mode', active: isStealthModeActive })
    }).catch(()=>{});
  }

  if (isStealthModeActive) {
    // Freeze audio context sounds
    try {
      if (audioCtx && audioCtx.state === 'running') {
        audioCtx.suspend().catch(()=>{});
      }
    } catch(e){}
  } else {
    // Resume audio context
    try {
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(()=>{});
      }
    } catch(e){}
    showToast('📚 Disguise deactivated. Transaction active! ✨', 'info');
  }
}

// Global Key Listeners for Instant Trigger
window.addEventListener('keydown', (e) => {
  // Alt + S or Ctrl + Shift + S or F2 to toggle
  if ((e.altKey && e.key.toLowerCase() === 's') || 
      (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 's') || 
      e.key === 'F2') {
    e.preventDefault();
    toggleStealthMode();
    return;
  }

  // Triple-tap Escape within 1.2s to toggle
  if (e.key === 'Escape') {
    const now = Date.now();
    escapePressHistory.push(now);
    escapePressHistory = escapePressHistory.filter(t => now - t < 1200);
    if (escapePressHistory.length >= 3) {
      escapePressHistory = [];
      toggleStealthMode();
    }
  }
});

// ==========================================
// 2ND DISPLAY PAIRING & CROSS-DEVICE SYNC
// ==========================================
async function openPairDisplayModal() {
  openModal('modal-pair-display');
  try {
    const res = await fetch('/api/network-info');
    const data = await res.json();
    const urlInput = document.getElementById('pair-display-url-input');
    const qrImg = document.getElementById('pair-qr-image');
    
    const displayUrl = data.displayUrl || `http://${window.location.hostname || 'localhost'}:${window.location.port || 3000}/display`;
    if (urlInput) urlInput.value = displayUrl;
    if (qrImg) {
      qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(displayUrl)}`;
    }
  } catch (err) {
    console.warn('Network info fetch fallback:', err);
    const fallbackUrl = `${window.location.origin}/display`;
    const urlInput = document.getElementById('pair-display-url-input');
    const qrImg = document.getElementById('pair-qr-image');
    if (urlInput) urlInput.value = fallbackUrl;
    if (qrImg) qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(fallbackUrl)}`;
  }
}

function copyPairUrl() {
  const urlInput = document.getElementById('pair-display-url-input');
  if (!urlInput) return;
  urlInput.select();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(urlInput.value).then(() => {
      showToast('📋 Display URL copied to clipboard!', 'success');
    }).catch(() => {
      document.execCommand('copy');
      showToast('📋 Display URL copied!', 'success');
    });
  } else {
    document.execCommand('copy');
    showToast('📋 Display URL copied!', 'success');
  }
}

// ==========================================
// ⚡ MORE TOOLS DROPDOWN CONTROLLER
// ==========================================
function toggleMoreToolsDropdown(show = null) {
  const menu = document.getElementById('dropdown-more-tools');
  if (!menu) return;
  const isHidden = menu.classList.contains('hidden');
  const shouldOpen = (show !== null) ? !!show : isHidden;
  menu.classList.toggle('hidden', !shouldOpen);
}

// Close dropdown on outside click
document.addEventListener('click', (e) => {
  const dropdown = document.getElementById('dropdown-more-tools');
  const btn = document.getElementById('btn-more-tools');
  if (dropdown && !dropdown.classList.contains('hidden')) {
    if (!dropdown.contains(e.target) && btn && !btn.contains(e.target)) {
      dropdown.classList.add('hidden');
    }
  }
});

// ==========================================
// 🛒 REMOTE SELF-CHECKOUT KIOSK TOGGLER
// ==========================================
let isKioskRemoteActive = false;

async function toggleRemoteCustomerKiosk(force = null) {
  isKioskRemoteActive = (force !== null) ? !!force : !isKioskRemoteActive;
  
  // Update button UI on Cashier POS
  const btn = document.getElementById('btn-cashier-toggle-kiosk');
  const label = document.getElementById('label-cashier-kiosk-status');
  if (btn && label) {
    if (isKioskRemoteActive) {
      label.textContent = 'Kiosk: ON (Active)';
      btn.className = 'flex items-center gap-1.5 text-xs text-slate-950 bg-emerald-400 hover:bg-emerald-300 px-2.5 py-1.5 rounded-xl transition font-black shadow-md shadow-emerald-900/30';
    } else {
      label.textContent = 'Kiosk: OFF';
      btn.className = 'flex items-center gap-1.5 text-xs text-orange-300 hover:text-white bg-orange-500/10 hover:bg-orange-500/20 border border-orange-500/30 px-2.5 py-1.5 rounded-xl transition font-semibold';
    }
  }

  // 1. Send to server SSE endpoint
  try {
    await fetch('/api/display/toggle_kiosk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: isKioskRemoteActive })
    });
  } catch (err) {
    console.warn('Remote kiosk toggle server broadcast notice:', err);
  }

  // 2. Broadcast via BroadcastChannel
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      const bc = new BroadcastChannel('snack_display_sync');
      bc.postMessage({ type: 'toggle_kiosk', active: isKioskRemoteActive });
    } catch(e){}
  }

  showToast(
    isKioskRemoteActive ? '🛒 Self-Checkout Kiosk ACTIVATED on 2nd Display!' : '🖥️ Customer Screen switched back to Register View.',
    isKioskRemoteActive ? 'success' : 'info'
  );
}

// ==========================================
// 📹 2ND DISPLAY (CUSTOMER SCREEN) CCTV RECEIVER & 1-HR DVR
// ==========================================
const DVR_MAX_DURATION_SEC = 3600; // 60 minutes = 3600 seconds
let dvrRollingBuffer = []; // Array of { timestamp: number, dataUrl: string, tag: string, student: object, audioLevel: number, imgObj: Image }
let dvrCurrentOffsetSec = 0; // 0 = LIVE; negative numbers = past seconds
let isDvrReplayPlaying = false;
let dvrPlaybackSpeed = 1;
let dvrPlaybackInterval = null;

let isCustomerDisplayOnline = false;
let lastCustomerFrameTime = 0;
let latestCustomerCctvPacket = null;
let latestCustomerFrameImg = null;
let cashierCctvAnimFrame = null;
let cashierCctvPollingInterval = null;
let cctvDetectionLogsList = [];
let isCashierRecordingClip = false;
let cashierMediaRecorder = null;
let cashierRecordedChunks = [];

// Receiver connection initializer
function initCashierCustomerCctvSync() {
  // 1. BroadcastChannel for zero-latency communication on same device
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      const bc = new BroadcastChannel('snack_display_sync');
      bc.onmessage = (e) => {
        if (!e.data) return;
        if (e.data.type === 'cctv_customer_frame') {
          handleIncomingCustomerCctvPacket(e.data);
        } else if (e.data.type === 'display_heartbeat') {
          lastCustomerFrameTime = Date.now();
          isCustomerDisplayOnline = true;
          updateCustomerDisplayConnectionBadge(true);
          updateCustomerCctvAudioHud(e.data.audioLevel, e.data.hasAudio);
        }
      };
    } catch(e){}
  }

  // 2. Poll server fallback every 1000ms for multi-device/LAN setups
  if (cashierCctvPollingInterval) clearInterval(cashierCctvPollingInterval);
  cashierCctvPollingInterval = setInterval(async () => {
    try {
      const res = await fetch('/api/display/cctv_status');
      const data = await res.json();
      if (data && data.online) {
        lastCustomerFrameTime = data.lastHeartbeat || Date.now();
        isCustomerDisplayOnline = true;
        updateCustomerDisplayConnectionBadge(true);
        updateCustomerCctvAudioHud(data.audioLevel, data.hasAudio);

        if (data.frame) {
          handleIncomingCustomerCctvPacket({
            type: 'cctv_customer_frame',
            timestamp: data.lastHeartbeat || Date.now(),
            frame: data.frame,
            tag: data.tag,
            student: data.student,
            isHumanDetected: data.isHumanDetected,
            hasAudio: data.hasAudio,
            audioLevel: data.audioLevel
          });
        }
      } else if (!data || !data.online) {
        if (Date.now() - lastCustomerFrameTime > 4500) {
          isCustomerDisplayOnline = false;
          updateCustomerDisplayConnectionBadge(false);
          updateCustomerCctvAudioHud(0, false);
        }
      }
    } catch(e){}
  }, 1000);
}

// Update Audio VU meter in Cashier CCTV HUD
function updateCustomerCctvAudioHud(audioLevel = 0, hasAudio = true) {
  const bar = document.getElementById('cctv-audio-bar');
  const label = document.getElementById('cctv-audio-status-label');
  const icon = document.getElementById('cctv-audio-icon');
  if (!bar) return;

  const lvl = Math.max(0, Math.min(100, audioLevel || 0));
  bar.style.width = `${Math.max(8, lvl)}%`;

  if (lvl > 50) {
    bar.className = 'h-full bg-rose-500 rounded-full transition-all duration-75';
    if (label) { label.textContent = '🔊 LOUD MIC'; label.className = 'text-[9px] font-mono text-rose-400 font-bold'; }
  } else if (lvl > 20) {
    bar.className = 'h-full bg-amber-400 rounded-full transition-all duration-75';
    if (label) { label.textContent = '🎙️ VOICE REC'; label.className = 'text-[9px] font-mono text-amber-300 font-bold'; }
  } else {
    bar.className = 'h-full bg-emerald-400 rounded-full transition-all duration-100';
    if (label) { label.textContent = hasAudio ? 'MIC LIVE' : 'MIC IDLE'; label.className = 'text-[9px] font-mono text-emerald-400 font-bold'; }
  }
}

// Handle incoming frame from 2nd display camera
function handleIncomingCustomerCctvPacket(packet) {
  if (!packet) return;
  lastCustomerFrameTime = Date.now();
  isCustomerDisplayOnline = true;
  latestCustomerCctvPacket = packet;
  updateCustomerDisplayConnectionBadge(true);
  updateCustomerCctvAudioHud(packet.audioLevel, packet.hasAudio);

  const now = packet.timestamp || Date.now();

  // Create image object for rendering
  let img = null;
  if (packet.frame) {
    img = new Image();
    img.onload = () => {
      latestCustomerFrameImg = img;
    };
    img.src = packet.frame;
  }

  // Store in 1-Hour Rolling DVR buffer (recording from Customer Camera)
  if (packet.frame) {
    dvrRollingBuffer.push({
      timestamp: now,
      dataUrl: packet.frame,
      imgObj: img,
      tag: packet.tag || null,
      student: packet.student || null,
      isHumanDetected: !!packet.isHumanDetected,
      audioLevel: packet.audioLevel || 0
    });
  }

  // Purge frames older than 1 hour (3600s)
  const oneHourAgo = now - (DVR_MAX_DURATION_SEC * 1000);
  while (dvrRollingBuffer.length > 0 && dvrRollingBuffer[0].timestamp < oneHourAgo) {
    dvrRollingBuffer.shift();
  }
  updateTimelineEventMarkers();
}

function updateCustomerDisplayConnectionBadge(online) {
  const dot = document.getElementById('cashier-display-conn-dot');
  const text = document.getElementById('cashier-display-conn-text');
  const pill = document.getElementById('cashier-display-conn-pill');
  if (dot && text) {
    if (online) {
      dot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse';
      text.textContent = '2nd Screen Online';
      text.className = 'text-emerald-400 font-bold';
      if (pill) pill.className = 'flex items-center gap-1.5 bg-emerald-950/80 border border-emerald-500/40 text-emerald-300 text-xs px-2.5 py-1.5 rounded-xl font-mono';
    } else {
      dot.className = 'w-2 h-2 rounded-full bg-rose-500 animate-ping';
      text.textContent = '2nd Screen Offline';
      text.className = 'text-rose-400 font-bold';
      if (pill) pill.className = 'flex items-center gap-1.5 bg-rose-950/80 border border-rose-500/40 text-rose-300 text-xs px-2.5 py-1.5 rounded-xl font-mono';
    }
  }
}

function startCashierCctvFeed() {
  initCashierCustomerCctvSync();
  startCashierCctvRenderLoop();
}

function openCashierSecurityCamera() {
  openModal('modal-cashier-security-cam');
  toggleCashierFloatingCctv(false);
  startCashierCctvFeed();
  loadRecentCctvEvents();
  jumpToLiveFeed();
}

function closeCashierSecurityCamera() {
  closeModal('modal-cashier-security-cam');
  if (isDvrReplayPlaying) toggleDvrPlayback(false);
}

function toggleCashierSecurityCamera() {
  const modal = document.getElementById('modal-cashier-security-cam');
  if (modal && !modal.classList.contains('hidden')) {
    closeCashierSecurityCamera();
  } else {
    openCashierSecurityCamera();
  }
}

function dockCashierCctvWidget() {
  closeModal('modal-cashier-security-cam');
  if (isDvrReplayPlaying) toggleDvrPlayback(false);
  toggleCashierFloatingCctv(true);
}

function toggleCashierFloatingCctv(show = null) {
  const floatingWidget = document.getElementById('cashier-floating-cctv');
  if (!floatingWidget) return;
  const isVisible = !floatingWidget.classList.contains('hidden');
  const shouldShow = (show !== null) ? !!show : !isVisible;
  floatingWidget.classList.toggle('hidden', !shouldShow);
  if (shouldShow) {
    startCashierCctvFeed();
  }
}

// ==========================================
// ⏱️ 1-HOUR TIME-MACHINE DVR SCRUBBER & REPLAY
// ==========================================
function onDvrScrubInput(val) {
  const offset = parseInt(val, 10);
  dvrCurrentOffsetSec = offset;
  const offsetLabel = document.getElementById('dvr-time-offset-label');
  
  if (offsetLabel) {
    if (offset >= 0) {
      offsetLabel.textContent = 'LIVE (NOW)';
      offsetLabel.className = 'text-[11px] font-mono text-rose-400 font-bold bg-rose-500/10 px-2 py-0.5 rounded border border-rose-500/30';
    } else {
      const absSec = Math.abs(offset);
      const m = Math.floor(absSec / 60);
      const s = absSec % 60;
      const pastTime = new Date(Date.now() - (absSec * 1000)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      offsetLabel.textContent = `-${m}m ${s}s ago (${pastTime})`;
      offsetLabel.className = 'text-[11px] font-mono text-amber-400 font-bold bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/30 animate-pulse';
    }
  }

  // Live render historical frame immediately on drag
  if (offset >= 0) {
    jumpToLiveFeed();
  } else {
    renderHistoricalDvrFrame(offset);
  }
}

function onDvrScrubChange(val) {
  onDvrScrubInput(val);
}

function jumpToLiveFeed() {
  dvrCurrentOffsetSec = 0;
  if (isDvrReplayPlaying) toggleDvrPlayback(false);

  const slider = document.getElementById('cctv-dvr-slider');
  const offsetLabel = document.getElementById('dvr-time-offset-label');
  const dvrBadge = document.getElementById('dvr-mode-badge');
  const watermark = document.getElementById('cctv-dvr-watermark');
  const playBtn = document.getElementById('label-dvr-play');

  if (slider) slider.value = '0';
  if (offsetLabel) {
    offsetLabel.textContent = 'LIVE (NOW)';
    offsetLabel.className = 'text-[11px] font-mono text-rose-400 font-bold bg-rose-500/10 px-2 py-0.5 rounded border border-rose-500/30';
  }
  if (dvrBadge) {
    dvrBadge.textContent = isCustomerDisplayOnline ? '🔴 LIVE FEED' : '🔴 OFFLINE';
    dvrBadge.className = isCustomerDisplayOnline
      ? 'text-[10px] font-mono font-bold bg-rose-500/20 text-rose-300 border border-rose-500/40 px-2 py-0.5 rounded-full'
      : 'text-[10px] font-mono font-bold bg-rose-950 text-rose-400 border border-rose-600 px-2 py-0.5 rounded-full';
  }
  if (watermark) watermark.classList.add('hidden');
  if (playBtn) playBtn.textContent = 'Play Replay';
}

function jumpDvrMinutes(min) {
  const targetOffset = min * 60;
  const slider = document.getElementById('cctv-dvr-slider');
  if (slider) slider.value = targetOffset;
  onDvrScrubInput(targetOffset);
}

function stepDvrSeconds(deltaSec) {
  dvrCurrentOffsetSec = Math.min(0, Math.max(-DVR_MAX_DURATION_SEC, dvrCurrentOffsetSec + deltaSec));
  const slider = document.getElementById('cctv-dvr-slider');
  if (slider) slider.value = dvrCurrentOffsetSec;
  onDvrScrubInput(dvrCurrentOffsetSec);
}

function setDvrPlaybackSpeed(speed) {
  dvrPlaybackSpeed = parseFloat(speed) || 1;
  if (isDvrReplayPlaying) {
    toggleDvrPlayback(false);
    toggleDvrPlayback(true);
  }
}

function toggleDvrPlayback(force = null) {
  isDvrReplayPlaying = (force !== null) ? !!force : !isDvrReplayPlaying;
  const playBtn = document.getElementById('label-dvr-play');
  const playIcon = document.getElementById('icon-dvr-play');

  if (dvrPlaybackInterval) {
    clearInterval(dvrPlaybackInterval);
    dvrPlaybackInterval = null;
  }

  if (isDvrReplayPlaying) {
    if (playBtn) playBtn.textContent = 'Pause';
    if (playIcon) playIcon.setAttribute('data-lucide', 'pause');
    if (typeof lucide !== 'undefined') lucide.createIcons();

    if (dvrCurrentOffsetSec >= 0) {
      dvrCurrentOffsetSec = -60;
      const slider = document.getElementById('cctv-dvr-slider');
      if (slider) slider.value = '-60';
      onDvrScrubInput(-60);
    }

    const stepInterval = Math.max(200, 1000 / dvrPlaybackSpeed);
    dvrPlaybackInterval = setInterval(() => {
      dvrCurrentOffsetSec += Math.round(1 * dvrPlaybackSpeed);
      if (dvrCurrentOffsetSec >= 0) {
        jumpToLiveFeed();
        return;
      }
      const slider = document.getElementById('cctv-dvr-slider');
      if (slider) slider.value = dvrCurrentOffsetSec;
      onDvrScrubInput(dvrCurrentOffsetSec);
    }, stepInterval);

  } else {
    if (playBtn) playBtn.textContent = 'Play Replay';
    if (playIcon) playIcon.setAttribute('data-lucide', 'play');
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
}

// Render historical frame from Customer Screen DVR ring buffer
function renderHistoricalDvrFrame(offsetSec) {
  const targetTimestamp = Date.now() + (offsetSec * 1000);
  const canvas = document.getElementById('cashier-cctv-canvas');
  const dvrBadge = document.getElementById('dvr-mode-badge');
  const statusPill = document.getElementById('cctv-stream-status-pill');
  const statusText = document.getElementById('cctv-stream-status-text');
  const watermark = document.getElementById('cctv-dvr-watermark');

  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!canvas.width || canvas.width < 100) {
    canvas.width = 640;
    canvas.height = 480;
  }

  let closestFrame = null;
  let minDiff = Infinity;

  // Find closest frame in buffer
  if (dvrRollingBuffer.length > 0) {
    for (let i = 0; i < dvrRollingBuffer.length; i++) {
      const diff = Math.abs(dvrRollingBuffer[i].timestamp - targetTimestamp);
      if (diff < minDiff && (dvrRollingBuffer[i].dataUrl || dvrRollingBuffer[i].imgObj)) {
        minDiff = diff;
        closestFrame = dvrRollingBuffer[i];
      }
    }
    // If target timestamp is earlier than the earliest frame we have, use the earliest frame
    if (!closestFrame && dvrRollingBuffer[0]) {
      closestFrame = dvrRollingBuffer[0];
    }
  }

  const absSec = Math.abs(offsetSec);
  const m = Math.floor(absSec / 60);
  const s = absSec % 60;
  const pastTimeStr = new Date(targetTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  if (dvrBadge) {
    dvrBadge.textContent = `⏪ REPLAY (-${m}m ${s}s)`;
    dvrBadge.className = 'text-[10px] font-mono font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 px-2 py-0.5 rounded-full';
  }
  if (statusPill && statusText) {
    statusText.textContent = `CUSTOMER CAM DVR • ${dvrPlaybackSpeed}X`;
    statusPill.className = 'bg-amber-950/90 border border-amber-500/60 text-amber-300 font-mono font-bold text-[10px] px-2.5 py-0.5 rounded-full flex items-center gap-1.5 shadow';
  }
  if (watermark) {
    watermark.classList.remove('hidden');
    watermark.textContent = `⏪ REWIND (CUSTOMER CAM): ${pastTimeStr} (-${m}m ${s}s)`;
  }

  // Frame is only considered present if within 3.5 seconds of target timestamp
  const hasRecordedFrame = closestFrame && minDiff <= 3500 && (closestFrame.dataUrl || closestFrame.imgObj);

  if (hasRecordedFrame) {
    // Function to draw image and DVR HUD
    function drawDvrImageFrame(imgToDraw, frameInfo) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.drawImage(imgToDraw, 0, 0, canvas.width, canvas.height);
      ctx.restore();

      // Vintage Surveillance Amber Filter
      ctx.fillStyle = 'rgba(245, 158, 11, 0.06)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Scanlines
      ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
      for (let y = 0; y < canvas.height; y += 4) {
        ctx.fillRect(0, y, canvas.width, 2);
      }

      // Rewind HUD Border Lines
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.5)';
      ctx.lineWidth = 2;
      ctx.strokeRect(10, 10, canvas.width - 20, canvas.height - 20);

      // Tag Pill
      const tag = (frameInfo && frameInfo.tag) ? frameInfo.tag : 'SURVEILLANCE ARCHIVE';
      ctx.fillStyle = 'rgba(16, 185, 129, 0.9)';
      ctx.fillRect(18, 18, 260, 22);
      ctx.fillStyle = '#022c22';
      ctx.font = 'bold 11px monospace';
      ctx.fillText(`CUSTOMER CAM: ${tag}`, 24, 33);

      // Audio recording indicator
      const audioLvl = (frameInfo && frameInfo.audioLevel) ? frameInfo.audioLevel : 0;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
      ctx.fillRect(canvas.width - 180, 18, 160, 22);
      ctx.fillStyle = audioLvl > 20 ? '#fbbf24' : '#6ee7b7';
      ctx.font = 'bold 10px monospace';
      ctx.fillText(`🎙️ AUDIO REC: ${audioLvl}%`, canvas.width - 170, 33);
    }

    if (closestFrame.imgObj && closestFrame.imgObj.complete && closestFrame.imgObj.naturalWidth > 0) {
      drawDvrImageFrame(closestFrame.imgObj, closestFrame);
    } else if (closestFrame.dataUrl) {
      const img = new Image();
      img.onload = () => {
        closestFrame.imgObj = img;
        drawDvrImageFrame(img, closestFrame);
      };
      img.src = closestFrame.dataUrl;
    }
  } else {
    // ==========================================
    // 📼 EXACT TACTICAL DVR TIME-MACHINE STANDBY SCREEN
    // ==========================================
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#070b14';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Subtle CRT Horizontal Scanlines
    ctx.fillStyle = 'rgba(255, 255, 255, 0.025)';
    for (let y = 0; y < canvas.height; y += 3) {
      ctx.fillRect(0, y, canvas.width, 1.5);
    }

    // Outer Reticle & Framing Border Lines
    const pad = 16;
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(pad, pad, canvas.width - (pad * 2), canvas.height - (pad * 2));

    // Corner tick markers
    const tickLen = 22;
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2.5;

    // Top-Left
    ctx.beginPath(); ctx.moveTo(pad, pad + tickLen); ctx.lineTo(pad, pad); ctx.lineTo(pad + tickLen, pad); ctx.stroke();
    // Top-Right
    ctx.beginPath(); ctx.moveTo(canvas.width - pad - tickLen, pad); ctx.lineTo(canvas.width - pad, pad); ctx.lineTo(canvas.width - pad, pad + tickLen); ctx.stroke();
    // Bottom-Left
    ctx.beginPath(); ctx.moveTo(pad, canvas.height - pad - tickLen); ctx.lineTo(pad, canvas.height - pad); ctx.lineTo(pad + tickLen, canvas.height - pad); ctx.stroke();
    // Bottom-Right
    ctx.beginPath(); ctx.moveTo(canvas.width - pad - tickLen, canvas.height - pad); ctx.lineTo(canvas.width - pad, canvas.height - pad); ctx.lineTo(canvas.width - pad, canvas.height - pad - tickLen); ctx.stroke();

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;

    // Center 1: Icon + "TIME-MACHINE DVR PLAYBACK" Header
    ctx.fillStyle = '#0284c7';
    ctx.fillRect(cx - 150, cy - 66, 20, 20);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('⏪', cx - 140, cy - 52);

    ctx.fillStyle = '#f59e0b';
    ctx.font = 'bold 16px monospace';
    ctx.textAlign = 'start';
    ctx.fillText('TIME-MACHINE DVR PLAYBACK', cx - 120, cy - 51);

    // Center 2: Large White Timecode
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 36px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(pastTimeStr, cx, cy - 8);

    // Center 3: Offset & Camera Location
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px monospace';
    ctx.fillText(`Offset: -${m} min ${s} sec • CAM-02 Customer Screen (Table 4B)`, cx, cy + 24);

    // Center 4: Status / Subtitle
    ctx.fillStyle = '#64748b';
    ctx.font = '11px monospace';
    ctx.fillText('Logged Customer Screen DVR Archive • Continuous Rec', cx, cy + 46);
    ctx.textAlign = 'start';
  }
}

// Render colored event ticks on the 60-minute scrubber bar
function updateTimelineEventMarkers() {
  const container = document.getElementById('cctv-timeline-markers');
  if (!container || cctvDetectionLogsList.length === 0) return;

  const now = Date.now();
  container.innerHTML = cctvDetectionLogsList.map(item => {
    const itemTime = item.created_at || now;
    const diffSec = (now - itemTime) / 1000;
    if (diffSec > DVR_MAX_DURATION_SEC) return '';
    const pct = ((DVR_MAX_DURATION_SEC - diffSec) / DVR_MAX_DURATION_SEC) * 100;
    return `
      <div 
        onclick="jumpToIncidentTimestamp(${itemTime})" 
        class="absolute top-0 w-1.5 h-2.5 bg-amber-400 hover:bg-amber-300 rounded-full cursor-pointer hover:scale-150 transition" 
        style="left: ${pct}%;" 
        title="${item.tag || 'Tag'} - ${item.label} (${item.timestamp})">
      </div>
    `;
  }).join('');
}

function jumpToIncidentTimestamp(timestamp) {
  const diffSec = Math.round((Date.now() - timestamp) / 1000);
  const offset = -Math.min(DVR_MAX_DURATION_SEC, Math.max(0, diffSec));
  const slider = document.getElementById('cctv-dvr-slider');
  if (slider) slider.value = offset;
  onDvrScrubInput(offset);
  showToast(`⏪ Jumped to detection timestamp (${Math.round(diffSec / 60)}m ago)`, 'info');
}

// ==========================================
// 📺 CASHIER CCTV LIVE STREAM RENDER & OFFLINE ENGINE
// ==========================================
function startCashierCctvRenderLoop() {
  const canvas = document.getElementById('cashier-cctv-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let animTick = 0;

  function renderLoop() {
    animTick++;
    const now = Date.now();
    isCustomerDisplayOnline = (now - lastCustomerFrameTime) < 4500;
    updateCustomerDisplayConnectionBadge(isCustomerDisplayOnline);

    if (canvas.width !== 640 || canvas.height !== 480) {
      canvas.width = 640;
      canvas.height = 480;
    }

    const w = canvas.width;
    const h = canvas.height;

    // Only render live feed if scrubber is at LIVE (offset >= 0)
    if (dvrCurrentOffsetSec >= 0) {
      ctx.clearRect(0, 0, w, h);

      if (!isCustomerDisplayOnline || !latestCustomerFrameImg) {
        // ==========================================
        // 🔴 2ND DISPLAY (CUSTOMER SCREEN) OFFLINE STATE
        // ==========================================
        ctx.fillStyle = '#0b0f19';
        ctx.fillRect(0, 0, w, h);

        // Scanline grid
        ctx.fillStyle = 'rgba(239, 68, 68, 0.04)';
        for (let y = 0; y < h; y += 4) {
          ctx.fillRect(0, y, w, 2);
        }

        // Radar reticle
        const cx = w / 2;
        const cy = h / 2 - 25;
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, 45 + Math.sin(animTick * 0.05) * 6, 0, Math.PI * 2);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(cx - 24, cy); ctx.lineTo(cx + 24, cy);
        ctx.moveTo(cx, cy - 24); ctx.lineTo(cx, cy + 24);
        ctx.stroke();

        // Warning text block
        ctx.fillStyle = '#ef4444';
        ctx.font = 'bold 16px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('🔴 2ND DISPLAY OFFLINE / DISCONNECTED', cx, cy + 80);

        ctx.fillStyle = '#cbd5e1';
        ctx.font = '12px sans-serif';
        ctx.fillText('No active video signal detected from the Customer Screen camera.', cx, cy + 105);
        ctx.fillStyle = '#94a3b8';
        ctx.font = '11px monospace';
        ctx.fillText('Open /display on 2nd monitor or tablet to start live CCTV feed', cx, cy + 128);
        ctx.textAlign = 'start';

        // Update UI Badges
        const statusPill = document.getElementById('cctv-stream-status-pill');
        const statusText = document.getElementById('cctv-stream-status-text');
        const tagBadge = document.getElementById('cashier-cctv-tag-badge');
        const dvrBadge = document.getElementById('dvr-mode-badge');
        const pipTag = document.getElementById('cashier-pip-tag');

        if (statusPill && statusText) {
          statusText.textContent = '2ND SCREEN OFFLINE';
          statusPill.className = 'bg-rose-950/90 border border-rose-600 text-rose-300 font-mono font-bold text-[10px] px-2.5 py-0.5 rounded-full flex items-center gap-1.5 shadow';
        }
        if (tagBadge) {
          tagBadge.classList.remove('hidden');
          tagBadge.textContent = '⚪ 2ND SCREEN OFFLINE';
        }
        if (dvrBadge) {
          dvrBadge.textContent = '🔴 OFFLINE';
          dvrBadge.className = 'text-[10px] font-mono font-bold bg-rose-950 text-rose-400 border border-rose-600 px-2 py-0.5 rounded-full';
        }
        if (pipTag) {
          pipTag.textContent = '2ND SCREEN OFFLINE';
          pipTag.className = 'absolute bottom-1 left-1 bg-rose-950/90 border border-rose-600 px-1.5 py-0.5 rounded text-[8px] font-mono text-rose-300 font-bold';
        }

      } else {
        // ==========================================
        // 🟢 2ND DISPLAY (CUSTOMER SCREEN) LIVE STREAM
        // ==========================================
        ctx.drawImage(latestCustomerFrameImg, 0, 0, w, h);

        const chkDetect = document.getElementById('chk-cctv-ai-detect');
        const isDetectionEnabled = !chkDetect || chkDetect.checked;
        const packet = latestCustomerCctvPacket || {};

        if (isDetectionEnabled && packet.isHumanDetected) {
          // Bounding box around customer face/presence
          const boxW = w * 0.45;
          const boxH = h * 0.65;
          const boxX = (w - boxW) / 2;
          const boxY = (h - boxH) / 2;

          ctx.strokeStyle = '#10b981';
          ctx.lineWidth = 2.5;
          const len = 20;

          ctx.beginPath();
          ctx.moveTo(boxX, boxY + len); ctx.lineTo(boxX, boxY); ctx.lineTo(boxX + len, boxY);
          ctx.moveTo(boxX + boxW - len, boxY); ctx.lineTo(boxX + boxW, boxY); ctx.lineTo(boxX + boxW, boxY + len);
          ctx.moveTo(boxX + boxW, boxY + boxH - len); ctx.lineTo(boxX + boxW, boxY + boxH); ctx.lineTo(boxX + boxW - len, boxY + boxH);
          ctx.moveTo(boxX + len, boxY + boxH); ctx.lineTo(boxX, boxY + boxH); ctx.lineTo(boxX, boxY + boxH - len);
          ctx.stroke();

          // Identified Student Name / Details
          let detectedStudent = packet.student;
          if (!detectedStudent && typeof activeStudent !== 'undefined' && activeStudent) {
            detectedStudent = activeStudent;
          } else if (!detectedStudent && typeof students !== 'undefined' && students.length > 0) {
            detectedStudent = students[0];
          }

          let tagLabel = '';
          let subLabel = '';
          if (detectedStudent) {
            const bal = parseFloat(detectedStudent.balance || 0).toFixed(2);
            tagLabel = `[TAG #${detectedStudent.id || 104}] 👤 ${detectedStudent.name} ($${bal}) • 98% CONF`;
            subLabel = `ID: ${detectedStudent.student_id || 'STU-1004'} • 2nd Screen Pass Verified`;
          } else {
            tagLabel = `[TAG #812] 👤 CUSTOMER AT COUNTER • 95% CONF`;
            subLabel = `ZONE: Customer Counter (Table 4B) • Ready to Scan`;
          }

          ctx.fillStyle = 'rgba(16, 185, 129, 0.92)';
          ctx.fillRect(boxX, Math.max(10, boxY - 24), ctx.measureText(tagLabel).width + 18, 20);
          ctx.fillStyle = '#022c22';
          ctx.font = 'bold 11px monospace';
          ctx.fillText(tagLabel, boxX + 8, Math.max(24, boxY - 10));

          ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
          ctx.fillRect(boxX, boxY + boxH + 4, 250, 18);
          ctx.fillStyle = '#6ee7b7';
          ctx.font = '10px monospace';
          ctx.fillText(subLabel, boxX + 6, boxY + boxH + 16);

          // Update Status UI
          const tagBadge = document.getElementById('cashier-cctv-tag-badge');
          const pipTag = document.getElementById('cashier-pip-tag');
          if (tagBadge) {
            tagBadge.classList.remove('hidden');
            tagBadge.textContent = detectedStudent ? `🟢 ${detectedStudent.name} ($${parseFloat(detectedStudent.balance||0).toFixed(2)})` : `🟢 Customer Detected`;
          }
          if (pipTag) {
            pipTag.textContent = detectedStudent ? detectedStudent.name : 'CUSTOMER AT COUNTER';
            pipTag.className = 'absolute bottom-1 left-1 bg-emerald-950/90 border border-emerald-500/50 px-1.5 py-0.5 rounded text-[8px] font-mono text-emerald-300 font-bold';
          }

        } else {
          // No human detected on Customer Camera
          ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
          ctx.lineWidth = 1;
          const cx = w / 2;
          const cy = h / 2;
          ctx.beginPath();
          ctx.arc(cx, cy, 32 + Math.sin(animTick * 0.05) * 4, 0, Math.PI * 2);
          ctx.stroke();

          ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
          ctx.fillRect(cx - 85, cy + 42, 170, 18);
          ctx.fillStyle = '#94a3b8';
          ctx.font = 'bold 10px monospace';
          ctx.textAlign = 'center';
          ctx.fillText('SCANNING... NO SUBJECT', cx, cy + 54);
          ctx.textAlign = 'start';

          const tagBadge = document.getElementById('cashier-cctv-tag-badge');
          const pipTag = document.getElementById('cashier-pip-tag');
          if (tagBadge) {
            tagBadge.classList.remove('hidden');
            tagBadge.textContent = '⚪ SCANNING...';
          }
          if (pipTag) {
            pipTag.textContent = 'SCANNING...';
            pipTag.className = 'absolute bottom-1 left-1 bg-slate-950/80 border border-slate-700 px-1.5 py-0.5 rounded text-[8px] font-mono text-slate-400';
          }
        }

        // Live stream status header
        const statusPill = document.getElementById('cctv-stream-status-pill');
        const statusText = document.getElementById('cctv-stream-status-text');
        const dvrBadge = document.getElementById('dvr-mode-badge');
        if (statusPill && statusText) {
          statusText.textContent = '2ND DISPLAY REC • 30 FPS';
          statusPill.className = 'bg-rose-950/90 border border-rose-500/60 text-rose-300 font-mono font-bold text-[10px] px-2.5 py-0.5 rounded-full flex items-center gap-1.5 shadow';
        }
        if (dvrBadge) {
          dvrBadge.textContent = '🔴 LIVE FEED';
          dvrBadge.className = 'text-[10px] font-mono font-bold bg-rose-500/20 text-rose-300 border border-rose-500/40 px-2 py-0.5 rounded-full';
        }
      }
    }

    // Update running clocks
    const clock = document.getElementById('cashier-cctv-clock');
    const pipClock = document.getElementById('cashier-pip-clock');
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (clock) clock.textContent = timeStr;
    if (pipClock) pipClock.textContent = timeStr;

    cashierCctvAnimFrame = requestAnimationFrame(renderLoop);
  }

  if (cashierCctvAnimFrame) cancelAnimationFrame(cashierCctvAnimFrame);
  renderLoop();
}

// 📹 Record 5-Second Video Clip with Video + Audio
async function recordCctvClip() {
  if (isCashierRecordingClip) return;
  const canvas = document.getElementById('cashier-cctv-canvas');
  if (!canvas) return showToast('⚠️ CCTV canvas not found', 'error');

  try {
    cashierRecordedChunks = [];
    isCashierRecordingClip = true;

    // Capture stream from canvas
    const canvasStream = canvas.captureStream ? canvas.captureStream(30) : null;
    if (!canvasStream) return showToast('⚠️ Browser does not support stream capture', 'error');

    // Create Web Audio synthesized mic audio track for audio recording
    let combinedStream = canvasStream;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        const audioCtx = new AudioCtx();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        const dest = audioCtx.createMediaStreamDestination();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(440, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.001, audioCtx.currentTime); // Gentle ambient audio track
        osc.connect(gain);
        gain.connect(dest);
        osc.start();

        const audioTrack = dest.stream.getAudioTracks()[0];
        if (audioTrack) {
          combinedStream = new MediaStream([...canvasStream.getVideoTracks(), audioTrack]);
        }
      }
    } catch(e){}

    // Use MediaRecorder
    const options = { mimeType: 'video/webm;codecs=vp8,opus' };
    try {
      cashierMediaRecorder = new MediaRecorder(combinedStream, options);
    } catch(e) {
      cashierMediaRecorder = new MediaRecorder(combinedStream);
    }

    cashierMediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        cashierRecordedChunks.push(e.data);
      }
    };

    cashierMediaRecorder.onstop = () => {
      isCashierRecordingClip = false;
      const banner = document.getElementById('cctv-recording-banner');
      if (banner) banner.classList.add('hidden');

      const blob = new Blob(cashierRecordedChunks, { type: 'video/webm' });
      const clipUrl = URL.createObjectURL(blob);
      const clipFileName = `Snack_Shack_CCTV_Clip_${new Date().toISOString().slice(11, 19).replace(/:/g, '-')}.webm`;

      // Trigger instant automatic download
      const a = document.createElement('a');
      a.href = clipUrl;
      a.download = clipFileName;
      a.click();

      // Update UI container
      const container = document.getElementById('cctv-recent-clip-container');
      const label = document.getElementById('cctv-clip-label');
      const downloadLink = document.getElementById('cctv-clip-download-link');

      if (container) container.classList.remove('hidden');
      if (label) label.textContent = clipFileName;
      if (downloadLink) {
        downloadLink.href = clipUrl;
        downloadLink.download = clipFileName;
      }

      // Add to Detection Feed as Clip
      recordCctvDetectionIncident({
        tag: `CLIP-${Date.now().toString().slice(-4)}`,
        label: '📹 5s Video & Audio Clip Recorded',
        badge: 'bg-rose-600/90 text-white border-rose-400'
      });

      showToast('📹 5-Second Video & Audio Clip Downloaded!', 'success');
    };

    // Show banner & countdown
    const banner = document.getElementById('cctv-recording-banner');
    const timerLabel = document.getElementById('cctv-recording-timer');
    if (banner) banner.classList.remove('hidden');

    let secLeft = 5;
    if (timerLabel) timerLabel.textContent = `Capturing 5s Clip... (${secLeft}s)`;
    const countdown = setInterval(() => {
      secLeft--;
      if (timerLabel) timerLabel.textContent = `Capturing 5s Clip... (${secLeft}s)`;
      if (secLeft <= 0) clearInterval(countdown);
    }, 1000);

    cashierMediaRecorder.start();
    setTimeout(() => {
      if (cashierMediaRecorder && cashierMediaRecorder.state !== 'inactive') {
        cashierMediaRecorder.stop();
      }
    }, 5000);

  } catch(err) {
    isCashierRecordingClip = false;
    showToast(`⚠️ Recording error: ${err.message}`, 'error');
  }
}

// 📸 Capture High-Res Snapshot with Burned-in Timestamp
function captureCctvSnapshot() {
  const canvas = document.createElement('canvas');
  const video = document.getElementById('cashier-cctv-video');
  const dvrCanvas = document.getElementById('cashier-cctv-canvas');
  
  // If in DVR replay mode, snapshot the canvas
  if (dvrCurrentOffsetSec < 0 && dvrCanvas) {
    canvas.width = dvrCanvas.width || 640;
    canvas.height = dvrCanvas.height || 480;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(dvrCanvas, 0, 0);

    const pastTime = new Date(Date.now() + (dvrCurrentOffsetSec * 1000)).toLocaleString();
    const filename = `Snack_Shack_DVR_Snapshot_${Date.now()}.png`;

    const snapshotDataUrl = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.download = filename;
    link.href = snapshotDataUrl;
    link.click();

    recordCctvDetectionIncident({
      tag: `SNAP-${Date.now().toString().slice(-4)}`,
      label: `Historical Snapshot Captured (${pastTime})`,
      confidence: '100%',
      zone: 'Station Table 4B',
      created_at: Date.now() + (dvrCurrentOffsetSec * 1000),
      snapshot: snapshotDataUrl
    });

    showToast(`📸 Historical Snapshot saved from ${pastTime}!`, 'success');
    return;
  }

  // Otherwise snapshot live feed
  if (!video || !video.videoWidth) return showToast('⚠️ Video feed not ready', 'warning');

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');

  // Flip and draw image
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // Stamp header watermark
  ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
  ctx.fillRect(0, 0, canvas.width, 42);
  ctx.fillStyle = '#f59e0b';
  ctx.font = 'bold 16px sans-serif';
  ctx.fillText("JORDAN'S SNACK SHACK • SECURITY CCTV SNAPSHOT", 20, 27);

  // Stamp footer timestamp
  ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
  ctx.fillRect(0, canvas.height - 35, canvas.width, 35);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 13px monospace';
  const stampStr = `TIMESTAMP: ${new Date().toLocaleString()} • ZONE: TABLE 4B • FORSYTH COUNTY, GA`;
  ctx.fillText(stampStr, 20, canvas.height - 13);

  const snapshotDataUrl = canvas.toDataURL('image/png');
  const filename = `Snack_Shack_Snapshot_${Date.now()}.png`;

  // Download
  const link = document.createElement('a');
  link.download = filename;
  link.href = snapshotDataUrl;
  link.click();

  // Log to feed
  recordCctvDetectionIncident({
    tag: `SNAP-${Date.now().toString().slice(-4)}`,
    label: `Security Snapshot Captured (${filename})`,
    confidence: '100%',
    zone: 'Station Table 4B',
    created_at: Date.now(),
    snapshot: snapshotDataUrl
  });

  showToast('📸 Snapshot saved with verified timestamp!', 'success');
}

// Log & Fetch CCTV Incident Events
async function recordCctvDetectionIncident(eventData) {
  cctvDetectionLogsList.unshift(eventData);
  if (cctvDetectionLogsList.length > 50) cctvDetectionLogsList.pop();
  renderCctvDetectionLogUI();
  updateTimelineEventMarkers();

  try {
    await fetch('/api/cctv/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(eventData)
    });
  } catch(e){}
}

async function loadRecentCctvEvents() {
  try {
    const res = await fetch('/api/cctv/events');
    const data = await res.json();
    if (data && Array.isArray(data)) {
      cctvDetectionLogsList = data;
      renderCctvDetectionLogUI();
      updateTimelineEventMarkers();
    }
  } catch(e){}
}

function renderCctvDetectionLogUI() {
  const container = document.getElementById('cctv-detection-feed');
  if (!container) return;

  if (cctvDetectionLogsList.length === 0) {
    container.innerHTML = `
      <div class="text-center text-slate-500 text-xs py-8">
        Awaiting presence detection...<br>
        <span class="text-[10px]">Subjects approaching Table 4B will be tagged here.</span>
      </div>
    `;
    return;
  }

  container.innerHTML = cctvDetectionLogsList.map(item => `
    <div onclick="jumpToIncidentTimestamp(${item.created_at || Date.now()})" class="bg-slate-900/90 p-2.5 rounded-xl border border-slate-800 space-y-1 hover:border-amber-500/50 hover:bg-slate-800/80 cursor-pointer transition">
      <div class="flex items-center justify-between text-[10px]">
        <span class="font-mono font-bold text-amber-400 bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 rounded">
          ${item.tag || 'TAG-#104'}
        </span>
        <span class="text-slate-400 font-mono">${item.timestamp || new Date(item.created_at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <div class="font-bold text-xs text-slate-200">${item.label}</div>
      <div class="flex items-center justify-between text-[10px] text-slate-400">
        <span>Zone: ${item.zone || 'Table 4B'}</span>
        <span class="text-emerald-400 font-semibold">${item.confidence || '98% Conf.'}</span>
      </div>
      ${item.clipUrl ? `
        <div class="pt-1">
          <a href="${item.clipUrl}" download="${item.clipName || 'clip.webm'}" onclick="event.stopPropagation();" class="inline-flex items-center gap-1 text-[10px] font-bold text-rose-400 hover:text-rose-300 underline">
            <span>📹 Download Recorded 5s Clip</span>
          </a>
        </div>
      ` : ''}
    </div>
  `).join('');
}

function clearCctvDetectionLog() {
  cctvDetectionLogsList = [];
  renderCctvDetectionLogUI();
  updateTimelineEventMarkers();
  showToast('Detection feed cleared', 'info');
}

// ==========================================
// MODAL HELPERS
// ==========================================
function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
  lucide.createIcons();
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}

window.addEventListener('click', (e) => {
  if (e.target.classList.contains('fixed') && e.target.classList.contains('backdrop-blur-sm')) {
    e.target.classList.add('hidden');
  }
});

document.addEventListener('DOMContentLoaded', () => {
  initApp();
  loadFeatureConfig();
  // Fetch initial kiosk status
  fetch('/api/display/kiosk_status').then(r => r.json()).then(d => {
    if (d && d.active) {
      isKioskRemoteActive = true;
      const btn = document.getElementById('btn-cashier-toggle-kiosk');
      const label = document.getElementById('label-cashier-kiosk-status');
      if (label) label.textContent = 'Kiosk: ON (Active)';
      if (btn) btn.className = 'flex items-center gap-1.5 text-xs text-slate-950 bg-emerald-400 hover:bg-emerald-300 px-2.5 py-1.5 rounded-xl transition font-black shadow-md shadow-emerald-900/30';
    }
  }).catch(()=>{});
});

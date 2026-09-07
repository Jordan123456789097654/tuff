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

// Display Synchronization (BroadcastChannel + SSE)
const displayChannel = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel('snack_display_sync') : null;

function getActiveFundraiser() {
  if (!fundraisers || fundraisers.length === 0) return null;
  if (activeFundraiserId) {
    const f = fundraisers.find(item => item.id === parseInt(activeFundraiserId, 10));
    if (f) return f;
  }
  return fundraisers[0] || null;
}

function syncCartToDisplay() {
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
    await Promise.all([loadCategories(), loadProducts(), loadFundraisers(), loadShiftStatus()]);
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

    if (activeShift) {
      badge.className = 'flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 font-semibold hover:bg-emerald-500/20 transition';
      text.textContent = 'Shift Open';
    } else {
      badge.className = 'flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-400 font-semibold hover:bg-rose-500/20 transition';
      text.textContent = 'Shift Closed';
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

function calculateTotals() {
  const subtotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const { eligibleCombos, comboDiscount } = detectComboSavings();

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

  const totalDiscount = Math.min(comboDiscount + discountAmount, subtotal);
  const total = Math.max(0, subtotal - totalDiscount);

  return { subtotal, comboDiscount, eligibleCombos, discountAmount, discountLabel, totalDiscount, total };
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
  document.getElementById('new-stu-name').value = '';
  document.getElementById('new-stu-id').value = `STU${Math.floor(100 + Math.random() * 900)}`;
  document.getElementById('new-stu-grade').value = '7th Grade';
  document.getElementById('new-stu-balance').value = '0.00';
  document.getElementById('new-stu-limit').value = '10.00';
  document.getElementById('new-stu-allergies').value = '';
  document.getElementById('new-stu-notes').value = '';

  openModal('modal-student-new');
}

async function submitNewStudent() {
  const name = document.getElementById('new-stu-name').value.trim();
  const student_id = document.getElementById('new-stu-id').value.trim();
  const grade = document.getElementById('new-stu-grade').value.trim();
  const balance = parseFloat(document.getElementById('new-stu-balance').value) || 0;
  const limit = parseFloat(document.getElementById('new-stu-limit').value) || 10;
  const allergies = document.getElementById('new-stu-allergies').value.trim();
  const notes = document.getElementById('new-stu-notes').value.trim();

  if (!name || !student_id) {
    showToast('Name and Student ID are required', 'error');
    return;
  }

  try {
    const res = await fetch('/api/students', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        student_id,
        name,
        grade,
        balance,
        daily_limit: limit,
        allergies,
        notes
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to create student');

    playSound('beep');
    closeModal('modal-student-new');
    loadStudents();
    showToast(`Student pass created for ${name}! 🎒`, 'success');
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
          <button onclick="openShrinkageModal(${p.id})" class="bg-rose-500/10 hover:bg-rose-500 text-rose-300 hover:text-white px-2.5 py-1.5 rounded-lg border border-rose-500/30 text-xs font-semibold transition" title="Log expired, damaged, or spilled snack">
            🗑️ Spoilage
          </button>
          <button onclick="openRestockModal(${p.id})" class="bg-amber-500/20 hover:bg-amber-500 text-amber-300 hover:text-slate-950 px-2.5 py-1.5 rounded-lg border border-amber-500/30 text-xs font-semibold transition">
            + Restock Case
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
  document.getElementById('prod-name').value = '';
  document.getElementById('prod-price').value = '1.50';
  document.getElementById('prod-cost').value = '0.65';
  document.getElementById('prod-stock').value = '48';
  document.getElementById('prod-low').value = '10';
  document.getElementById('prod-emoji').value = '🍿';
  document.getElementById('prod-allergy').value = '';
  document.getElementById('prod-is-open-price').checked = false;
  toggleOpenPriceFields(false);

  renderCategories();
  openModal('modal-product');
}

function openCustomItemModal() {
  openNewProductModal();
}

async function submitProductForm() {
  const name = document.getElementById('prod-name').value.trim();
  const category_id = parseInt(document.getElementById('prod-category').value, 10);
  const emoji = document.getElementById('prod-emoji').value.trim() || '🍪';
  const is_open_price = document.getElementById('prod-is-open-price').checked;
  const price = is_open_price ? 0 : (parseFloat(document.getElementById('prod-price').value) || 1.0);
  const cost_price = parseFloat(document.getElementById('prod-cost').value) || 0.0;
  const stock_quantity = parseInt(document.getElementById('prod-stock').value, 10) || 0;
  const low_stock_threshold = parseInt(document.getElementById('prod-low').value, 10) || 10;
  const allergy_info = document.getElementById('prod-allergy').value.trim();

  if (!name) {
    showToast('Item name is required', 'error');
    return;
  }

  try {
    const res = await fetch('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        category_id,
        emoji,
        price,
        cost_price,
        stock_quantity,
        low_stock_threshold,
        allergy_info,
        is_open_price
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to create product');

    playSound('beep');
    closeModal('modal-product');
    loadProducts();
    showToast(`Added "${name}" to catalog! ✨`, 'success');
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
// LIVE IN-BROWSER CAMERA SCANNER (HTML5-QRCODE)
// ==========================================
let html5QrScanner = null;

async function openCameraScanner() {
  openModal('modal-camera-scanner');
  const feedback = document.getElementById('scan-feedback-box');
  if (feedback) feedback.textContent = 'Starting camera... Point lens at any snack barcode or student pass.';

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
    if (feedback) feedback.textContent = `Camera access notice: ${err.message || err}. Ensure camera permissions are allowed in browser.`;
  }
}

async function closeCameraScanner() {
  if (html5QrScanner) {
    try {
      await html5QrScanner.stop();
      html5QrScanner.clear();
    } catch(e) {
      console.warn('Camera stop note:', e);
    }
    html5QrScanner = null;
  }
  closeModal('modal-camera-scanner');
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
// RECESS PRE-ORDER QUEUE ("SKIP THE LINE" MODE)
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
        <p class="text-xs text-slate-400 max-w-sm mx-auto">Students and teachers can submit pre-orders ahead of recess at <a href="/order" target="_blank" class="text-amber-400 underline font-semibold">/order</a></p>
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
});

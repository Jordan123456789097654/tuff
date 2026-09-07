const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');
const db = require('./db');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' })); // Support base64 image uploads for QR code
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let displaySseClients = [];

function generateOrderNumber(prefix = 'ORD') {
  const dateStr = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${dateStr}-${rand}`;
}

// ----------------------------------------------------
// PRODUCT & CATEGORY ENDPOINTS
// ----------------------------------------------------

app.get('/api/products', async (req, res) => {
  try {
    const query = `
      SELECT p.*, c.name as category_name, c.icon as category_icon
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.is_active = TRUE
      ORDER BY c.sort_order ASC, p.name ASC
    `;
    const result = await db.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching products:', err);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

app.post('/api/products', async (req, res) => {
  try {
    const { name, category_id, barcode, price, cost_price, stock_quantity, low_stock_threshold, emoji, allergy_info, is_open_price } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Product name is required.' });
    }

    const result = await db.query(
      `INSERT INTO products (name, category_id, barcode, price, cost_price, stock_quantity, low_stock_threshold, emoji, allergy_info, is_open_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        name,
        category_id || null,
        barcode || null,
        parseFloat(price) || 0.00,
        parseFloat(cost_price) || 0.00,
        parseInt(stock_quantity, 10) || 0,
        parseInt(low_stock_threshold, 10) || 10,
        emoji || '🍪',
        allergy_info || '',
        Boolean(is_open_price)
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating product:', err);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

app.put('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, category_id, barcode, price, cost_price, stock_quantity, low_stock_threshold, emoji, allergy_info, is_open_price, is_active } = req.body;

    const result = await db.query(
      `UPDATE products
       SET name = COALESCE($1, name),
           category_id = COALESCE($2, category_id),
           barcode = COALESCE($3, barcode),
           price = COALESCE($4, price),
           cost_price = COALESCE($5, cost_price),
           stock_quantity = COALESCE($6, stock_quantity),
           low_stock_threshold = COALESCE($7, low_stock_threshold),
           emoji = COALESCE($8, emoji),
           allergy_info = COALESCE($9, allergy_info),
           is_open_price = COALESCE($10, is_open_price),
           is_active = COALESCE($11, is_active)
       WHERE id = $12 RETURNING *`,
      [
        name,
        category_id !== undefined ? category_id : null,
        barcode !== undefined ? barcode : null,
        price !== undefined ? parseFloat(price) : null,
        cost_price !== undefined ? parseFloat(cost_price) : null,
        stock_quantity !== undefined ? parseInt(stock_quantity, 10) : null,
        low_stock_threshold !== undefined ? parseInt(low_stock_threshold, 10) : null,
        emoji,
        allergy_info,
        is_open_price !== undefined ? Boolean(is_open_price) : null,
        is_active !== undefined ? Boolean(is_active) : null,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating product:', err);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query('DELETE FROM products WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json({ success: true, message: 'Product deleted', product: result.rows[0] });
  } catch (err) {
    console.error('Error deleting product:', err);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

app.post('/api/products/:id/restock', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { id } = req.params;
    const { add_quantity, reason } = req.body;
    const qty = parseInt(add_quantity, 10);

    if (isNaN(qty) || qty <= 0) {
      return res.status(400).json({ error: 'Invalid restock quantity.' });
    }

    await client.query('BEGIN');

    const cur = await client.query('SELECT stock_quantity FROM products WHERE id = $1 FOR UPDATE', [id]);
    if (cur.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Product not found' });
    }

    const prevStock = cur.rows[0].stock_quantity;
    const newStock = prevStock + qty;

    const updated = await client.query(
      'UPDATE products SET stock_quantity = $1 WHERE id = $2 RETURNING *',
      [newStock, id]
    );

    await client.query(
      `INSERT INTO inventory_logs (product_id, change_qty, previous_stock, new_stock, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, qty, prevStock, newStock, reason || 'Restock Shipment']
    );

    await client.query('COMMIT');
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error restocking product:', err);
    res.status(500).json({ error: 'Failed to restock product' });
  } finally {
    client.release();
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM categories ORDER BY sort_order ASC, name ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching categories:', err);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// ----------------------------------------------------
// STORE SETTINGS & VENMO/CASHAPP QR UPLOAD
// ----------------------------------------------------

app.get('/api/settings', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM store_settings');
    const settings = {};
    result.rows.forEach(r => { settings[r.key] = r.value; });
    res.json(settings);
  } catch (err) {
    console.error('Error fetching settings:', err);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const settings = req.body;
    for (const [key, value] of Object.entries(settings)) {
      await db.query(
        `INSERT INTO store_settings (key, value)
         VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, value]
      );
    }
    res.json({ success: true, message: 'Settings saved successfully' });
    try { notifyDisplayClients(); } catch(e){}
  } catch (err) {
    console.error('Error saving settings:', err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// ----------------------------------------------------
// ONLINE PRE-ORDERS ("SKIP THE LINE" QUEUE)
// ----------------------------------------------------

app.get('/api/preorders', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT * FROM preorders 
      ORDER BY 
        CASE 
          WHEN status = 'pending' THEN 1 
          WHEN status = 'ready' THEN 2 
          ELSE 3 
        END ASC, 
        created_at DESC
      LIMIT 100
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching preorders:', err);
    res.status(500).json({ error: 'Failed to fetch preorders' });
  }
});

app.post('/api/preorders', async (req, res) => {
  try {
    const { customer_name, student_id, pickup_period, items, notes } = req.body;

    if (!customer_name || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Name and items in cart are required for pre-order.' });
    }

    const subtotal = items.reduce((sum, i) => sum + (parseFloat(i.price) * parseInt(i.quantity, 10)), 0);
    const orderNumber = generateOrderNumber('PRE');

    const result = await db.query(
      `INSERT INTO preorders (order_number, customer_name, student_id, pickup_period, status, items, subtotal, total, notes)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $6, $7) RETURNING *`,
      [orderNumber, customer_name.trim(), student_id ? student_id.trim() : null, pickup_period || 'Lunch', JSON.stringify(items), subtotal, notes || '']
    );

    res.status(201).json({ success: true, preorder: result.rows[0] });
  } catch (err) {
    console.error('Error placing preorder:', err);
    res.status(500).json({ error: 'Failed to place preorder' });
  }
});

app.put('/api/preorders/:id/status', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { id } = req.params;
    const { status } = req.body; // 'ready', 'completed', 'cancelled'

    if (!['pending', 'ready', 'completed', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status.' });
    }

    await client.query('BEGIN');

    const cur = await client.query('SELECT * FROM preorders WHERE id = $1 FOR UPDATE', [id]);
    if (cur.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Preorder not found.' });
    }

    const preorder = cur.rows[0];

    // If marking completed and was not completed before, deduct stock & record order
    if (status === 'completed' && preorder.status !== 'completed') {
      const items = typeof preorder.items === 'string' ? JSON.parse(preorder.items) : preorder.items;

      for (const item of items) {
        await client.query('UPDATE products SET stock_quantity = GREATEST(0, stock_quantity - $1) WHERE id = $2', [item.quantity, item.id]);
      }
    }

    const updated = await client.query(
      'UPDATE preorders SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );

    await client.query('COMMIT');
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating preorder status:', err);
    res.status(500).json({ error: 'Failed to update preorder' });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------
// DISCOUNT SYSTEM API
// ----------------------------------------------------

const BUILT_IN_DISCOUNTS = [
  { code: 'HONORROLL', name: '10% Honor Roll Discount', type: 'percentage', value: 10 },
  { code: 'TEACHER', name: '20% Teacher & Staff Discount', type: 'percentage', value: 20 },
  { code: 'VOLUNTEER', name: '15% Volunteer Helper Discount', type: 'percentage', value: 15 },
  { code: 'FRIDAY', name: '$0.50 Friday Snack Promo', type: 'fixed', value: 0.50 },
  { code: 'CLEARANCE', name: '50% End-of-Day Clearance', type: 'percentage', value: 50 },
  { code: 'FREEPASS', name: '100% Free Teacher Reward Pass', type: 'percentage', value: 100 },
];

app.post('/api/discounts/validate', async (req, res) => {
  const { code, subtotal = 0 } = req.body;
  if (!code) return res.status(400).json({ error: 'Please enter a coupon code.' });

  const cleanCode = code.trim().toUpperCase();
  const disc = BUILT_IN_DISCOUNTS.find(d => d.code === cleanCode);

  if (!disc) {
    return res.status(404).json({ error: 'Invalid coupon code.' });
  }

  let amount = 0;
  if (disc.type === 'percentage') {
    amount = subtotal * (disc.value / 100);
  } else {
    amount = disc.value;
  }

  amount = Math.min(amount, subtotal);

  res.json({
    valid: true,
    code: disc.code,
    name: disc.name,
    discount_amount: amount,
    type: disc.type,
    value: disc.value
  });
});

// ----------------------------------------------------
// STUDENT ACCOUNTS & PUNCH CARDS
// ----------------------------------------------------

app.get('/api/students', async (req, res) => {
  try {
    const { q } = req.query;
    let query = 'SELECT * FROM students';
    const params = [];

    if (q) {
      query += ' WHERE student_id ILIKE $1 OR name ILIKE $1';
      params.push(`%${q}%`);
    }

    query += ' ORDER BY name ASC';
    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching students:', err);
    res.status(500).json({ error: 'Failed to fetch students' });
  }
});

app.get('/api/students/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query('SELECT * FROM students WHERE id::text = $1::text OR student_id = $1::text', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching student:', err);
    res.status(500).json({ error: 'Failed to fetch student' });
  }
});

app.post('/api/students', async (req, res) => {
  try {
    let { student_id, name, grade, balance, daily_limit, allergies, notes, photo_data, birthday, is_flagged, watchlist_reason, unpaid_balance } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Student name is required.' });
    }

    if (!student_id || !student_id.trim()) {
      student_id = `STU-${Math.floor(10000 + Math.random() * 90000)}`;
    }

    const result = await db.query(
      `INSERT INTO students (student_id, name, grade, balance, daily_limit, allergies, notes, punch_card, free_rewards, photo_data, birthday, is_flagged, watchlist_reason, unpaid_balance)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 0, $8, $9, $10, $11, $12) RETURNING *`,
      [
        student_id.trim().toUpperCase(),
        name.trim(),
        grade || '6th Grade',
        parseFloat(balance) || 0.00,
        parseFloat(daily_limit) || 10.00,
        allergies || '',
        notes || '',
        photo_data || '',
        birthday || '',
        Boolean(is_flagged),
        watchlist_reason || '',
        parseFloat(unpaid_balance) || 0.00
      ]
    );

    const newStudent = result.rows[0];

    // Broadcast new registration to POS and all 2nd displays
    try {
      broadcastToDisplayClients({
        type: 'student_registered',
        student: newStudent
      });
    } catch(e){}

    res.status(201).json(newStudent);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Student ID already exists. Please choose a different ID or auto-generate one.' });
    }
    console.error('Error creating student:', err);
    res.status(500).json({ error: 'Failed to create student' });
  }
});

app.post('/api/students/:id/photo', async (req, res) => {
  try {
    const { id } = req.params;
    const { photo_data } = req.body;
    if (!photo_data) {
      return res.status(400).json({ error: 'photo_data required' });
    }

    const result = await db.query(
      `UPDATE students SET photo_data = $1 WHERE id::text = $2::text OR student_id = $2::text RETURNING *`,
      [photo_data, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found.' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating student photo:', err);
    res.status(500).json({ error: 'Failed to save photo' });
  }
});

app.post('/api/students/:id/recharge', async (req, res) => {
  try {
    const { id } = req.params;
    const { amount } = req.body;
    const rechargeAmt = parseFloat(amount);
    if (isNaN(rechargeAmt) || rechargeAmt <= 0) {
      return res.status(400).json({ error: 'Valid positive amount required.' });
    }

    const result = await db.query(
      `UPDATE students SET balance = balance + $1 WHERE id::text = $2::text OR student_id = $2::text RETURNING *`,
      [rechargeAmt, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found.' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error recharging student:', err);
    res.status(500).json({ error: 'Failed to recharge balance' });
  }
});

app.put('/api/students/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { student_id, name, grade, balance, daily_limit, allergies, notes, photo_data, punch_card, free_rewards, is_flagged, watchlist_reason, unpaid_balance } = req.body;

    const result = await db.query(
      `UPDATE students
       SET student_id = COALESCE($1, student_id),
           name = COALESCE($2, name),
           grade = COALESCE($3, grade),
           balance = COALESCE($4, balance),
           daily_limit = COALESCE($5, daily_limit),
           allergies = COALESCE($6, allergies),
           notes = COALESCE($7, notes),
           photo_data = COALESCE($8, photo_data),
           punch_card = COALESCE($9, punch_card),
           free_rewards = COALESCE($10, free_rewards),
           is_flagged = COALESCE($11, is_flagged),
           watchlist_reason = COALESCE($12, watchlist_reason),
           unpaid_balance = COALESCE($13, unpaid_balance)
       WHERE id::text = $14::text OR student_id = $14::text RETURNING *`,
      [
        student_id ? student_id.trim().toUpperCase() : null,
        name ? name.trim() : null,
        grade !== undefined ? grade : null,
        balance !== undefined ? parseFloat(balance) : null,
        daily_limit !== undefined ? parseFloat(daily_limit) : null,
        allergies !== undefined ? allergies : null,
        notes !== undefined ? notes : null,
        photo_data !== undefined ? photo_data : null,
        punch_card !== undefined ? parseInt(punch_card, 10) : null,
        free_rewards !== undefined ? parseInt(free_rewards, 10) : null,
        is_flagged !== undefined ? Boolean(is_flagged) : null,
        watchlist_reason !== undefined ? watchlist_reason : null,
        unpaid_balance !== undefined ? parseFloat(unpaid_balance) : null,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Student profile not found.' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating student:', err);
    res.status(500).json({ error: 'Failed to update student profile' });
  }
});

// ----------------------------------------------------
// 🚨 SECURITY INCIDENT EVIDENCE & DURESS LOGS
// ----------------------------------------------------

app.get('/api/security/incidents', async (req, res) => {
  try {
    const result = await db.query(`SELECT * FROM security_incidents ORDER BY created_at DESC LIMIT 50`);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching security incidents:', err);
    res.status(500).json({ error: 'Failed to fetch security incidents' });
  }
});

app.post('/api/security/incidents', async (req, res) => {
  try {
    const { incident_tag, label, student_id, student_name, zone, severity, clip_url, clip_name, notes } = req.body;
    const tag = incident_tag || `INC-${Date.now().toString().slice(-4)}`;

    const result = await db.query(
      `INSERT INTO security_incidents (incident_tag, label, student_id, student_name, zone, severity, clip_url, clip_name, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        tag,
        label || 'Silent Duress / Suspicious Activity',
        student_id || null,
        student_name || null,
        zone || 'Table 4B',
        severity || 'high',
        clip_url || '',
        clip_name || '',
        notes || ''
      ]
    );

    const incident = result.rows[0];

    // Broadcast incident to all connected cashier stations
    try {
      broadcastToDisplayClients({
        type: 'security_incident_logged',
        incident
      });
    } catch(e){}

    res.status(201).json(incident);
  } catch (err) {
    console.error('Error recording security incident:', err);
    res.status(500).json({ error: 'Failed to log security incident' });
  }
});

app.delete('/api/security/incidents/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.query(`DELETE FROM security_incidents WHERE id = $1`, [id]);
    res.json({ success: true, message: 'Incident removed from vault' });
  } catch (err) {
    console.error('Error deleting incident:', err);
    res.status(500).json({ error: 'Failed to delete incident' });
  }
});

app.delete('/api/students/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query('DELETE FROM students WHERE id::text = $1::text OR student_id = $1::text RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Student profile not found.' });
    }
    res.json({ success: true, message: 'Student profile deleted', student: result.rows[0] });
  } catch (err) {
    console.error('Error deleting student:', err);
    res.status(500).json({ error: 'Failed to delete student profile' });
  }
});

// ----------------------------------------------------
// STAFF & CASHIER PROFILES
// ----------------------------------------------------

app.get('/api/staff', async (req, res) => {
  try {
    const result = await db.query('SELECT id, name, role, emoji, is_active, created_at FROM staff_members ORDER BY is_active DESC, name ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching staff:', err);
    res.status(500).json({ error: 'Failed to fetch staff members' });
  }
});

app.post('/api/staff', async (req, res) => {
  try {
    const { name, role, pin, emoji } = req.body;
    if (!name) return res.status(400).json({ error: 'Staff name is required.' });

    const result = await db.query(
      `INSERT INTO staff_members (name, role, pin, emoji)
       VALUES ($1, $2, $3, $4) RETURNING id, name, role, emoji, is_active, created_at`,
      [name.trim(), role || 'Cashier Volunteer', pin || '1234', emoji || '🧑‍💼']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating staff member:', err);
    res.status(500).json({ error: 'Failed to create staff member' });
  }
});

app.put('/api/staff/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, role, pin, emoji, is_active } = req.body;

    const result = await db.query(
      `UPDATE staff_members
       SET name = COALESCE($1, name),
           role = COALESCE($2, role),
           pin = COALESCE($3, pin),
           emoji = COALESCE($4, emoji),
           is_active = COALESCE($5, is_active)
       WHERE id = $6 RETURNING id, name, role, emoji, is_active, created_at`,
      [
        name ? name.trim() : null,
        role !== undefined ? role : null,
        pin !== undefined ? pin : null,
        emoji !== undefined ? emoji : null,
        is_active !== undefined ? Boolean(is_active) : null,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Staff member not found.' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating staff member:', err);
    res.status(500).json({ error: 'Failed to update staff member' });
  }
});

app.delete('/api/staff/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query('DELETE FROM staff_members WHERE id = $1 RETURNING id, name', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Staff member not found.' });
    }
    res.json({ success: true, message: 'Staff member deleted', staff: result.rows[0] });
  } catch (err) {
    console.error('Error deleting staff member:', err);
    res.status(500).json({ error: 'Failed to delete staff member' });
  }
});

// ----------------------------------------------------
// INTERACTIVE CUSTOMER DISPLAY POLLS & REACTIONS
// ----------------------------------------------------

app.get('/api/polls', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM snack_polls ORDER BY votes DESC, id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching polls:', err);
    res.status(500).json({ error: 'Failed to fetch polls' });
  }
});

app.post('/api/polls/vote', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Option ID is required.' });

    const result = await db.query('UPDATE snack_polls SET votes = votes + 1 WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Poll option not found.' });
    }

    const allPolls = await db.query('SELECT * FROM snack_polls ORDER BY votes DESC, id ASC');
    res.json({ success: true, updated: result.rows[0], polls: allPolls.rows });
  } catch (err) {
    console.error('Error recording vote:', err);
    res.status(500).json({ error: 'Failed to record vote' });
  }
});

// ----------------------------------------------------
// SNACK WISHLIST & SUGGESTIONS
// ----------------------------------------------------

app.get('/api/wishlist', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM snack_wishlist ORDER BY votes DESC, id ASC LIMIT 50');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching wishlist:', err);
    res.status(500).json({ error: 'Failed to fetch wishlist' });
  }
});

app.post('/api/wishlist', async (req, res) => {
  try {
    const { snack_name, category, requested_by } = req.body;
    if (!snack_name) return res.status(400).json({ error: 'Snack name is required.' });

    const result = await db.query(
      `INSERT INTO snack_wishlist (snack_name, category, requested_by, votes)
       VALUES ($1, $2, $3, 1) RETURNING *`,
      [snack_name.trim(), category || 'Snack', requested_by ? requested_by.trim() : 'Customer']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error adding wishlist item:', err);
    res.status(500).json({ error: 'Failed to add wishlist item' });
  }
});

app.post('/api/wishlist/vote', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Wishlist item ID is required.' });

    const result = await db.query('UPDATE snack_wishlist SET votes = votes + 1 WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Wishlist item not found.' });
    }
    const allWish = await db.query('SELECT * FROM snack_wishlist ORDER BY votes DESC, id ASC LIMIT 50');
    res.json({ success: true, updated: result.rows[0], items: allWish.rows });
  } catch (err) {
    console.error('Error voting wishlist item:', err);
    res.status(500).json({ error: 'Failed to vote wishlist item' });
  }
});

// ----------------------------------------------------
// LIVE DISPLAY ANNOUNCEMENTS & TICKER
// ----------------------------------------------------

app.get('/api/announcements', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM display_announcements WHERE is_active = TRUE ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching announcements:', err);
    res.status(500).json({ error: 'Failed to fetch announcements' });
  }
});

app.post('/api/announcements', async (req, res) => {
  try {
    const { message, emoji } = req.body;
    if (!message) return res.status(400).json({ error: 'Announcement message is required.' });

    const result = await db.query(
      'INSERT INTO display_announcements (message, emoji) VALUES ($1, $2) RETURNING *',
      [message.trim(), emoji || '📢']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error adding announcement:', err);
    res.status(500).json({ error: 'Failed to add announcement' });
  }
});

app.delete('/api/announcements/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM display_announcements WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting announcement:', err);
    res.status(500).json({ error: 'Failed to delete announcement' });
  }
});

// ----------------------------------------------------
// TRENDING SNACKS (Live Best Sellers + Stock remaining)
// ----------------------------------------------------

app.get('/api/trending', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        p.id, 
        p.name, 
        p.emoji, 
        p.price, 
        p.stock_quantity,
        COALESCE(SUM(oi.quantity), 0) as recent_sold
      FROM products p
      LEFT JOIN order_items oi ON p.id = oi.product_id
      WHERE p.is_active = TRUE
      GROUP BY p.id, p.name, p.emoji, p.price, p.stock_quantity
      ORDER BY recent_sold DESC, p.stock_quantity ASC
      LIMIT 3
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching trending snacks:', err);
    res.status(500).json({ error: 'Failed to fetch trending snacks' });
  }
});

// ----------------------------------------------------
// CHECKOUT & ORDERS (Atomic Transaction)
// ----------------------------------------------------

app.post('/api/checkout', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const {
      cart,
      payment_method,
      student_id,
      use_reward = false,
      discount = 0,
      discount_name = '',
      tax = 0,
      amount_paid,
      cashier_name = 'Student Volunteer',
      notes = '',
      fundraiser_id = null
    } = req.body;

    if (!cart || !Array.isArray(cart) || cart.length === 0) {
      return res.status(400).json({ error: 'Cart cannot be empty.' });
    }

    await client.query('BEGIN');

    let subtotal = 0;
    const preparedItems = [];

    for (const item of cart) {
      const prodRes = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [item.id]);
      if (prodRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Product ID ${item.id} not found.` });
      }

      const product = prodRes.rows[0];
      const qty = parseInt(item.quantity, 10) || 1;

      if (product.stock_quantity > 0 && product.stock_quantity < qty) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Insufficient stock for "${product.name}". Only ${product.stock_quantity} left!`
        });
      }

      const unitPrice = (item.custom_price !== undefined && !isNaN(parseFloat(item.custom_price)))
        ? parseFloat(item.custom_price)
        : parseFloat(product.price);

      const itemTotal = unitPrice * qty;
      subtotal += itemTotal;

      preparedItems.push({
        product_id: product.id,
        product_name: product.name,
        unit_price: unitPrice,
        unit_cost: parseFloat(product.cost_price),
        quantity: qty,
        total_price: itemTotal,
        new_stock: Math.max(0, product.stock_quantity - qty),
        prev_stock: product.stock_quantity
      });
    }

    let discountAmt = Math.min(parseFloat(discount) || 0, subtotal);

    let rewardUsed = false;
    if (use_reward && student_id) {
      const stuRewardCheck = await client.query('SELECT free_rewards FROM students WHERE id::text = $1::text OR student_id = $1::text FOR UPDATE', [student_id]);
      if (stuRewardCheck.rows.length > 0 && stuRewardCheck.rows[0].free_rewards > 0) {
        const maxPrice = Math.max(...preparedItems.map(i => i.unit_price));
        discountAmt = Math.min(subtotal, discountAmt + maxPrice);
        rewardUsed = true;
      }
    }

    const taxAmt = parseFloat(tax) || 0;
    const total = Math.max(0, subtotal - discountAmt + taxAmt);
    const paid = parseFloat(amount_paid) !== undefined ? parseFloat(amount_paid) : total;
    const changeDue = Math.max(0, paid - total);

    let resolvedStudentId = null;
    let punchAwarded = false;
    let newPunchCardCount = 0;
    let newFreeRewards = 0;

    if (student_id) {
      const studentRes = await client.query(
        'SELECT * FROM students WHERE id::text = $1::text OR student_id = $1::text FOR UPDATE',
        [student_id]
      );

      if (studentRes.rows.length > 0) {
        const student = studentRes.rows[0];
        resolvedStudentId = student.id;

        if (payment_method === 'student_account') {
          if (parseFloat(student.balance) < total) {
            await client.query('ROLLBACK');
            return res.status(400).json({
              error: `Insufficient prepaid balance ($${parseFloat(student.balance).toFixed(2)})! You can choose "Student Pays Cash" instead.`
            });
          }

          const todayStr = new Date().toISOString().slice(0, 10);
          const lastSpentStr = student.last_spent_date ? new Date(student.last_spent_date).toISOString().slice(0, 10) : '';
          const spentToday = (lastSpentStr === todayStr) ? parseFloat(student.spent_today) : 0;
          const dailyLimit = parseFloat(student.daily_limit);

          if (dailyLimit > 0 && (spentToday + total) > dailyLimit) {
            await client.query('ROLLBACK');
            return res.status(400).json({
              error: `Daily limit ($${dailyLimit.toFixed(2)}) exceeded! Student already spent $${spentToday.toFixed(2)} today.`
            });
          }

          await client.query(
            `UPDATE students
             SET balance = balance - $1,
                 spent_today = $2 + $1,
                 last_spent_date = CURRENT_DATE
             WHERE id = $3`,
            [total, spentToday, student.id]
          );
        }

        let currentPunches = (student.punch_card || 0) + 1;
        let currentRewards = student.free_rewards || 0;

        if (rewardUsed) {
          currentRewards = Math.max(0, currentRewards - 1);
        }

        if (currentPunches >= 10) {
          currentPunches = 0;
          currentRewards += 1;
        }

        newPunchCardCount = currentPunches;
        newFreeRewards = currentRewards;
        punchAwarded = true;

        await client.query(
          `UPDATE students
           SET punch_card = $1,
               free_rewards = $2
           WHERE id = $3`,
          [currentPunches, currentRewards, student.id]
        );
      }
    }

    const orderNumber = generateOrderNumber();
    const cleanPaymentMethod = payment_method === 'student_cash' ? 'cash (student pass)' : payment_method;

    const orderRes = await client.query(
      `INSERT INTO orders (order_number, cashier_name, payment_method, student_id, subtotal, discount, discount_name, tax, total, amount_paid, change_due, punch_awarded, reward_used, notes, fundraiser_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
      [orderNumber, cashier_name, cleanPaymentMethod, resolvedStudentId, subtotal, discountAmt, discount_name || '', taxAmt, total, paid, changeDue, punchAwarded, rewardUsed, notes, fundraiser_id || null]
    );
    const order = orderRes.rows[0];

    for (const item of preparedItems) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, unit_price, unit_cost, quantity, total_price)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [order.id, item.product_id, item.product_name, item.unit_price, item.unit_cost, item.quantity, item.total_price]
      );

      if (item.prev_stock > 0) {
        await client.query('UPDATE products SET stock_quantity = $1 WHERE id = $2', [item.new_stock, item.product_id]);

        await client.query(
          `INSERT INTO inventory_logs (product_id, change_qty, previous_stock, new_stock, reason)
           VALUES ($1, $2, $3, $4, $5)`,
          [item.product_id, -item.quantity, item.prev_stock, item.new_stock, `Order ${orderNumber}`]
        );
      }
    }

    await client.query('COMMIT');

    order.items = preparedItems;
    order.punch_card_count = newPunchCardCount;
    order.free_rewards = newFreeRewards;

    res.status(201).json({
      success: true,
      order: order
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Checkout error:', err);
    res.status(500).json({ error: err.message || 'Checkout failed.' });
  } finally {
    client.release();
  }
});

app.get('/api/orders', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 50;
    const ordersRes = await db.query(
      `SELECT o.*, s.name as student_name, s.student_id as student_code
       FROM orders o
       LEFT JOIN students s ON o.student_id = s.id
       ORDER BY o.created_at DESC
       LIMIT $1`,
      [limit]
    );

    const orders = ordersRes.rows;
    for (const order of orders) {
      const itemsRes = await db.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
      order.items = itemsRes.rows;
    }

    res.json(orders);
  } catch (err) {
    console.error('Error fetching orders:', err);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// ----------------------------------------------------
// SHIFTS & CASH DRAWER
// ----------------------------------------------------

app.get('/api/shifts/current', async (req, res) => {
  try {
    const shiftRes = await db.query(
      'SELECT * FROM shifts WHERE is_open = TRUE ORDER BY opened_at DESC LIMIT 1'
    );

    if (shiftRes.rows.length === 0) {
      return res.json({ active: false, shift: null });
    }

    const shift = shiftRes.rows[0];

    const cashSalesRes = await db.query(
      `SELECT COALESCE(SUM(total), 0) as cash_total, COUNT(*) as order_count
       FROM orders
       WHERE (payment_method ILIKE '%cash%') AND created_at >= $1`,
      [shift.opened_at]
    );

    const cashTotal = parseFloat(cashSalesRes.rows[0].cash_total);
    const expectedCash = parseFloat(shift.start_cash) + cashTotal;

    res.json({
      active: true,
      shift: {
        ...shift,
        cash_sales: cashTotal,
        expected_cash: expectedCash,
        orders_count: parseInt(cashSalesRes.rows[0].order_count, 10)
      }
    });
  } catch (err) {
    console.error('Error fetching active shift:', err);
    res.status(500).json({ error: 'Failed to fetch current shift' });
  }
});

app.post('/api/shifts/open', async (req, res) => {
  try {
    const { cashier_name, start_cash } = req.body;

    const existing = await db.query('SELECT * FROM shifts WHERE is_open = TRUE LIMIT 1');
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'A shift is already open. Please close the active shift first.' });
    }

    const result = await db.query(
      `INSERT INTO shifts (cashier_name, start_cash, is_open)
       VALUES ($1, $2, TRUE) RETURNING *`,
      [cashier_name || 'Cashier', parseFloat(start_cash) || 50.00]
    );

    // Broadcast shift status to display clients
    const shiftOpenPayload = `data: ${JSON.stringify({ type: 'shift_status', active: true })}\n\n`;
    displaySseClients.forEach(client => {
      try { client.write(shiftOpenPayload); } catch(e){}
    });

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error opening shift:', err);
    res.status(500).json({ error: 'Failed to open shift' });
  }
});

app.post('/api/shifts/close', async (req, res) => {
  try {
    const { actual_cash, notes } = req.body;
    const actual = parseFloat(actual_cash);

    if (isNaN(actual)) {
      return res.status(400).json({ error: 'Please enter actual cash counted in drawer.' });
    }

    const openShift = await db.query('SELECT * FROM shifts WHERE is_open = TRUE ORDER BY opened_at DESC LIMIT 1');
    if (openShift.rows.length === 0) {
      return res.status(400).json({ error: 'No active shift found.' });
    }

    const shift = openShift.rows[0];

    const cashSalesRes = await db.query(
      `SELECT COALESCE(SUM(total), 0) as cash_total
       FROM orders
       WHERE (payment_method ILIKE '%cash%') AND created_at >= $1`,
      [shift.opened_at]
    );

    const cashSales = parseFloat(cashSalesRes.rows[0].cash_total);
    const expected = parseFloat(shift.start_cash) + cashSales;
    const diff = actual - expected;

    const result = await db.query(
      `UPDATE shifts
       SET closed_at = CURRENT_TIMESTAMP,
           expected_cash = $1,
           actual_cash = $2,
           difference = $3,
           notes = $4,
           is_open = FALSE
       WHERE id = $5 RETURNING *`,
      [expected, actual, diff, notes || '', shift.id]
    );

    // Broadcast shift status to display clients
    const shiftClosePayload = `data: ${JSON.stringify({ type: 'shift_status', active: false })}\n\n`;
    displaySseClients.forEach(client => {
      try { client.write(shiftClosePayload); } catch(e){}
    });

    res.json({
      success: true,
      shift: result.rows[0],
      summary: {
        start_cash: parseFloat(shift.start_cash),
        cash_sales: cashSales,
        expected_cash: expected,
        actual_cash: actual,
        difference: diff,
        status: diff === 0 ? 'Balanced' : diff > 0 ? `Over by $${diff.toFixed(2)}` : `Short by $${Math.abs(diff).toFixed(2)}`
      }
    });
  } catch (err) {
    console.error('Error closing shift:', err);
    res.status(500).json({ error: 'Failed to close shift' });
  }
});

// ----------------------------------------------------
// ANALYTICS & EXPORT
// ----------------------------------------------------

app.get('/api/analytics/summary', async (req, res) => {
  try {
    const todayRes = await db.query(`
      SELECT 
        COALESCE(SUM(o.total), 0) as revenue,
        COUNT(DISTINCT o.id) as order_count,
        COALESCE(SUM(oi.unit_cost * oi.quantity), 0) as total_cost
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE o.created_at::date = CURRENT_DATE
    `);

    const revToday = parseFloat(todayRes.rows[0].revenue);
    const costToday = parseFloat(todayRes.rows[0].total_cost);
    const profitToday = revToday - costToday;
    const ordersToday = parseInt(todayRes.rows[0].order_count, 10);

    const allTimeRes = await db.query(`
      SELECT 
        COALESCE(SUM(total), 0) as total_revenue,
        COUNT(*) as total_orders
      FROM orders
    `);

    const topItemsRes = await db.query(`
      SELECT 
        oi.product_name,
        SUM(oi.quantity) as total_sold,
        SUM(oi.total_price) as total_revenue
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      GROUP BY oi.product_name
      ORDER BY total_sold DESC
      LIMIT 6
    `);

    const paymentRes = await db.query(`
      SELECT payment_method, COUNT(*) as count, SUM(total) as amount
      FROM orders
      GROUP BY payment_method
      ORDER BY amount DESC
    `);

    const lowStockRes = await db.query(`
      SELECT id, name, emoji, stock_quantity, low_stock_threshold
      FROM products
      WHERE stock_quantity <= low_stock_threshold AND is_active = TRUE
      ORDER BY stock_quantity ASC
    `);

    res.json({
      today: {
        revenue: revToday,
        profit: profitToday,
        orders: ordersToday
      },
      all_time: {
        revenue: parseFloat(allTimeRes.rows[0].total_revenue),
        orders: parseInt(allTimeRes.rows[0].total_orders, 10)
      },
      top_items: topItemsRes.rows,
      payments: paymentRes.rows,
      low_stock_alerts: lowStockRes.rows
    });
  } catch (err) {
    console.error('Error fetching analytics:', err);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

app.get('/api/analytics/export', async (req, res) => {
  try {
    const orders = await db.query(`
      SELECT 
        o.order_number, 
        o.created_at, 
        o.cashier_name, 
        o.payment_method, 
        s.name as student_name,
        o.subtotal, 
        o.discount, 
        o.discount_name,
        o.tax, 
        o.total, 
        o.notes
      FROM orders o
      LEFT JOIN students s ON o.student_id = s.id
      ORDER BY o.created_at DESC
    `);

    let csv = 'Order Number,Date & Time,Cashier,Payment Method,Student Account,Subtotal,Discount,Discount Name,Tax,Total,Notes\n';
    orders.rows.forEach(r => {
      csv += `"${r.order_number}","${new Date(r.created_at).toLocaleString()}","${r.cashier_name}","${r.payment_method}","${r.student_name || 'N/A'}",${r.subtotal},${r.discount},"${r.discount_name || ''}",${r.tax},${r.total},"${(r.notes || '').replace(/"/g, '""')}"\n`;
    });

    res.header('Content-Type', 'text/csv');
    res.attachment(`jordans_snack_shack_sales_${new Date().toISOString().slice(0, 10)}.csv`);
    res.send(csv);
  } catch (err) {
    console.error('Error generating export:', err);
    res.status(500).json({ error: 'Failed to export CSV' });
  }
});

// ----------------------------------------------------
// FUNDRAISER CAMPAIGNS & ALLOCATIONS
// ----------------------------------------------------

app.get('/api/fundraisers', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        f.*,
        COALESCE(SUM(o.total), 0) as total_raised,
        COALESCE(SUM(o.tip_amount), 0) as total_tips,
        COUNT(DISTINCT o.id) as order_count
      FROM fundraiser_campaigns f
      LEFT JOIN orders o ON f.id = o.fundraiser_id
      WHERE f.is_active = TRUE
      GROUP BY f.id
      ORDER BY f.created_at ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching fundraisers:', err);
    res.status(500).json({ error: 'Failed to fetch fundraisers' });
  }
});

app.post('/api/fundraisers', async (req, res) => {
  try {
    const { name, goal_amount, description } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Fundraiser name is required.' });
    }
    const result = await db.query(
      `INSERT INTO fundraiser_campaigns (name, goal_amount, description)
       VALUES ($1, $2, $3) RETURNING *`,
      [name.trim(), parseFloat(goal_amount) || 500.00, description || '']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating fundraiser:', err);
    res.status(500).json({ error: 'Failed to create fundraiser' });
  }
});

// ----------------------------------------------------
// INVENTORY SHRINKAGE, LOSS & SPOILAGE LOGS
// ----------------------------------------------------

app.get('/api/inventory/shrinkage', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        s.*,
        p.emoji as product_emoji,
        f.name as fundraiser_name
      FROM inventory_shrinkage s
      LEFT JOIN products p ON s.product_id = p.id
      LEFT JOIN fundraiser_campaigns f ON s.fundraiser_id = f.id
      ORDER BY s.created_at DESC
      LIMIT 100
    `);

    const summaryRes = await db.query(`
      SELECT 
        COALESCE(SUM(quantity), 0) as total_units_lost,
        COALESCE(SUM(total_cost_loss), 0) as total_cost_loss
      FROM inventory_shrinkage
    `);

    const reasonsRes = await db.query(`
      SELECT reason, COUNT(*) as count, SUM(quantity) as units, SUM(total_cost_loss) as cost_loss
      FROM inventory_shrinkage
      GROUP BY reason
      ORDER BY cost_loss DESC
    `);

    res.json({
      shrinkage_logs: result.rows,
      summary: {
        total_units_lost: parseInt(summaryRes.rows[0].total_units_lost, 10),
        total_cost_loss: parseFloat(summaryRes.rows[0].total_cost_loss)
      },
      reasons_breakdown: reasonsRes.rows
    });
  } catch (err) {
    console.error('Error fetching shrinkage logs:', err);
    res.status(500).json({ error: 'Failed to fetch shrinkage logs' });
  }
});

app.post('/api/inventory/shrinkage', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { product_id, quantity, reason, notes, logged_by, fundraiser_id } = req.body;
    const qty = parseInt(quantity, 10);

    if (!product_id || isNaN(qty) || qty <= 0) {
      return res.status(400).json({ error: 'Valid product and quantity are required.' });
    }

    await client.query('BEGIN');

    const prodRes = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [product_id]);
    if (prodRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Product not found.' });
    }

    const product = prodRes.rows[0];
    const unitCost = parseFloat(product.cost_price) || 0.00;
    const totalCostLoss = unitCost * qty;
    const prevStock = product.stock_quantity;
    const newStock = Math.max(0, prevStock - qty);

    await client.query('UPDATE products SET stock_quantity = $1 WHERE id = $2', [newStock, product.id]);

    const reasonLabel = reason || 'expired';
    await client.query(
      `INSERT INTO inventory_logs (product_id, change_qty, previous_stock, new_stock, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [product.id, -qty, prevStock, newStock, `Shrinkage/Loss: ${reasonLabel} (${notes || ''})`]
    );

    const logRes = await client.query(
      `INSERT INTO inventory_shrinkage (product_id, product_name, quantity, unit_cost, total_cost_loss, reason, notes, logged_by, fundraiser_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [product.id, product.name, qty, unitCost, totalCostLoss, reasonLabel, notes || '', logged_by || 'Cashier', fundraiser_id || null]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      shrinkage: logRes.rows[0],
      updated_product: {
        id: product.id,
        stock_quantity: newStock
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error logging inventory shrinkage:', err);
    res.status(500).json({ error: 'Failed to record inventory shrinkage' });
  } finally {
    client.release();
  }
});

app.delete('/api/inventory/shrinkage/:id', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { id } = req.params;
    await client.query('BEGIN');

    const logRes = await client.query('SELECT * FROM inventory_shrinkage WHERE id = $1', [id]);
    if (logRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Shrinkage record not found.' });
    }

    const log = logRes.rows[0];

    // Restore stock
    await client.query('UPDATE products SET stock_quantity = stock_quantity + $1 WHERE id = $2', [log.quantity, log.product_id]);
    await client.query(
      `INSERT INTO inventory_logs (product_id, change_qty, previous_stock, new_stock, reason)
       SELECT id, $1, stock_quantity - $1, stock_quantity, 'Voided Shrinkage Entry #${id}' FROM products WHERE id = $2`,
      [log.quantity, log.product_id]
    );

    await client.query('DELETE FROM inventory_shrinkage WHERE id = $1', [id]);
    await client.query('COMMIT');

    res.json({ success: true, message: 'Shrinkage entry voided and inventory restored.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error voiding shrinkage:', err);
    res.status(500).json({ error: 'Failed to void shrinkage entry' });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------
// OFFICIAL SCHOOL ADVISOR / PRINCIPAL FINANCIAL REPORT
// ----------------------------------------------------

app.get('/api/reports/advisor-statement', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    let dateFilter = '';
    const params = [];

    if (start_date && end_date) {
      dateFilter = ' WHERE o.created_at >= $1 AND o.created_at <= $2';
      params.push(new Date(start_date + 'T00:00:00Z'), new Date(end_date + 'T23:59:59Z'));
    } else if (start_date) {
      dateFilter = ' WHERE o.created_at >= $1';
      params.push(new Date(start_date + 'T00:00:00Z'));
    }

    const totalsRes = await db.query(`
      SELECT 
        COUNT(DISTINCT o.id) as total_orders,
        COALESCE(SUM(o.total), 0) as gross_revenue,
        COALESCE(SUM(o.subtotal), 0) as subtotal_sales,
        COALESCE(SUM(o.discount), 0) as total_discounts,
        COALESCE(SUM(o.tip_amount), 0) as total_donations,
        COALESCE(SUM(oi.unit_cost * oi.quantity), 0) as total_cogs
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      ${dateFilter}
    `, params);

    const grossRev = parseFloat(totalsRes.rows[0].gross_revenue || 0);
    const cogs = parseFloat(totalsRes.rows[0].total_cogs || 0);
    const netProfit = grossRev - cogs;
    const profitMargin = grossRev > 0 ? ((netProfit / grossRev) * 100).toFixed(1) : '0.0';

    // Fundraiser Campaign Allocations Breakdown
    const fundraiserRes = await db.query(`
      SELECT 
        f.id,
        f.name,
        f.goal_amount,
        COUNT(DISTINCT o.id) as orders_count,
        COALESCE(SUM(o.total), 0) as gross_raised,
        COALESCE(SUM(o.tip_amount), 0) as tips_raised,
        COALESCE(SUM(oi.unit_cost * oi.quantity), 0) as cogs,
        COALESCE(SUM(o.total) - SUM(oi.unit_cost * oi.quantity), 0) as net_profit
      FROM fundraiser_campaigns f
      LEFT JOIN orders o ON f.id = o.fundraiser_id
      LEFT JOIN order_items oi ON o.id = oi.order_id
      GROUP BY f.id, f.name, f.goal_amount
      ORDER BY gross_raised DESC
    `);

    // Shrinkage & Spoilage Write-Off Breakdown
    let shrinkageFilter = '';
    const shrinkParams = [];
    if (start_date && end_date) {
      shrinkageFilter = ' WHERE created_at >= $1 AND created_at <= $2';
      shrinkParams.push(new Date(start_date + 'T00:00:00Z'), new Date(end_date + 'T23:59:59Z'));
    } else if (start_date) {
      shrinkageFilter = ' WHERE created_at >= $1';
      shrinkParams.push(new Date(start_date + 'T00:00:00Z'));
    }

    const shrinkageRes = await db.query(`
      SELECT 
        COALESCE(SUM(quantity), 0) as total_units_lost,
        COALESCE(SUM(total_cost_loss), 0) as total_cost_loss
      FROM inventory_shrinkage
      ${shrinkageFilter}
    `, shrinkParams);

    const shrinkageBreakdown = await db.query(`
      SELECT reason, SUM(quantity) as units, SUM(total_cost_loss) as cost_loss
      FROM inventory_shrinkage
      ${shrinkageFilter}
      GROUP BY reason
      ORDER BY cost_loss DESC
    `, shrinkParams);

    const paymentsRes = await db.query(`
      SELECT payment_method, COUNT(*) as count, COALESCE(SUM(total), 0) as amount
      FROM orders o
      ${dateFilter}
      GROUP BY payment_method
      ORDER BY amount DESC
    `, params);

    const topItemsRes = await db.query(`
      SELECT 
        oi.product_name,
        SUM(oi.quantity) as units_sold,
        SUM(oi.total_price) as gross_sales,
        SUM(oi.unit_cost * oi.quantity) as total_cost,
        SUM(oi.total_price - (oi.unit_cost * oi.quantity)) as profit
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      ${dateFilter}
      GROUP BY oi.product_name
      ORDER BY gross_sales DESC
      LIMIT 10
    `, params);

    const shiftsRes = await db.query(`
      SELECT * FROM shifts 
      ORDER BY opened_at DESC 
      LIMIT 15
    `);

    const studentPoolRes = await db.query(`
      SELECT COUNT(*) as total_students, COALESCE(SUM(balance), 0) as prepaid_pool, COALESCE(SUM(punch_card), 0) as total_punches
      FROM students
    `);

    const feedbackRes = await db.query(`
      SELECT COUNT(*) as count, AVG(rating) as avg_rating FROM feedback_reviews
    `);

    res.json({
      school_name: "Jordan's Snack Shack School Fund",
      period: {
        start: start_date || 'Inception',
        end: end_date || 'Present',
        generated_at: new Date().toISOString()
      },
      summary: {
        total_orders: parseInt(totalsRes.rows[0].total_orders, 10),
        gross_revenue: grossRev,
        total_cogs: cogs,
        net_profit: netProfit,
        profit_margin: profitMargin,
        total_discounts: parseFloat(totalsRes.rows[0].total_discounts || 0),
        total_donations: parseFloat(totalsRes.rows[0].total_donations || 0),
        shrinkage_cost_loss: parseFloat(shrinkageRes.rows[0].total_cost_loss || 0),
        shrinkage_units_lost: parseInt(shrinkageRes.rows[0].total_units_lost, 10)
      },
      fundraisers: fundraiserRes.rows,
      shrinkage_breakdown: shrinkageBreakdown.rows,
      student_funds: {
        total_students: parseInt(studentPoolRes.rows[0].total_students, 10),
        prepaid_pool: parseFloat(studentPoolRes.rows[0].prepaid_pool || 0),
        total_punches: parseInt(studentPoolRes.rows[0].total_punches, 10)
      },
      customer_satisfaction: {
        total_reviews: parseInt(feedbackRes.rows[0].count || 0, 10),
        avg_rating: parseFloat(feedbackRes.rows[0].avg_rating || 5.0).toFixed(1)
      },
      payments: paymentsRes.rows,
      top_items: topItemsRes.rows,
      shifts: shiftsRes.rows
    });
  } catch (err) {
    console.error('Error generating advisor report:', err);
    res.status(500).json({ error: 'Failed to generate financial report' });
  }
});

// ----------------------------------------------------
// SPIN WHEEL 1-SPIN-PER-WEEK LIMIT ENFORCEMENT
// ----------------------------------------------------

app.get('/api/spin-wheel/status', async (req, res) => {
  try {
    const customerId = (req.query.customer || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'guest').toString().trim();
    
    // Check if spun in last 7 days (1 week)
    const recent = await db.query(
      `SELECT * FROM spin_wheel_logs 
       WHERE customer_identifier = $1 
         AND created_at >= NOW() - INTERVAL '7 days'
       ORDER BY created_at DESC LIMIT 1`,
      [customerId]
    );

    if (recent.rows.length > 0) {
      const lastSpin = recent.rows[0];
      const nextAvailable = new Date(new Date(lastSpin.created_at).getTime() + 7 * 24 * 60 * 60 * 1000);
      return res.json({
        allowed: false,
        last_spin: lastSpin.created_at,
        prize_won: lastSpin.prize_won,
        next_available: nextAvailable.toISOString(),
        message: 'You have already spun this week! Come back next week for another lucky spin.'
      });
    }

    res.json({ allowed: true });
  } catch (err) {
    console.error('Spin wheel status check error:', err);
    res.status(500).json({ error: 'Failed to verify spin wheel status' });
  }
});

app.post('/api/spin-wheel/claim', async (req, res) => {
  try {
    const customerId = (req.body.customer || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'guest').toString().trim();
    const { prize } = req.body;

    if (!prize) {
      return res.status(400).json({ error: 'Prize name required.' });
    }

    // Double check last 7 days limit
    const check = await db.query(
      `SELECT * FROM spin_wheel_logs 
       WHERE customer_identifier = $1 
         AND created_at >= NOW() - INTERVAL '7 days'
       LIMIT 1`,
      [customerId]
    );

    if (check.rows.length > 0) {
      return res.status(429).json({ error: 'Already spun within the past 7 days.' });
    }

    const result = await db.query(
      `INSERT INTO spin_wheel_logs (customer_identifier, prize_won)
       VALUES ($1, $2) RETURNING *`,
      [customerId, prize]
    );

    res.status(201).json({ success: true, log: result.rows[0] });
  } catch (err) {
    console.error('Error claiming spin wheel prize:', err);
    res.status(500).json({ error: 'Failed to claim prize' });
  }
});

app.post('/api/feedback', async (req, res) => {
  try {
    const { rating, emoji, comment, order_id } = req.body;
    const result = await db.query(
      `INSERT INTO feedback_reviews (rating, emoji, comment, order_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [parseInt(rating, 10) || 5, emoji || '🤩', comment || '', order_id || null]
    );
    res.status(201).json({ success: true, feedback: result.rows[0] });
  } catch (err) {
    console.error('Error recording feedback:', err);
    res.status(500).json({ error: 'Failed to record feedback' });
  }
});

app.get('/api/feedback/summary', async (req, res) => {
  try {
    const countRes = await db.query('SELECT COUNT(*) as total_reviews, AVG(rating) as avg_rating FROM feedback_reviews');
    const breakdown = await db.query('SELECT emoji, rating, COUNT(*) as count FROM feedback_reviews GROUP BY emoji, rating ORDER BY count DESC');
    const recent = await db.query('SELECT * FROM feedback_reviews ORDER BY created_at DESC LIMIT 10');
    res.json({
      total_reviews: parseInt(countRes.rows[0].total_reviews, 10),
      avg_rating: parseFloat(countRes.rows[0].avg_rating || 5.0).toFixed(1),
      breakdown: breakdown.rows,
      recent: recent.rows
    });
  } catch (err) {
    console.error('Error fetching feedback summary:', err);
    res.status(500).json({ error: 'Failed to fetch feedback' });
  }
});

// ----------------------------------------------------
// CUSTOMER-FACING SECOND SCREEN (/display)
// ----------------------------------------------------
let displayState = {
  state: 'idle', // 'idle' | 'active' | 'celebrate'
  cart: [],
  subtotal: 0,
  comboDiscount: 0,
  discountAmount: 0,
  discountLabel: '',
  total: 0,
  student: null,
  order: null,
  updatedAt: Date.now()
};

function notifyDisplayClients() {
  const payload = `data: ${JSON.stringify(displayState)}\n\n`;
  displaySseClients.forEach(client => {
    try {
      client.write(payload);
    } catch(e) {}
  });
}

app.get('/api/display/state', (req, res) => {
  res.json(displayState);
});

app.post('/api/display/update', (req, res) => {
  const { state = 'active', cart = [], subtotal = 0, comboDiscount = 0, discountAmount = 0, discountLabel = '', total = 0, student = null } = req.body;
  displayState = {
    state: (!cart || cart.length === 0) && !student ? 'idle' : state,
    cart: cart || [],
    subtotal: parseFloat(subtotal) || 0,
    comboDiscount: parseFloat(comboDiscount) || 0,
    discountAmount: parseFloat(discountAmount) || 0,
    discountLabel: discountLabel || '',
    total: parseFloat(total) || 0,
    student: student || null,
    order: null,
    updatedAt: Date.now()
  };
  notifyDisplayClients();
  res.json({ success: true, displayState });
});

app.post('/api/display/celebrate', (req, res) => {
  const { order } = req.body;
  displayState = {
    state: 'celebrate',
    cart: [],
    subtotal: 0,
    comboDiscount: 0,
    discountAmount: 0,
    discountLabel: '',
    total: order ? parseFloat(order.total) : 0,
    student: null,
    order: order || null,
    updatedAt: Date.now()
  };
  notifyDisplayClients();
  res.json({ success: true, displayState });
});

app.post('/api/display/broadcast', (req, res) => {
  const { text, emoji, type, active } = req.body;

  if (type === 'stealth_mode') {
    const payload = `data: ${JSON.stringify({ type: 'stealth_mode', active: !!active })}\n\n`;
    displaySseClients.forEach(client => {
      try { client.write(payload); } catch(e) {}
    });
    return res.json({ success: true, message: 'Stealth state broadcasted' });
  }

  if (!text) return res.status(400).json({ error: 'Announcement text is required' });

  const payload = `data: ${JSON.stringify({ type: 'speaker_broadcast', text, emoji: emoji || '📢' })}\n\n`;
  displaySseClients.forEach(client => {
    try { client.write(payload); } catch(e) {}
  });

  res.json({ success: true, message: 'Broadcast sent to all display screens' });
});

app.post('/api/display/stealth', (req, res) => {
  const { active } = req.body;
  const payload = `data: ${JSON.stringify({ type: 'stealth_mode', active: !!active })}\n\n`;
  displaySseClients.forEach(client => {
    try { client.write(payload); } catch(e) {}
  });
  res.json({ success: true, active: !!active });
});

app.post('/api/display/birthday', (req, res) => {
  const { student } = req.body;
  const payload = `data: ${JSON.stringify({ type: 'birthday_alert', student })}\n\n`;
  displaySseClients.forEach(client => {
    try { client.write(payload); } catch(e) {}
  });
  res.json({ success: true, message: 'Birthday alert broadcasted to 2nd screen' });
});

app.post('/api/display/face_match', (req, res) => {
  const { student } = req.body;
  const payload = `data: ${JSON.stringify({ type: 'student_face_identified', student })}\n\n`;
  displaySseClients.forEach(client => {
    try { client.write(payload); } catch(e) {}
  });
  res.json({ success: true, message: 'Student face identification broadcasted' });
});

app.post('/api/display/scan_face_request', (req, res) => {
  const payload = `data: ${JSON.stringify({ type: 'request_display_face_scan' })}\n\n`;
  displaySseClients.forEach(client => {
    try { client.write(payload); } catch(e) {}
  });
  res.json({ success: true, message: 'Face scan request sent to 2nd monitor' });
});

let isRemoteKioskActive = false;
let cctvDetectionLogs = [];

app.post('/api/display/toggle_kiosk', (req, res) => {
  const { active } = req.body;
  isRemoteKioskActive = (active !== undefined) ? !!active : !isRemoteKioskActive;
  const payload = `data: ${JSON.stringify({ type: 'toggle_kiosk', active: isRemoteKioskActive })}\n\n`;
  displaySseClients.forEach(client => {
    try { client.write(payload); } catch(e) {}
  });
  res.json({ success: true, active: isRemoteKioskActive });
});

app.get('/api/display/kiosk_status', (req, res) => {
  res.json({ active: isRemoteKioskActive });
});

app.post('/api/cctv/events', (req, res) => {
  const { tag, label, confidence, zone, snapshot } = req.body;
  const newEvent = {
    id: `TAG-${Date.now().toString().slice(-4)}`,
    tag: tag || `TAG-${Date.now().toString().slice(-4)}`,
    label: label || 'Subject Detected',
    confidence: confidence || '96%',
    zone: zone || 'Station Table 4B',
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    created_at: Date.now(),
    snapshot: snapshot || null
  };
  cctvDetectionLogs.unshift(newEvent);
  if (cctvDetectionLogs.length > 50) cctvDetectionLogs.pop();

  const payload = `data: ${JSON.stringify({ type: 'cctv_detection', event: newEvent })}\n\n`;
  displaySseClients.forEach(client => {
    try { client.write(payload); } catch(e) {}
  });

  res.json({ success: true, event: newEvent });
});

app.get('/api/cctv/events', (req, res) => {
  res.json(cctvDetectionLogs);
});

// Customer Service Feedback & Reviews
app.post('/api/feedback', async (req, res) => {
  try {
    const { rating, emoji, comment, order_id } = req.body;
    const result = await db.query(
      `INSERT INTO feedback_reviews (order_id, rating, emoji, comment)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [order_id || null, parseInt(rating, 10) || 5, emoji || '😊', comment || 'Great service']
    );
    res.json({ success: true, feedback: result.rows[0] });
  } catch (err) {
    console.error('Error recording feedback:', err);
    res.status(500).json({ error: 'Failed to record feedback' });
  }
});

app.get('/api/feedback/summary', async (req, res) => {
  try {
    const totalResult = await db.query('SELECT COUNT(*) as count FROM feedback_reviews');
    const breakdownResult = await db.query(`
      SELECT emoji, rating, COUNT(*) as count 
      FROM feedback_reviews 
      GROUP BY emoji, rating 
      ORDER BY count DESC
    `);
    const recentResult = await db.query(`
      SELECT * FROM feedback_reviews 
      ORDER BY created_at DESC 
      LIMIT 50
    `);

    const totalCount = parseInt(totalResult.rows[0].count, 10) || 0;
    
    let awesomeCount = 0;
    let greatCount = 0;
    let okayCount = 0;

    breakdownResult.rows.forEach(r => {
      const cnt = parseInt(r.count, 10) || 0;
      if (r.emoji === '🤩' || r.emoji === '🔥' || (r.rating && r.rating >= 5)) {
        awesomeCount += cnt;
      } else if (r.emoji === '😊' || r.emoji === '⚡' || r.emoji === '🍿' || (r.rating && r.rating >= 4)) {
        greatCount += cnt;
      } else {
        okayCount += cnt;
      }
    });

    const positivePercent = totalCount > 0 ? Math.round(((awesomeCount + greatCount) / totalCount) * 100) : 100;

    res.json({
      totalCount,
      positivePercent,
      breakdown: {
        awesome: awesomeCount,
        great: greatCount,
        okay: okayCount
      },
      recent: recentResult.rows
    });
  } catch (err) {
    console.error('Error fetching feedback summary:', err);
    res.status(500).json({ error: 'Failed to fetch feedback summary' });
  }
});

app.get('/api/display/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send initial state immediately
  res.write(`data: ${JSON.stringify(displayState)}\n\n`);

  displaySseClients.push(res);

  req.on('close', () => {
    displaySseClients = displaySseClients.filter(client => client !== res);
  });
});

// ----------------------------------------------------
// FEATURE CONFIGURATION & STORE SETTINGS
// ----------------------------------------------------
const DEFAULT_SETTINGS = {
  cfg_pos_quick_cash: 'true',
  cfg_pos_face_scan: 'true',
  cfg_pos_camera_scan: 'true',
  cfg_pos_sound_effects: 'true',
  cfg_pos_discounts: 'true',
  cfg_pos_shrinkage: 'true',
  cfg_pos_fundraiser: 'true',
  cfg_pos_auto_combo: 'true',
  cfg_pos_voice_order: 'true',
  cfg_display_news_ticker: 'true',
  cfg_display_trending: 'true',
  cfg_display_weather: 'true',
  cfg_display_secret_code: 'true',
  cfg_display_compliment: 'true',
  cfg_display_polls: 'true',
  cfg_display_nutrition: 'true',
  cfg_display_wishlist: 'true',
  cfg_display_spin_wheel: 'true',
  cfg_display_balance_check: 'true',
  cfg_display_scratch_card: 'true',
  cfg_display_tip_jar: 'true',
  cfg_display_menu_board: 'true',
  cfg_display_feedback_kiosk: 'true',
  cfg_display_charity_roundup: 'true',
  cfg_display_fundraiser: 'true',
  cfg_event_countdown_enabled: 'true',
  cfg_event_countdown_title: 'Homecoming Game',
  cfg_event_countdown_date: '2026-09-12T16:00',
  cfg_event_countdown_emoji: '🏈',
  cfg_happy_hour_enabled: 'false',
  cfg_happy_hour_start: '15:00',
  cfg_happy_hour_end: '15:30',
  cfg_happy_hour_discount: '0.25',
  cfg_happy_hour_label: '25¢ Off All Cold Drinks & Snacks',
  current_theme: 'default'
};

app.get('/api/settings', async (req, res) => {
  try {
    const result = await db.query('SELECT key, value FROM store_settings');
    const settings = { ...DEFAULT_SETTINGS };
    result.rows.forEach(r => {
      settings[r.key] = r.value;
    });
    res.json(settings);
  } catch (err) {
    console.error('Error loading settings:', err);
    res.json(DEFAULT_SETTINGS);
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const newSettings = req.body;
    for (const [key, val] of Object.entries(newSettings)) {
      await db.query(`
        INSERT INTO store_settings (key, value)
        VALUES ($1, $2)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
      `, [key, String(val)]);
    }

    // Broadcast settings update to all connected SSE clients (/display)
    const broadcastPayload = `data: ${JSON.stringify({ type: 'settings_update', settings: newSettings })}\n\n`;
    displaySseClients.forEach(client => {
      try { client.write(broadcastPayload); } catch(e) {}
    });

    res.json({ success: true, message: 'Settings saved successfully' });
  } catch (err) {
    console.error('Error saving settings:', err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// ----------------------------------------------------
// 2ND CUSTOMER DISPLAY SSE & MULTI-DEVICE SYNC
// ----------------------------------------------------
let latestDisplayState = { state: 'idle' };

function broadcastToDisplayClients(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  displaySseClients.forEach(client => {
    try {
      client.res.write(payload);
    } catch (e) {
      // client disconnected
    }
  });
}

app.get('/api/display/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write('\n');

  const clientId = Date.now() + Math.random();
  const newClient = { id: clientId, res };
  displaySseClients.push(newClient);

  // Send current state immediately upon connecting
  if (latestDisplayState) {
    res.write(`data: ${JSON.stringify(latestDisplayState)}\n\n`);
  }

  req.on('close', () => {
    displaySseClients = displaySseClients.filter(c => c.id !== clientId);
  });
});

app.get('/api/display/state', (req, res) => {
  res.json(latestDisplayState || { state: 'idle' });
});

app.post('/api/display/update', (req, res) => {
  latestDisplayState = req.body;
  broadcastToDisplayClients(req.body);
  res.json({ success: true });
});

app.post('/api/display/celebrate', (req, res) => {
  const payload = { state: 'celebrate', ...req.body };
  latestDisplayState = payload;
  broadcastToDisplayClients(payload);
  res.json({ success: true });
});

app.post('/api/display/stealth', (req, res) => {
  const { active } = req.body;
  broadcastToDisplayClients({ type: 'stealth_mode', active: !!active });
  res.json({ success: true, active: !!active });
});

app.post('/api/display/broadcast', (req, res) => {
  broadcastToDisplayClients({ type: 'speaker_broadcast', ...req.body });
  res.json({ success: true });
});

app.post('/api/display/face_match', (req, res) => {
  broadcastToDisplayClients({ type: 'student_face_identified', student: req.body.student });
  res.json({ success: true });
});

// ----------------------------------------------------
// 📹 2ND DISPLAY LIVE CCTV FRAME RELAY & HEARTBEAT
// ----------------------------------------------------
let latestCustomerCctv = {
  online: false,
  lastHeartbeat: 0,
  timestamp: 0,
  frame: null,
  tag: null,
  student: null,
  isHumanDetected: false,
  hasAudio: false,
  audioLevel: 0,
  isHostileAudio: false,
  hostileConfidence: 0,
  isCrowded: false,
  crowdCount: 1
};

app.post('/api/display/cctv_frame', (req, res) => {
  const { frame, tag, student, isHumanDetected, hasAudio, audioLevel, isHostileAudio, hostileConfidence, isCrowded, crowdCount } = req.body;
  const now = Date.now();
  latestCustomerCctv = {
    online: true,
    lastHeartbeat: now,
    timestamp: now,
    frame: frame || latestCustomerCctv.frame,
    tag: tag || null,
    student: student || null,
    isHumanDetected: !!isHumanDetected,
    hasAudio: !!hasAudio,
    audioLevel: typeof audioLevel === 'number' ? audioLevel : (latestCustomerCctv.audioLevel || 0),
    isHostileAudio: !!isHostileAudio,
    hostileConfidence: hostileConfidence || 0,
    isCrowded: !!isCrowded,
    crowdCount: crowdCount || 1
  };

  broadcastToDisplayClients({
    type: 'cctv_customer_frame',
    timestamp: now,
    frame: latestCustomerCctv.frame,
    tag: latestCustomerCctv.tag,
    student: latestCustomerCctv.student,
    isHumanDetected: latestCustomerCctv.isHumanDetected,
    hasAudio: latestCustomerCctv.hasAudio,
    audioLevel: latestCustomerCctv.audioLevel,
    isHostileAudio: latestCustomerCctv.isHostileAudio,
    hostileConfidence: latestCustomerCctv.hostileConfidence,
    isCrowded: latestCustomerCctv.isCrowded,
    crowdCount: latestCustomerCctv.crowdCount
  });

  res.json({ success: true, timestamp: now });
});

app.post('/api/display/heartbeat', (req, res) => {
  const { hasAudio, audioLevel, isCrowded, isHostileAudio } = req.body || {};
  const now = Date.now();
  latestCustomerCctv.lastHeartbeat = now;
  latestCustomerCctv.online = true;
  if (typeof hasAudio !== 'undefined') latestCustomerCctv.hasAudio = !!hasAudio;
  if (typeof audioLevel === 'number') latestCustomerCctv.audioLevel = audioLevel;
  if (typeof isCrowded !== 'undefined') latestCustomerCctv.isCrowded = !!isCrowded;
  if (typeof isHostileAudio !== 'undefined') latestCustomerCctv.isHostileAudio = !!isHostileAudio;

  broadcastToDisplayClients({ 
    type: 'display_heartbeat', 
    timestamp: now,
    hasAudio: latestCustomerCctv.hasAudio,
    audioLevel: latestCustomerCctv.audioLevel,
    isCrowded: latestCustomerCctv.isCrowded,
    isHostileAudio: latestCustomerCctv.isHostileAudio
  });
  res.json({ success: true, timestamp: now });
});

app.get('/api/display/cctv_status', (req, res) => {
  const now = Date.now();
  const isOnline = (now - latestCustomerCctv.lastHeartbeat) < 4500;
  res.json({
    online: isOnline,
    lastHeartbeat: latestCustomerCctv.lastHeartbeat,
    frame: isOnline ? latestCustomerCctv.frame : null,
    tag: isOnline ? latestCustomerCctv.tag : null,
    student: isOnline ? latestCustomerCctv.student : null,
    isHumanDetected: isOnline ? latestCustomerCctv.isHumanDetected : false,
    hasAudio: isOnline ? latestCustomerCctv.hasAudio : false,
    audioLevel: isOnline ? latestCustomerCctv.audioLevel : 0,
    isHostileAudio: isOnline ? latestCustomerCctv.isHostileAudio : false,
    isCrowded: isOnline ? latestCustomerCctv.isCrowded : false
  });
});

// ====================================================
// 👔 MANAGER DASHBOARD APIS
// ====================================================

// 1. SOP Document Management
app.get('/api/manager/sop', async (req, res) => {
  try {
    const sopFilePath = path.join(__dirname, 'public', 'sop.html');
    let content = '';
    if (fs.existsSync(sopFilePath)) {
      content = fs.readFileSync(sopFilePath, 'utf8');
    }
    const dbSop = await db.query('SELECT * FROM sop_documents ORDER BY updated_at DESC LIMIT 1');
    res.json({
      content: content || (dbSop.rows[0] ? dbSop.rows[0].content : ''),
      version: dbSop.rows[0] ? dbSop.rows[0].version : '6.0',
      doc_title: dbSop.rows[0] ? dbSop.rows[0].doc_title : 'Master Enterprise Standard Operating Procedures',
      updated_at: dbSop.rows[0] ? dbSop.rows[0].updated_at : new Date()
    });
  } catch (err) {
    console.error('Error fetching SOP:', err);
    res.status(500).json({ error: 'Failed to fetch SOP document' });
  }
});

app.put('/api/manager/sop', async (req, res) => {
  try {
    const { content, version, doc_title, updated_by } = req.body;
    if (!content) return res.status(400).json({ error: 'Content cannot be empty' });

    // 1. Save to public/sop.html
    const sopFilePath = path.join(__dirname, 'public', 'sop.html');
    fs.writeFileSync(sopFilePath, content, 'utf8');

    // 2. Save to database
    await db.query(
      `INSERT INTO sop_documents (doc_title, version, content, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
      [doc_title || 'Master Enterprise SOP', version || '6.0', content, updated_by || 'Operations Manager']
    );

    res.json({ success: true, message: 'SOP document successfully updated & published!' });
  } catch (err) {
    console.error('Error saving SOP:', err);
    res.status(500).json({ error: 'Failed to save SOP document' });
  }
});

// 2. Incident Reports Management
app.get('/api/manager/incidents', async (req, res) => {
  try {
    const reportsRes = await db.query('SELECT * FROM incident_reports ORDER BY created_at DESC');
    const bookmarksRes = await db.query('SELECT * FROM security_incidents ORDER BY created_at DESC');
    res.json({
      reports: reportsRes.rows,
      bookmarks: bookmarksRes.rows
    });
  } catch (err) {
    console.error('Error fetching incidents:', err);
    res.status(500).json({ error: 'Failed to fetch incidents' });
  }
});

app.post('/api/manager/incidents', async (req, res) => {
  try {
    const { incident_date, incident_time, location, incident_type, student_id, student_name, severity, description, action_taken, status, reported_by } = req.body;
    const reportNum = `INC-${Date.now().toString().slice(-6)}`;
    
    const result = await db.query(
      `INSERT INTO incident_reports (
        report_number, incident_date, incident_time, location, incident_type,
        student_id, student_name, severity, description, action_taken, status, reported_by
      ) VALUES ($1, COALESCE($2, CURRENT_DATE), $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, 'PENDING'), $12)
      RETURNING *`,
      [
        reportNum, incident_date || null, incident_time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        location || 'Table 4B', incident_type || 'other', student_id || null, student_name || '',
        severity || 'MEDIUM', description || 'Incident logged', action_taken || '', status || 'PENDING', reported_by || 'Cashier Station'
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating incident report:', err);
    res.status(500).json({ error: 'Failed to create incident report' });
  }
});

app.put('/api/manager/incidents/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, manager_notes, action_taken, severity } = req.body;
    
    const result = await db.query(
      `UPDATE incident_reports
       SET status = COALESCE($1, status),
           manager_notes = COALESCE($2, manager_notes),
           action_taken = COALESCE($3, action_taken),
           severity = COALESCE($4, severity)
       WHERE id = $5 RETURNING *`,
      [status, manager_notes, action_taken, severity, id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Incident report not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating incident report:', err);
    res.status(500).json({ error: 'Failed to update incident report' });
  }
});

app.delete('/api/manager/incidents/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM incident_reports WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting incident report:', err);
    res.status(500).json({ error: 'Failed to delete incident report' });
  }
});

// 3. Daily Shift Operational Logs
app.get('/api/manager/daily_logs', async (req, res) => {
  try {
    const logsRes = await db.query('SELECT * FROM daily_logs ORDER BY log_date DESC, created_at DESC');
    res.json(logsRes.rows);
  } catch (err) {
    console.error('Error fetching daily logs:', err);
    res.status(500).json({ error: 'Failed to fetch daily logs' });
  }
});

app.post('/api/manager/daily_logs', async (req, res) => {
  try {
    const { log_date, cashier_name, manager_name, opening_cash, closing_cash, cash_discrepancy, weather_summary, incidents_count, operational_notes, manager_signoff } = req.body;
    const result = await db.query(
      `INSERT INTO daily_logs (
        log_date, cashier_name, manager_name, opening_cash, closing_cash, cash_discrepancy, weather_summary, incidents_count, operational_notes, manager_signoff
      ) VALUES (COALESCE($1, CURRENT_DATE), $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        log_date || null, cashier_name || 'Cashier', manager_name || 'Manager',
        parseFloat(opening_cash) || 50.00, parseFloat(closing_cash) || 0.00,
        parseFloat(cash_discrepancy) || 0.00, weather_summary || 'Clear',
        parseInt(incidents_count, 10) || 0, operational_notes || '', !!manager_signoff
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating daily log:', err);
    res.status(500).json({ error: 'Failed to create daily log' });
  }
});

app.put('/api/manager/daily_logs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { operational_notes, manager_signoff, closing_cash, cash_discrepancy } = req.body;
    const result = await db.query(
      `UPDATE daily_logs
       SET operational_notes = COALESCE($1, operational_notes),
           manager_signoff = COALESCE($2, manager_signoff),
           closing_cash = COALESCE($3, closing_cash),
           cash_discrepancy = COALESCE($4, cash_discrepancy)
       WHERE id = $5 RETURNING *`,
      [operational_notes, manager_signoff, closing_cash, cash_discrepancy, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Daily log not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating daily log:', err);
    res.status(500).json({ error: 'Failed to update daily log' });
  }
});

app.delete('/api/manager/daily_logs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM daily_logs WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting daily log:', err);
    res.status(500).json({ error: 'Failed to delete daily log' });
  }
});

// 4. Security & Weather Engine Settings
app.get('/api/manager/security_settings', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM security_settings ORDER BY id DESC LIMIT 1');
    if (result.rows.length === 0) {
      return res.json({
        crowd_ai_sensitivity: 'NORMAL',
        hostile_audio_threshold: 75,
        hostile_audio_enabled: true,
        dvr_retention_minutes: 60,
        auto_bookmark_hostile: true,
        weather_hot_temp: 75.0,
        weather_cold_temp: 50.0,
        weather_hot_discount: 0.25,
        weather_cold_discount: 0.25,
        manual_weather_override: 'AUTO'
      });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching security settings:', err);
    res.status(500).json({ error: 'Failed to fetch security settings' });
  }
});

app.put('/api/manager/security_settings', async (req, res) => {
  try {
    const { crowd_ai_sensitivity, hostile_audio_threshold, hostile_audio_enabled, dvr_retention_minutes, auto_bookmark_hostile, weather_hot_temp, weather_cold_temp, weather_hot_discount, weather_cold_discount, manual_weather_override } = req.body;
    
    await db.query(`DELETE FROM security_settings`);
    const result = await db.query(
      `INSERT INTO security_settings (
        crowd_ai_sensitivity, hostile_audio_threshold, hostile_audio_enabled,
        dvr_retention_minutes, auto_bookmark_hostile, weather_hot_temp,
        weather_cold_temp, weather_hot_discount, weather_cold_discount, manual_weather_override, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
      RETURNING *`,
      [
        crowd_ai_sensitivity || 'NORMAL', parseInt(hostile_audio_threshold, 10) || 75,
        hostile_audio_enabled !== undefined ? !!hostile_audio_enabled : true,
        parseInt(dvr_retention_minutes, 10) || 60,
        auto_bookmark_hostile !== undefined ? !!auto_bookmark_hostile : true,
        parseFloat(weather_hot_temp) || 75.0, parseFloat(weather_cold_temp) || 50.0,
        parseFloat(weather_hot_discount) || 0.25, parseFloat(weather_cold_discount) || 0.25,
        manual_weather_override || 'AUTO'
      ]
    );

    // Broadcast updated settings to displays
    broadcastToDisplayClients({
      type: 'security_settings_updated',
      settings: result.rows[0]
    });

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating security settings:', err);
    res.status(500).json({ error: 'Failed to update security settings' });
  }
});

// ----------------------------------------------------
// 🤖 KYRO CLOUD AI API GATEWAY INTEGRATION
// ----------------------------------------------------
const KYRO_API_URL = 'https://kyro-api-auou.onrender.com/v1/chat/completions';
const KYRO_API_KEY = process.env.KYRO_API_KEY || 'kyro_sk_live_AZaSMSvATejSUM4OAVVnjw-cogIz4q7b';

async function callKyroAI(messages, model = 'kyro-flash-8b', maxTokens = 600, temperature = 0.2) {
  try {
    const res = await fetch(KYRO_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${KYRO_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        max_tokens: maxTokens,
        temperature: temperature
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn('Kyro AI Gateway Error status:', res.status, errText);
      return null;
    }

    const data = await res.json();
    let content = data.choices?.[0]?.message?.content || '';
    // Strip <think>...</think> reasoning blocks from Qwen/Llama models if present (closed or unclosed)
    content = content.replace(/<think>[\s\S]*?<\/think>/gi, '');
    content = content.replace(/<think>[\s\S]*$/gi, '').trim();
    return content;
  } catch (err) {
    console.warn('Kyro AI call failed (offline fallback):', err.message);
    return null;
  }
}

// 1. Voice-to-Cart Natural Language Ordering
app.post('/api/ai/voice-to-cart', async (req, res) => {
  try {
    const { speechText } = req.body;
    if (!speechText || !speechText.trim()) {
      return res.status(400).json({ error: 'Speech text is required.' });
    }

    // Get current active products
    const prodRes = await db.query(`SELECT id, name, price, emoji FROM products WHERE is_active = TRUE`);
    const catalog = prodRes.rows;

    const catalogList = catalog.map(p => `ID:${p.id} | "${p.name}" | $${p.price}`).join('\n');

    const prompt = `You are a cashier speech parser for Jordan's Snack Shack school store.
Convert the cashier/customer speech order into a structured list of cart items matching our exact product catalog IDs.

CURRENT CATALOG:
${catalogList}

CUSTOMER SPEECH ORDER:
"${speechText}"

Return ONLY a JSON array in this exact format:
[{"id": <number>, "quantity": <number>, "name": "<product name>", "price": <number>}]

If no products match, return []. Do not include markdown formatting, backticks, or other text.`;

    const aiResponse = await callKyroAI([
      { role: 'system', content: 'You extract items and quantities from cashier voice input into strict JSON arrays.' },
      { role: 'user', content: prompt }
    ], 'kyro-flash-8b', 600, 0.1);

    let parsedItems = [];
    if (aiResponse) {
      try {
        const cleanJson = aiResponse.replace(/```json/gi, '').replace(/```/g, '').trim();
        parsedItems = JSON.parse(cleanJson);
      } catch (parseErr) {
        console.warn('AI Voice-to-cart JSON parse error:', parseErr.message);
      }
    }

    // Fallback heuristic if AI parsing returned empty or failed
    if (!Array.isArray(parsedItems) || parsedItems.length === 0) {
      const lower = speechText.toLowerCase();
      catalog.forEach(p => {
        const pName = p.name.toLowerCase();
        if (lower.includes(pName)) {
          parsedItems.push({ id: p.id, quantity: 1, name: p.name, price: parseFloat(p.price) });
        }
      });
    }

    res.json({
      success: true,
      originalText: speechText,
      items: parsedItems
    });
  } catch (err) {
    console.error('Voice to cart error:', err);
    res.status(500).json({ error: 'Failed to process voice order' });
  }
});

// 2. AI Restock Predictor & Demand Forecasting for Locker Vault #314
app.post('/api/ai/restock-forecast', async (req, res) => {
  try {
    const productsRes = await db.query(`
      SELECT p.id, p.name, p.stock_quantity, p.low_stock_threshold, p.price, p.cost_price,
             COALESCE(SUM(oi.quantity), 0) as total_sold_recent
      FROM products p
      LEFT JOIN order_items oi ON p.id = oi.product_id
      WHERE p.is_active = TRUE
      GROUP BY p.id
      ORDER BY p.stock_quantity ASC
    `);

    const inventoryData = productsRes.rows.map(p => 
      `${p.name}: Stock = ${p.stock_quantity} (Low Threshold: ${p.low_stock_threshold}), Sold Recently = ${p.total_sold_recent}`
    ).join('\n');

    const prompt = `You are the AI Inventory & Logistics Manager for Jordan's Snack Shack (Storage Locker Vault #314).
Analyze the current stock levels and sales velocity below. Provide:
1. Urgent Restock Items (items below threshold or high sales velocity).
2. Recommended replenishment quantities to fetch from Locker Vault #314.
3. A 2-sentence actionable operational summary for student volunteers.

INVENTORY AUDIT:
${inventoryData}`;

    const aiForecast = await callKyroAI([
      { role: 'system', content: 'You are an operations and logistics inventory specialist for a high-volume school snack store. Provide a concise, directly formatted restock breakdown without internal chain-of-thought.' },
      { role: 'user', content: prompt }
    ], 'kyro-ultra-70b', 1200, 0.3);

    res.json({
      success: true,
      forecast: aiForecast || 'All current stock levels are within normal operating margins. Keep Locker Vault #314 stocked with extra chips and cold beverages.'
    });
  } catch (err) {
    console.error('Restock forecast error:', err);
    res.status(500).json({ error: 'Failed to generate restock forecast' });
  }
});

// 3. AI Incident Report Synthesizer & Recommendations
app.post('/api/ai/incident-summary', async (req, res) => {
  try {
    const { incidentType, rawNotes, location } = req.body;
    const prompt = `You are a school store security and safety compliance officer.
Generate a formal, professional incident report summary and 2 recommended corrective actions based on the following raw notes:
Incident Type: ${incidentType || 'Security Notice'}
Location: ${location || 'Station Table 4B'}
Raw Notes: "${rawNotes || 'No notes'}"

Format output cleanly with:
- Formal Incident Summary
- Severity Assessment (LOW / MEDIUM / HIGH)
- Recommended Protocol & Prevention Action`;

    const summary = await callKyroAI([
      { role: 'system', content: 'You write concise, professional school security incident assessments.' },
      { role: 'user', content: prompt }
    ], 'kyro-ultra-70b', 500, 0.2);

    res.json({ success: true, summary: summary || rawNotes });
  } catch (err) {
    console.error('Incident summary error:', err);
    res.status(500).json({ error: 'Failed to synthesize incident' });
  }
});

// 4. Live School Trivia Generator & Prize Engine
app.get('/api/ai/trivia', async (req, res) => {
  try {
    // Try pulling from DB first
    const dbTrivia = await db.query(`SELECT * FROM trivia_questions ORDER BY RANDOM() LIMIT 1`);
    if (dbTrivia.rows.length > 0 && Math.random() > 0.4) {
      const row = dbTrivia.rows[0];
      return res.json({
        id: row.id,
        question: row.question,
        options: typeof row.options === 'string' ? JSON.parse(row.options) : row.options,
        correct_index: row.correct_index,
        category: row.category,
        reward_text: row.reward_text
      });
    }

    // Generate fresh trivia with Kyro AI
    const prompt = `Generate 1 fun, multiple-choice school/science/math/sports trivia question for high school students waiting in line at a snack store.
Return ONLY a JSON object with this exact format:
{
  "question": "...",
  "options": ["Option A", "Option B", "Option C", "Option D"],
  "correct_index": 0,
  "category": "Science / General Knowledge",
  "reward_text": "⭐ +1 Loyalty Stamp!"
}
No additional markdown or commentary.`;

    const aiRes = await callKyroAI([
      { role: 'system', content: 'You generate trivia questions formatted strictly as JSON objects.' },
      { role: 'user', content: prompt }
    ], 'kyro-flash-8b', 300, 0.7);

    if (aiRes) {
      try {
        const clean = aiRes.replace(/```json/gi, '').replace(/```/g, '').trim();
        const triviaObj = JSON.parse(clean);
        return res.json(triviaObj);
      } catch (e) {}
    }

    // Fallback trivia
    res.json({
      question: "How many loyalty punch stamps earn a 100% FREE snack reward?",
      options: ["5 Stamps", "10 Stamps", "15 Stamps", "20 Stamps"],
      correct_index: 1,
      category: "Snack Shack Loyalty",
      reward_text: "⭐ +1 Bonus Stamp!"
    });
  } catch (err) {
    console.error('Trivia generation error:', err);
    res.json({
      question: "What is the speed of light approximately in vacuum?",
      options: ["300,000 km/s", "150,000 km/s", "500,000 km/s", "1,000,000 km/s"],
      correct_index: 0,
      category: "Physics",
      reward_text: "🎟️ 10¢ Off Any Snack!"
    });
  }
});

// ----------------------------------------------------
// 🤝 VOLUNTEER GOVERNANCE & LEADERBOARD
// ----------------------------------------------------
app.get('/api/volunteers', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT v.*,
             (SELECT COUNT(*) FROM volunteer_shifts vs WHERE vs.volunteer_id = v.id AND vs.status = 'ACTIVE') > 0 as is_clocked_in,
             (SELECT clock_in FROM volunteer_shifts vs WHERE vs.volunteer_id = v.id AND vs.status = 'ACTIVE' ORDER BY id DESC LIMIT 1) as active_clock_in
      FROM volunteers v
      WHERE v.is_active = TRUE
      ORDER BY v.points DESC, v.total_hours DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching volunteers:', err);
    res.status(500).json({ error: 'Failed to fetch volunteers' });
  }
});

app.post('/api/volunteers', async (req, res) => {
  try {
    const { name, role, pin, avatar_emoji } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    const result = await db.query(
      `INSERT INTO volunteers (name, role, pin, avatar_emoji) VALUES ($1, $2, $3, $4) RETURNING *`,
      [name.trim(), role || 'Student Volunteer', pin || '1234', avatar_emoji || '🌟']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating volunteer:', err);
    res.status(500).json({ error: 'Failed to create volunteer' });
  }
});

app.post('/api/volunteers/clock-in', async (req, res) => {
  try {
    const { volunteer_id, pin } = req.body;
    const vol = await db.query('SELECT * FROM volunteers WHERE id = $1', [volunteer_id]);
    if (vol.rows.length === 0) return res.status(404).json({ error: 'Volunteer not found' });
    if (pin && vol.rows[0].pin !== pin) return res.status(401).json({ error: 'Invalid volunteer PIN code' });

    // Check if already active
    const activeShift = await db.query(`SELECT * FROM volunteer_shifts WHERE volunteer_id = $1 AND status = 'ACTIVE'`, [volunteer_id]);
    if (activeShift.rows.length > 0) {
      return res.json({ message: 'Volunteer already clocked in', shift: activeShift.rows[0] });
    }

    const shift = await db.query(
      `INSERT INTO volunteer_shifts (volunteer_id, volunteer_name, clock_in, status)
       VALUES ($1, $2, CURRENT_TIMESTAMP, 'ACTIVE') RETURNING *`,
      [volunteer_id, vol.rows[0].name]
    );

    res.json({ success: true, shift: shift.rows[0], volunteer: vol.rows[0] });
  } catch (err) {
    console.error('Clock in error:', err);
    res.status(500).json({ error: 'Failed to clock in' });
  }
});

app.post('/api/volunteers/clock-out', async (req, res) => {
  try {
    const { volunteer_id, orders_served, notes } = req.body;
    const activeShift = await db.query(
      `SELECT * FROM volunteer_shifts WHERE volunteer_id = $1 AND status = 'ACTIVE' ORDER BY id DESC LIMIT 1`,
      [volunteer_id]
    );

    if (activeShift.rows.length === 0) {
      return res.status(400).json({ error: 'No active shift found for this volunteer.' });
    }

    const shiftId = activeShift.rows[0].id;
    const clockInTime = new Date(activeShift.rows[0].clock_in).getTime();
    const clockOutTime = Date.now();
    const hours = Math.max(0.1, parseFloat(((clockOutTime - clockInTime) / (1000 * 60 * 60)).toFixed(2)));
    const orders = parseInt(orders_served, 10) || 0;
    const pointsAwarded = Math.round(hours * 20 + orders * 5);

    await db.query(
      `UPDATE volunteer_shifts
       SET clock_out = CURRENT_TIMESTAMP,
           hours_worked = $1,
           orders_processed = $2,
           notes = $3,
           status = 'COMPLETED'
       WHERE id = $4`,
      [hours, orders, notes || '', shiftId]
    );

    await db.query(
      `UPDATE volunteers
       SET total_hours = total_hours + $1,
           total_orders_served = total_orders_served + $2,
           points = points + $3
       WHERE id = $4`,
      [hours, orders, pointsAwarded, volunteer_id]
    );

    res.json({
      success: true,
      hoursWorked: hours,
      ordersProcessed: orders,
      pointsEarned: pointsAwarded
    });
  } catch (err) {
    console.error('Clock out error:', err);
    res.status(500).json({ error: 'Failed to clock out' });
  }
});

app.get('/api/volunteers/leaderboard', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, name, role, avatar_emoji, total_hours, total_orders_served, points
      FROM volunteers
      WHERE is_active = TRUE
      ORDER BY points DESC, total_hours DESC
      LIMIT 10
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Leaderboard error:', err);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// ----------------------------------------------------
// 🍟 SMART COMBOS & BUNDLES ENGINE
// ----------------------------------------------------
app.get('/api/combos', async (req, res) => {
  try {
    const result = await db.query(`SELECT * FROM combo_deals WHERE is_active = TRUE ORDER BY bundle_price ASC`);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching combos:', err);
    res.status(500).json({ error: 'Failed to fetch combos' });
  }
});

app.post('/api/combos', async (req, res) => {
  try {
    const { name, description, bundle_price, item_requirements } = req.body;
    const result = await db.query(
      `INSERT INTO combo_deals (name, description, bundle_price, item_requirements)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, description || '', parseFloat(bundle_price) || 2.50, JSON.stringify(item_requirements || [])]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating combo:', err);
    res.status(500).json({ error: 'Failed to create combo' });
  }
});

// ----------------------------------------------------
// 🧾 MOBILE DIGITAL RECEIPT & FINANCIAL Z-REPORT
// ----------------------------------------------------
app.get('/api/receipt/:orderNumber', async (req, res) => {
  try {
    const { orderNumber } = req.params;
    const orderRes = await db.query(`
      SELECT o.*, s.name as student_name, s.student_id as student_code, s.balance as student_balance, s.punch_card
      FROM orders o
      LEFT JOIN students s ON o.student_id = s.id
      WHERE o.order_number = $1
    `, [orderNumber]);

    if (orderRes.rows.length === 0) {
      return res.status(404).json({ error: 'Receipt not found' });
    }

    const order = orderRes.rows[0];
    const itemsRes = await db.query(`
      SELECT * FROM order_items WHERE order_id = $1
    `, [order.id]);

    res.json({
      order: order,
      items: itemsRes.rows
    });
  } catch (err) {
    console.error('Receipt fetch error:', err);
    res.status(500).json({ error: 'Failed to load receipt' });
  }
});

// End of Day Z-Report
app.get('/api/reports/z-report', async (req, res) => {
  try {
    const summaryRes = await db.query(`
      SELECT 
        COUNT(*) as total_transactions,
        COALESCE(SUM(total), 0) as gross_sales,
        COALESCE(SUM(subtotal), 0) as gross_subtotal,
        COALESCE(SUM(discount), 0) as total_discounts,
        COALESCE(SUM(tax), 0) as total_tax,
        COALESCE(SUM(tip_amount), 0) as total_tips
      FROM orders
      WHERE created_at::date = CURRENT_DATE
    `);

    const paymentsRes = await db.query(`
      SELECT payment_method, COUNT(*) as count, COALESCE(SUM(total), 0) as amount
      FROM orders
      WHERE created_at::date = CURRENT_DATE
      GROUP BY payment_method
    `);

    const itemsRes = await db.query(`
      SELECT oi.product_name, SUM(oi.quantity) as qty_sold, SUM(oi.total_price) as revenue
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE o.created_at::date = CURRENT_DATE
      GROUP BY oi.product_name
      ORDER BY qty_sold DESC
    `);

    res.json({
      report_date: new Date().toLocaleDateString(),
      generated_at: new Date().toLocaleTimeString(),
      summary: summaryRes.rows[0],
      payment_breakdown: paymentsRes.rows,
      top_selling_items: itemsRes.rows
    });
  } catch (err) {
    console.error('Z-Report error:', err);
    res.status(500).json({ error: 'Failed to generate Z-Report' });
  }
});

// ----------------------------------------------------
// 🚨 EMERGENCY COUNTER LOCKDOWN / PANIC PROTOCOL
// ----------------------------------------------------
app.post('/api/security/panic', (req, res) => {
  const now = Date.now();
  const timeStr = new Date(now).toLocaleTimeString();

  broadcastToDisplayClients({
    type: 'panic_lockdown',
    timestamp: now,
    message: 'EMERGENCY LOCKDOWN INITIATED'
  });

  // Log to database
  db.query(
    `INSERT INTO security_incidents (incident_tag, label, zone, severity, notes)
     VALUES ($1, $2, $3, $4, $5)`,
    [`PANIC-${Math.floor(1000 + Math.random() * 9000)}`, 'Emergency Register Panic Lockdown', 'Table 4B', 'CRITICAL', `Manual emergency lockdown hotkey triggered at ${timeStr}`]
  ).catch(()=>{});

  res.json({ success: true, message: `🚨 Emergency Lockdown Signal Broadcast at ${timeStr}` });
});

// Public Mobile Receipt Web Viewer Route
app.get('/receipt/:orderNumber', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'receipt.html'));
});

app.get('/api/network-info', (req, res) => {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  const primaryIp = ips[0] || 'localhost';
  res.json({
    primaryIp,
    ips,
    port: PORT,
    displayUrl: `http://${primaryIp}:${PORT}/display`,
    orderUrl: `http://${primaryIp}:${PORT}/order`,
    portalUrl: `http://${primaryIp}:${PORT}/portal`
  });
});

// Routing
app.get(['/display', '/customer-display', '/screen'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'display.html'));
});

app.get(['/portal', '/balance', '/student'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'portal.html'));
});

app.get(['/order', '/preorder'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'preorder.html'));
});

app.get(['/sop', '/manual', '/guide'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sop.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, async () => {
  console.log(`🍿 Jordan's Snack Shack POS running on port ${PORT}`);
  try {
    await db.initDB();
  } catch (e) {
    console.error('DB Initialization failed on startup:', e);
  }
});

process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception in server process:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled Rejection in server process:', reason);
});

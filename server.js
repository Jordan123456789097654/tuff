const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper to generate readable Order Number
function generateOrderNumber() {
  const dateStr = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `ORD-${dateStr}-${rand}`;
}

// ----------------------------------------------------
// PRODUCT & CATEGORY ENDPOINTS
// ----------------------------------------------------

// Get all products with category info
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

// Create a new product
app.post('/api/products', async (req, res) => {
  try {
    const { name, category_id, price, cost_price, stock_quantity, low_stock_threshold, emoji, allergy_info } = req.body;
    if (!name || price === undefined) {
      return res.status(400).json({ error: 'Product name and price are required.' });
    }

    const result = await db.query(
      `INSERT INTO products (name, category_id, price, cost_price, stock_quantity, low_stock_threshold, emoji, allergy_info)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        name,
        category_id || null,
        parseFloat(price) || 1.0,
        parseFloat(cost_price) || 0.5,
        parseInt(stock_quantity, 10) || 0,
        parseInt(low_stock_threshold, 10) || 10,
        emoji || '🍪',
        allergy_info || ''
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating product:', err);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// Update product
app.put('/api/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, category_id, price, cost_price, low_stock_threshold, emoji, allergy_info, is_active } = req.body;

    const result = await db.query(
      `UPDATE products
       SET name = COALESCE($1, name),
           category_id = COALESCE($2, category_id),
           price = COALESCE($3, price),
           cost_price = COALESCE($4, cost_price),
           low_stock_threshold = COALESCE($5, low_stock_threshold),
           emoji = COALESCE($6, emoji),
           allergy_info = COALESCE($7, allergy_info),
           is_active = COALESCE($8, is_active)
       WHERE id = $9 RETURNING *`,
      [name, category_id, price, cost_price, low_stock_threshold, emoji, allergy_info, is_active, id]
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

// Restock product (add stock quantity)
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

// Categories list
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
// STUDENT ACCOUNTS & PASSES
// ----------------------------------------------------

// Get all or search students
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

// Get single student by ID
app.get('/api/students/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query('SELECT * FROM students WHERE id = $1 OR student_id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching student:', err);
    res.status(500).json({ error: 'Failed to fetch student' });
  }
});

// Create new student account
app.post('/api/students', async (req, res) => {
  try {
    const { student_id, name, grade, balance, daily_limit, allergies, notes } = req.body;
    if (!student_id || !name) {
      return res.status(400).json({ error: 'Student ID and name are required.' });
    }

    const result = await db.query(
      `INSERT INTO students (student_id, name, grade, balance, daily_limit, allergies, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        student_id.trim().toUpperCase(),
        name.trim(),
        grade || '6th Grade',
        parseFloat(balance) || 0.00,
        parseFloat(daily_limit) || 5.00,
        allergies || '',
        notes || ''
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Student ID already exists.' });
    }
    console.error('Error creating student:', err);
    res.status(500).json({ error: 'Failed to create student' });
  }
});

// Recharge student balance
app.post('/api/students/:id/recharge', async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, notes } = req.body;
    const addAmt = parseFloat(amount);

    if (isNaN(addAmt) || addAmt <= 0) {
      return res.status(400).json({ error: 'Invalid recharge amount.' });
    }

    const result = await db.query(
      `UPDATE students
       SET balance = balance + $1,
           notes = CASE WHEN $2 != '' THEN CONCAT(notes, ' | Reloaded $', $1, ' (', $2, ')') ELSE notes END
       WHERE id = $3 RETURNING *`,
      [addAmt, notes || 'Cash Deposit', id]
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

// Update student details
app.put('/api/students/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, grade, daily_limit, allergies, notes } = req.body;

    const result = await db.query(
      `UPDATE students
       SET name = COALESCE($1, name),
           grade = COALESCE($2, grade),
           daily_limit = COALESCE($3, daily_limit),
           allergies = COALESCE($4, allergies),
           notes = COALESCE($5, notes)
       WHERE id = $6 RETURNING *`,
      [name, grade, daily_limit, allergies, notes, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating student:', err);
    res.status(500).json({ error: 'Failed to update student profile' });
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
      discount = 0,
      tax = 0,
      amount_paid,
      cashier_name = 'Student Volunteer',
      notes = ''
    } = req.body;

    if (!cart || !Array.isArray(cart) || cart.length === 0) {
      return res.status(400).json({ error: 'Cart cannot be empty.' });
    }

    await client.query('BEGIN');

    // 1. Calculate and verify cart items
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

      if (product.stock_quantity < qty) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Insufficient stock for "${product.name}". Only ${product.stock_quantity} left!`
        });
      }

      const itemTotal = parseFloat(product.price) * qty;
      subtotal += itemTotal;

      preparedItems.push({
        product_id: product.id,
        product_name: product.name,
        unit_price: parseFloat(product.price),
        unit_cost: parseFloat(product.cost_price),
        quantity: qty,
        total_price: itemTotal,
        new_stock: product.stock_quantity - qty,
        prev_stock: product.stock_quantity
      });
    }

    const discountAmt = Math.min(parseFloat(discount) || 0, subtotal);
    const taxAmt = parseFloat(tax) || 0;
    const total = Math.max(0, subtotal - discountAmt + taxAmt);
    const paid = parseFloat(amount_paid) !== undefined ? parseFloat(amount_paid) : total;
    const changeDue = Math.max(0, paid - total);

    // 2. Handle Student Account payment validation
    let resolvedStudentId = null;
    if (payment_method === 'student_account') {
      if (!student_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Please select a student account for this payment method.' });
      }

      const studentRes = await client.query(
        'SELECT * FROM students WHERE id = $1 OR student_id = $1 FOR UPDATE',
        [student_id]
      );

      if (studentRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Student account not found.' });
      }

      const student = studentRes.rows[0];
      resolvedStudentId = student.id;

      if (parseFloat(student.balance) < total) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Insufficient account balance! Student has $${parseFloat(student.balance).toFixed(2)}, but total is $${total.toFixed(2)}.`
        });
      }

      // Check daily limit (resets if date changed)
      const todayStr = new Date().toISOString().slice(0, 10);
      const lastSpentStr = student.last_spent_date ? new Date(student.last_spent_date).toISOString().slice(0, 10) : '';
      const spentToday = (lastSpentStr === todayStr) ? parseFloat(student.spent_today) : 0;
      const dailyLimit = parseFloat(student.daily_limit);

      if (dailyLimit > 0 && (spentToday + total) > dailyLimit) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Daily limit exceeded! Limit is $${dailyLimit.toFixed(2)}. Student already spent $${spentToday.toFixed(2)} today.`
        });
      }

      // Deduct student balance and update daily spent
      await client.query(
        `UPDATE students
         SET balance = balance - $1,
             spent_today = $2 + $1,
             last_spent_date = CURRENT_DATE
         WHERE id = $3`,
        [total, spentToday, student.id]
      );
    }

    // 3. Create Order
    const orderNumber = generateOrderNumber();
    const orderRes = await client.query(
      `INSERT INTO orders (order_number, cashier_name, payment_method, student_id, subtotal, discount, tax, total, amount_paid, change_due, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [orderNumber, cashier_name, payment_method, resolvedStudentId, subtotal, discountAmt, taxAmt, total, paid, changeDue, notes]
    );
    const order = orderRes.rows[0];

    // 4. Insert Order Items & Deduct Product Inventory
    for (const item of preparedItems) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, unit_price, unit_cost, quantity, total_price)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [order.id, item.product_id, item.product_name, item.unit_price, item.unit_cost, item.quantity, item.total_price]
      );

      // Deduct stock
      await client.query('UPDATE products SET stock_quantity = $1 WHERE id = $2', [item.new_stock, item.product_id]);

      // Inventory log
      await client.query(
        `INSERT INTO inventory_logs (product_id, change_qty, previous_stock, new_stock, reason)
         VALUES ($1, $2, $3, $4, $5)`,
        [item.product_id, -item.quantity, item.prev_stock, item.new_stock, `Order ${orderNumber}`]
      );
    }

    await client.query('COMMIT');

    // Return complete receipt data
    order.items = preparedItems;
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

// Get Order History
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

    // Fetch items for these orders
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
// SHIFT & CASH DRAWER MANAGEMENT
// ----------------------------------------------------

// Get active shift
app.get('/api/shifts/current', async (req, res) => {
  try {
    const shiftRes = await db.query(
      'SELECT * FROM shifts WHERE is_open = TRUE ORDER BY opened_at DESC LIMIT 1'
    );

    if (shiftRes.rows.length === 0) {
      return res.json({ active: false, shift: null });
    }

    const shift = shiftRes.rows[0];

    // Compute cash sales since shift opened
    const cashSalesRes = await db.query(
      `SELECT COALESCE(SUM(total), 0) as cash_total, COUNT(*) as order_count
       FROM orders
       WHERE payment_method = 'cash' AND created_at >= $1`,
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

// Open new shift
app.post('/api/shifts/open', async (req, res) => {
  try {
    const { cashier_name, start_cash } = req.body;

    // Check if open shift exists
    const existing = await db.query('SELECT * FROM shifts WHERE is_open = TRUE LIMIT 1');
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'A shift is already open. Please close the active shift first.' });
    }

    const result = await db.query(
      `INSERT INTO shifts (cashier_name, start_cash, is_open)
       VALUES ($1, $2, TRUE) RETURNING *`,
      [cashier_name || 'Cashier', parseFloat(start_cash) || 50.00]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error opening shift:', err);
    res.status(500).json({ error: 'Failed to open shift' });
  }
});

// Close shift & audit cash drawer
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

    // Compute expected
    const cashSalesRes = await db.query(
      `SELECT COALESCE(SUM(total), 0) as cash_total
       FROM orders
       WHERE payment_method = 'cash' AND created_at >= $1`,
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
// ANALYTICS & REPORTS
// ----------------------------------------------------

app.get('/api/analytics/summary', async (req, res) => {
  try {
    // Total Revenue & Profit Today
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

    // All-time sales
    const allTimeRes = await db.query(`
      SELECT 
        COALESCE(SUM(total), 0) as total_revenue,
        COUNT(*) as total_orders
      FROM orders
    `);

    // Top Selling Items
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

    // Payment method breakdown
    const paymentRes = await db.query(`
      SELECT payment_method, COUNT(*) as count, SUM(total) as amount
      FROM orders
      GROUP BY payment_method
      ORDER BY amount DESC
    `);

    // Low stock alerts
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

// CSV Export Endpoint
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
        o.tax, 
        o.total, 
        o.notes
      FROM orders o
      LEFT JOIN students s ON o.student_id = s.id
      ORDER BY o.created_at DESC
    `);

    let csv = 'Order Number,Date & Time,Cashier,Payment Method,Student Account,Subtotal,Discount,Tax,Total,Notes\n';
    orders.rows.forEach(r => {
      csv += `"${r.order_number}","${new Date(r.created_at).toLocaleString()}","${r.cashier_name}","${r.payment_method}","${r.student_name || 'N/A'}",${r.subtotal},${r.discount},${r.tax},${r.total},"${(r.notes || '').replace(/"/g, '""')}"\n`;
    });

    res.header('Content-Type', 'text/csv');
    res.attachment(`jordans_snack_shack_sales_${new Date().toISOString().slice(0, 10)}.csv`);
    res.send(csv);
  } catch (err) {
    console.error('Error generating export:', err);
    res.status(500).json({ error: 'Failed to export CSV' });
  }
});

// Fallback to index.html for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server and Initialize Database
app.listen(PORT, async () => {
  console.log(`🍿 Jordan's Snack Shack POS running on port ${PORT}`);
  try {
    await db.initDB();
  } catch (e) {
    console.error('DB Initialization failed on startup:', e);
  }
});

const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false
  },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

async function initDB() {
  const client = await pool.connect();
  try {
    console.log('⚡ Connected to PostgreSQL. Verifying schema...');

    await client.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        icon VARCHAR(50) DEFAULT '🍿',
        sort_order INT DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        category_id INT REFERENCES categories(id) ON DELETE SET NULL,
        barcode VARCHAR(100),
        price NUMERIC(10, 2) NOT NULL DEFAULT 1.00,
        cost_price NUMERIC(10, 2) NOT NULL DEFAULT 0.50,
        stock_quantity INT NOT NULL DEFAULT 0,
        low_stock_threshold INT NOT NULL DEFAULT 10,
        emoji VARCHAR(50) DEFAULT '🍪',
        allergy_info TEXT DEFAULT '',
        is_open_price BOOLEAN DEFAULT FALSE,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE products ADD COLUMN IF NOT EXISTS is_open_price BOOLEAN DEFAULT FALSE;

      CREATE TABLE IF NOT EXISTS students (
        id SERIAL PRIMARY KEY,
        student_id VARCHAR(50) NOT NULL UNIQUE,
        name VARCHAR(150) NOT NULL,
        grade VARCHAR(50) DEFAULT '6th Grade',
        balance NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
        daily_limit NUMERIC(10, 2) NOT NULL DEFAULT 10.00,
        spent_today NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
        last_spent_date DATE DEFAULT CURRENT_DATE,
        punch_card INT NOT NULL DEFAULT 0,
        free_rewards INT NOT NULL DEFAULT 0,
        allergies TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE students ADD COLUMN IF NOT EXISTS punch_card INT NOT NULL DEFAULT 0;
      ALTER TABLE students ADD COLUMN IF NOT EXISTS free_rewards INT NOT NULL DEFAULT 0;

      CREATE TABLE IF NOT EXISTS preorders (
        id SERIAL PRIMARY KEY,
        order_number VARCHAR(50) NOT NULL UNIQUE,
        customer_name VARCHAR(150) NOT NULL,
        student_id VARCHAR(50),
        pickup_period VARCHAR(50) NOT NULL DEFAULT 'Lunch Period',
        status VARCHAR(50) NOT NULL DEFAULT 'pending', -- 'pending', 'ready', 'completed', 'cancelled'
        items JSONB NOT NULL,
        subtotal NUMERIC(10, 2) NOT NULL,
        total NUMERIC(10, 2) NOT NULL,
        payment_method VARCHAR(50) DEFAULT 'pay_at_pickup',
        notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS store_settings (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS discounts (
        id SERIAL PRIMARY KEY,
        code VARCHAR(50) NOT NULL UNIQUE,
        name VARCHAR(100) NOT NULL,
        discount_type VARCHAR(20) NOT NULL DEFAULT 'percentage',
        discount_value NUMERIC(10, 2) NOT NULL,
        min_order NUMERIC(10, 2) DEFAULT 0.00,
        is_active BOOLEAN DEFAULT TRUE
      );

      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        order_number VARCHAR(50) NOT NULL UNIQUE,
        cashier_name VARCHAR(100) DEFAULT 'Student Volunteer',
        payment_method VARCHAR(50) NOT NULL,
        student_id INT REFERENCES students(id) ON DELETE SET NULL,
        subtotal NUMERIC(10, 2) NOT NULL,
        discount NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
        discount_name VARCHAR(100),
        tax NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
        total NUMERIC(10, 2) NOT NULL,
        amount_paid NUMERIC(10, 2) NOT NULL,
        change_due NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
        punch_awarded BOOLEAN DEFAULT TRUE,
        reward_used BOOLEAN DEFAULT FALSE,
        notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_name VARCHAR(100);

      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id INT REFERENCES orders(id) ON DELETE CASCADE,
        product_id INT REFERENCES products(id) ON DELETE SET NULL,
        product_name VARCHAR(150) NOT NULL,
        unit_price NUMERIC(10, 2) NOT NULL,
        unit_cost NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
        quantity INT NOT NULL,
        total_price NUMERIC(10, 2) NOT NULL
      );

      CREATE TABLE IF NOT EXISTS inventory_logs (
        id SERIAL PRIMARY KEY,
        product_id INT REFERENCES products(id) ON DELETE CASCADE,
        change_qty INT NOT NULL,
        previous_stock INT NOT NULL,
        new_stock INT NOT NULL,
        reason VARCHAR(100) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS shifts (
        id SERIAL PRIMARY KEY,
        cashier_name VARCHAR(100) NOT NULL,
        opened_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        closed_at TIMESTAMP WITH TIME ZONE,
        start_cash NUMERIC(10, 2) NOT NULL DEFAULT 50.00,
        expected_cash NUMERIC(10, 2),
        actual_cash NUMERIC(10, 2),
        difference NUMERIC(10, 2),
        notes TEXT,
        is_open BOOLEAN DEFAULT TRUE
      );

      ALTER TABLE orders ADD COLUMN IF NOT EXISTS tip_amount NUMERIC(10, 2) DEFAULT 0.00;

      CREATE TABLE IF NOT EXISTS feedback_reviews (
        id SERIAL PRIMARY KEY,
        order_id INT REFERENCES orders(id) ON DELETE SET NULL,
        rating INT NOT NULL,
        emoji VARCHAR(20),
        comment TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS fundraiser_campaigns (
        id SERIAL PRIMARY KEY,
        name VARCHAR(150) NOT NULL UNIQUE,
        goal_amount NUMERIC(10, 2) DEFAULT 500.00,
        description TEXT DEFAULT '',
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE orders ADD COLUMN IF NOT EXISTS fundraiser_id INT REFERENCES fundraiser_campaigns(id) ON DELETE SET NULL;

      CREATE TABLE IF NOT EXISTS inventory_shrinkage (
        id SERIAL PRIMARY KEY,
        product_id INT REFERENCES products(id) ON DELETE CASCADE,
        product_name VARCHAR(150) NOT NULL,
        quantity INT NOT NULL,
        unit_cost NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
        total_cost_loss NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
        reason VARCHAR(100) NOT NULL, -- 'expired', 'damaged_melted', 'dropped_spilled', 'sample_giveaway', 'theft_missing'
        notes TEXT DEFAULT '',
        logged_by VARCHAR(100) DEFAULT 'Cashier',
        fundraiser_id INT REFERENCES fundraiser_campaigns(id) ON DELETE SET NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Ensure default fundraiser campaigns exist
    const fundCheck = await client.query('SELECT COUNT(*) FROM fundraiser_campaigns');
    if (parseInt(fundCheck.rows[0].count, 10) === 0) {
      const defaultFunds = [
        { name: 'General Student Activity Fund', goal: 1000.00, desc: 'School-wide activities, pep rallies, student store operations' },
        { name: '8th Grade Class DC / End of Year Trip', goal: 2500.00, desc: 'Subsidizing travel tickets and meals for 8th grade students' },
        { name: 'Robotics & STEM Club Competition Fund', goal: 750.00, desc: 'Sensors, motors, and tournament registration fees' },
        { name: 'Athletics & Gym Equipment', goal: 600.00, desc: 'New basketballs, recess gear, and team jerseys' },
      ];
      for (const fund of defaultFunds) {
        await client.query('INSERT INTO fundraiser_campaigns (name, goal_amount, description) VALUES ($1, $2, $3)', [
          fund.name, fund.goal, fund.desc
        ]);
      }
    }

    // Ensure standard categories exist
    const catCheck = await client.query('SELECT COUNT(*) FROM categories');
    if (parseInt(catCheck.rows[0].count, 10) === 0) {
      const catInserts = [
        { name: 'Chips & Crunchy', icon: '🥔', sort: 1 },
        { name: 'Candy & Sweets', icon: '🍬', sort: 2 },
        { name: 'Cold Drinks', icon: '🧃', sort: 3 },
        { name: 'Ice Cream & Pops', icon: '🍦', sort: 4 },
        { name: 'Baked & Fresh', icon: '🥨', sort: 5 },
        { name: 'Bake Sale & Custom', icon: '🍰', sort: 6 },
        { name: 'Combos & Deals', icon: '⭐', sort: 7 },
      ];

      for (const cat of catInserts) {
        await client.query('INSERT INTO categories (name, icon, sort_order) VALUES ($1, $2, $3)', [
          cat.name,
          cat.icon,
          cat.sort,
        ]);
      }
    }

    console.log('🎉 Database initialized with preorders, store settings, barcodes & QR support.');
  } catch (err) {
    console.error('❌ Error initializing database:', err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  initDB,
  query: (text, params) => pool.query(text, params),
};

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

pool.on('error', (err, client) => {
  console.warn('⚡ Unexpected error on idle PostgreSQL client (auto-reconnecting):', err.message);
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
      ALTER TABLE students ADD COLUMN IF NOT EXISTS is_flagged BOOLEAN DEFAULT FALSE;
      ALTER TABLE students ADD COLUMN IF NOT EXISTS watchlist_reason TEXT DEFAULT '';
      ALTER TABLE students ADD COLUMN IF NOT EXISTS unpaid_balance NUMERIC(10, 2) DEFAULT 0.00;

      CREATE TABLE IF NOT EXISTS security_incidents (
        id SERIAL PRIMARY KEY,
        incident_tag VARCHAR(50) NOT NULL,
        label VARCHAR(150) NOT NULL,
        student_id VARCHAR(50),
        student_name VARCHAR(150),
        zone VARCHAR(100) DEFAULT 'Table 4B',
        severity VARCHAR(50) DEFAULT 'high',
        clip_url TEXT,
        clip_name VARCHAR(150),
        notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS incident_reports (
        id SERIAL PRIMARY KEY,
        report_number VARCHAR(50) NOT NULL UNIQUE,
        incident_date DATE NOT NULL DEFAULT CURRENT_DATE,
        incident_time VARCHAR(20) NOT NULL,
        location VARCHAR(100) DEFAULT 'Table 4B',
        incident_type VARCHAR(50) NOT NULL,
        student_id INT REFERENCES students(id) ON DELETE SET NULL,
        student_name VARCHAR(150),
        severity VARCHAR(20) DEFAULT 'MEDIUM',
        description TEXT NOT NULL,
        action_taken TEXT DEFAULT '',
        status VARCHAR(20) DEFAULT 'PENDING',
        reported_by VARCHAR(100) DEFAULT 'Cashier Station',
        manager_notes TEXT DEFAULT '',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS daily_logs (
        id SERIAL PRIMARY KEY,
        log_date DATE NOT NULL DEFAULT CURRENT_DATE,
        shift_period VARCHAR(50) DEFAULT 'Morning Operational Window',
        cashier_name VARCHAR(100) NOT NULL,
        manager_name VARCHAR(100) DEFAULT 'Manager Lead',
        opening_cash NUMERIC(10, 2) DEFAULT 50.00,
        closing_cash NUMERIC(10, 2) DEFAULT 0.00,
        cash_discrepancy NUMERIC(10, 2) DEFAULT 0.00,
        weather_summary VARCHAR(100) DEFAULT 'Clear, 72°F',
        incidents_count INT DEFAULT 0,
        operational_notes TEXT DEFAULT '',
        manager_signoff BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS sop_documents (
        id SERIAL PRIMARY KEY,
        doc_title VARCHAR(150) NOT NULL DEFAULT 'Master Enterprise Standard Operating Procedures',
        version VARCHAR(20) NOT NULL DEFAULT '6.0',
        content TEXT NOT NULL,
        updated_by VARCHAR(100) DEFAULT 'Operations Manager',
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS security_settings (
        id SERIAL PRIMARY KEY,
        crowd_ai_sensitivity VARCHAR(20) DEFAULT 'NORMAL',
        hostile_audio_threshold INT DEFAULT 75,
        hostile_audio_enabled BOOLEAN DEFAULT TRUE,
        dvr_retention_minutes INT DEFAULT 60,
        auto_bookmark_hostile BOOLEAN DEFAULT TRUE,
        weather_hot_temp NUMERIC(5, 1) DEFAULT 75.0,
        weather_cold_temp NUMERIC(5, 1) DEFAULT 50.0,
        weather_hot_discount NUMERIC(5, 2) DEFAULT 0.25,
        weather_cold_discount NUMERIC(5, 2) DEFAULT 0.25,
        manual_weather_override VARCHAR(20) DEFAULT 'AUTO',
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

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

      ALTER TABLE students ADD COLUMN IF NOT EXISTS photo_data TEXT DEFAULT '';

      CREATE TABLE IF NOT EXISTS spin_wheel_logs (
        id SERIAL PRIMARY KEY,
        customer_identifier VARCHAR(150) NOT NULL,
        prize_won VARCHAR(150) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS staff_members (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        role VARCHAR(50) DEFAULT 'Cashier Volunteer',
        pin VARCHAR(10) DEFAULT '1234',
        emoji VARCHAR(10) DEFAULT '🧑‍💼',
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS snack_polls (
        id SERIAL PRIMARY KEY,
        option_name VARCHAR(100) NOT NULL UNIQUE,
        emoji VARCHAR(10) DEFAULT '🍿',
        votes INT DEFAULT 0
      );

      ALTER TABLE products ADD COLUMN IF NOT EXISTS calories INT DEFAULT 150;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS sugar VARCHAR(20) DEFAULT '2g';
      ALTER TABLE products ADD COLUMN IF NOT EXISTS carbs VARCHAR(20) DEFAULT '18g';
      ALTER TABLE products ADD COLUMN IF NOT EXISTS ingredients TEXT DEFAULT 'Corn, vegetable oil, seasoning, sea salt.';
      ALTER TABLE products ADD COLUMN IF NOT EXISTS dietary_badges TEXT DEFAULT 'Peanut-Free, Gluten-Free';

      ALTER TABLE students ADD COLUMN IF NOT EXISTS birthday VARCHAR(20) DEFAULT '';
      ALTER TABLE students ADD COLUMN IF NOT EXISTS streak_count INT DEFAULT 1;
      ALTER TABLE students ADD COLUMN IF NOT EXISTS last_visit_date DATE DEFAULT CURRENT_DATE;

      CREATE TABLE IF NOT EXISTS snack_wishlist (
        id SERIAL PRIMARY KEY,
        snack_name VARCHAR(150) NOT NULL,
        category VARCHAR(50) DEFAULT 'Snack',
        requested_by VARCHAR(100) DEFAULT 'Student',
        votes INT DEFAULT 1,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS volunteers (
        id SERIAL PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        role VARCHAR(100) DEFAULT 'Student Volunteer',
        pin VARCHAR(10) DEFAULT '1234',
        avatar_emoji VARCHAR(10) DEFAULT '🌟',
        total_hours NUMERIC(10, 2) DEFAULT 0.00,
        total_orders_served INT DEFAULT 0,
        points INT DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS volunteer_shifts (
        id SERIAL PRIMARY KEY,
        volunteer_id INT REFERENCES volunteers(id) ON DELETE CASCADE,
        volunteer_name VARCHAR(150) NOT NULL,
        clock_in TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        clock_out TIMESTAMP WITH TIME ZONE,
        hours_worked NUMERIC(6, 2) DEFAULT 0.00,
        orders_processed INT DEFAULT 0,
        notes TEXT DEFAULT '',
        status VARCHAR(20) DEFAULT 'ACTIVE' -- 'ACTIVE', 'COMPLETED'
      );

      CREATE TABLE IF NOT EXISTS combo_deals (
        id SERIAL PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        description TEXT DEFAULT '',
        bundle_price NUMERIC(10, 2) NOT NULL,
        item_requirements JSONB NOT NULL, -- e.g. [{"category": "Chips", "qty": 1}, {"category": "Cold Drinks", "qty": 1}]
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS trivia_questions (
        id SERIAL PRIMARY KEY,
        question TEXT NOT NULL,
        options JSONB NOT NULL, -- ["A", "B", "C", "D"]
        correct_index INT NOT NULL,
        category VARCHAR(100) DEFAULT 'General School Trivia',
        reward_type VARCHAR(50) DEFAULT 'bonus_stamp', -- 'bonus_stamp', 'discount_10c'
        reward_text VARCHAR(150) DEFAULT '⭐ +1 Loyalty Stamp!',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Ensure default volunteers exist
    const volCheck = await client.query('SELECT COUNT(*) FROM volunteers');
    if (parseInt(volCheck.rows[0].count, 10) === 0) {
      const defaultVolunteers = [
        { name: 'Jordan Daniels', role: 'Store Lead & General Manager', pin: '1234', emoji: '👑', hours: 42.5, orders: 380, points: 1250 },
        { name: 'Alex Taylor', role: 'Senior Cashier Volunteer', pin: '1111', emoji: '⭐', hours: 28.0, orders: 215, points: 740 },
        { name: 'Marcus Vance', role: 'Stock & Inventory Specialist', pin: '2222', emoji: '📦', hours: 19.5, orders: 140, points: 510 },
        { name: 'Samantha Reed', role: 'Customer Service Lead', pin: '3333', emoji: '💖', hours: 22.0, orders: 175, points: 620 },
      ];
      for (const v of defaultVolunteers) {
        await client.query(
          'INSERT INTO volunteers (name, role, pin, avatar_emoji, total_hours, total_orders_served, points) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [v.name, v.role, v.pin, v.emoji, v.hours, v.orders, v.points]
        );
      }
    }

    // Ensure default combo deals exist
    const comboCheck = await client.query('SELECT COUNT(*) FROM combo_deals');
    if (parseInt(comboCheck.rows[0].count, 10) === 0) {
      const defaultCombos = [
        {
          name: 'Classic Snack & Cold Drink Combo',
          desc: 'Any bag of chips or crunchy snack paired with any cold drink/juice',
          price: 2.25,
          reqs: [{ category: 'Chips', qty: 1 }, { category: 'Drinks', qty: 1 }]
        },
        {
          name: 'Sweet Tooth Treat Pack',
          desc: '1 Candy/Sweet item + 1 Cold Beverage',
          price: 2.50,
          reqs: [{ category: 'Candy', qty: 1 }, { category: 'Drinks', qty: 1 }]
        },
        {
          name: 'Mega Power Trio Bundle',
          desc: '1 Chip snack + 1 Cold drink + 1 Candy/Baked treat',
          price: 3.50,
          reqs: [{ category: 'Chips', qty: 1 }, { category: 'Drinks', qty: 1 }, { category: 'Candy', qty: 1 }]
        }
      ];
      for (const c of defaultCombos) {
        await client.query(
          'INSERT INTO combo_deals (name, description, bundle_price, item_requirements) VALUES ($1, $2, $3, $4)',
          [c.name, c.desc, c.price, JSON.stringify(c.reqs)]
        );
      }
    }

    // Ensure default trivia questions exist
    const triviaCheck = await client.query('SELECT COUNT(*) FROM trivia_questions');
    if (parseInt(triviaCheck.rows[0].count, 10) === 0) {
      const defaultTrivia = [
        {
          q: "What is the primary currency unit used for fast loyalty awards at Jordan's Snack Shack?",
          opts: ["Paper Coupons", "Digital Punch Stamps", "Gold Coins", "School Tokens"],
          ans: 1,
          cat: "Snack Shack Knowledge",
          reward: "⭐ +1 Bonus Stamp!"
        },
        {
          q: "How many loyalty punch stamps earn a 100% FREE snack reward?",
          opts: ["5 Stamps", "10 Stamps", "15 Stamps", "20 Stamps"],
          ans: 1,
          cat: "Snack Shack Loyalty",
          reward: "🎁 +1 Bonus Stamp!"
        },
        {
          q: "Which nutrient is essential for muscle growth and repair in human biology?",
          opts: ["Lipids", "Proteins", "Simple Sugars", "Cellulose"],
          ans: 1,
          cat: "Science Trivia",
          reward: "🎟️ 10¢ Off Any Snack!"
        },
        {
          q: "What planet in our solar system is known as the Red Planet?",
          opts: ["Venus", "Mars", "Jupiter", "Saturn"],
          ans: 1,
          cat: "Astronomy",
          reward: "⭐ +1 Bonus Stamp!"
        }
      ];
      for (const t of defaultTrivia) {
        await client.query(
          'INSERT INTO trivia_questions (question, options, correct_index, category, reward_text) VALUES ($1, $2, $3, $4, $5)',
          [t.q, JSON.stringify(t.opts), t.ans, t.cat, t.reward]
        );
      }
    }

    // Ensure default announcements exist
    const annCheck = await client.query('SELECT COUNT(*) FROM display_announcements');
    if (parseInt(annCheck.rows[0].count, 10) === 0) {
      const defaultAnnouncements = [
        { message: "Welcome to Jordan's Snack Shack! Fresh snacks & ice-cold drinks!", emoji: "🍿" },
        { message: "Auto-Combo Deal: Pair any snack + cold drink for 50¢ OFF automatically!", emoji: "🥤" },
        { message: "Punch Pass Reward: 10 stamps = 1 FREE Snack of your choice!", emoji: "⭐" },
        { message: "Check out today's Secret Daily Password on the screen for bonus discounts!", emoji: "🔑" },
      ];
      for (const a of defaultAnnouncements) {
        await client.query('INSERT INTO display_announcements (message, emoji) VALUES ($1, $2)', [a.message, a.emoji]);
      }
    }

    // Ensure default wishlist items exist
    const wishCheck = await client.query('SELECT COUNT(*) FROM snack_wishlist');
    if (parseInt(wishCheck.rows[0].count, 10) === 0) {
      const defaultWishlist = [
        { snack_name: "Flamin' Hot Limon Cheetos", category: "Chips", requested_by: "Alex (8th)", votes: 24 },
        { snack_name: "Choco Taco Ice Cream", category: "Ice Cream", requested_by: "Marcus (7th)", votes: 31 },
        { snack_name: "Gatorade Cool Blue 20oz", category: "Drinks", requested_by: "Coach Dan", votes: 19 },
        { snack_name: "Hi-Chew Strawberry Candy", category: "Candy", requested_by: "Maya (6th)", votes: 15 },
      ];
      for (const w of defaultWishlist) {
        await client.query('INSERT INTO snack_wishlist (snack_name, category, requested_by, votes) VALUES ($1, $2, $3, $4)', [
          w.snack_name, w.category, w.requested_by, w.votes
        ]);
      }
    }

    // Ensure default staff members exist
    const staffCheck = await client.query('SELECT COUNT(*) FROM staff_members');
    if (parseInt(staffCheck.rows[0].count, 10) === 0) {
      const defaultStaff = [
        { name: 'Jordan Daniels', role: 'Store Lead & Manager', pin: '1234', emoji: '👑' },
        { name: 'Alex Taylor', role: 'Cashier Volunteer', pin: '1111', emoji: '🧑‍🎓' },
        { name: 'Sam Rivera', role: 'Staff Advisor', pin: '9999', emoji: '👨‍🏫' },
      ];
      for (const s of defaultStaff) {
        await client.query('INSERT INTO staff_members (name, role, pin, emoji) VALUES ($1, $2, $3, $4)', [
          s.name, s.role, s.pin, s.emoji
        ]);
      }
    }

    // Ensure default poll options exist
    const pollCheck = await client.query('SELECT COUNT(*) FROM snack_polls');
    if (parseInt(pollCheck.rows[0].count, 10) === 0) {
      const defaultPolls = [
        { option_name: 'Takis Blue Heat', emoji: '🌶️', votes: 14 },
        { option_name: 'Doritos Sweet Chili', emoji: '🧀', votes: 19 },
        { option_name: 'Prime Ice Pop', emoji: '⚡', votes: 23 },
        { option_name: 'Sour Patch Watermelon', emoji: '🍉', votes: 18 }
      ];
      for (const p of defaultPolls) {
        await client.query('INSERT INTO snack_polls (option_name, emoji, votes) VALUES ($1, $2, $3)', [
          p.option_name, p.emoji, p.votes
        ]);
      }
    }

    // Ensure default fundraiser campaigns exist
    const fundCheck = await client.query('SELECT COUNT(*) FROM fundraiser_campaigns');
    if (parseInt(fundCheck.rows[0].count, 10) === 0) {
      const defaultFunds = [
        { name: 'General Student Activity Fund', goal: 1000.00, desc: 'School-wide activities, pep rallies, student store operations' },
        { name: '8th Grade Class DC / End of Year Trip', goal: 2500.00, desc: 'Subsidizing travel tickets and meals for 8th grade students' },
        { name: 'Robotics & STEM Club Competition Fund', goal: 750.00, desc: 'Sensors, motors, and tournament registration fees' },
        { name: 'Athletics & Gym Equipment', goal: 600.00, desc: 'New sports gear, basketballs, and team jerseys' },
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

    // Ensure default security settings exist
    const secCheck = await client.query('SELECT COUNT(*) FROM security_settings');
    if (parseInt(secCheck.rows[0].count, 10) === 0) {
      await client.query(`
        INSERT INTO security_settings (
          crowd_ai_sensitivity, hostile_audio_threshold, hostile_audio_enabled,
          dvr_retention_minutes, auto_bookmark_hostile, weather_hot_temp,
          weather_cold_temp, weather_hot_discount, weather_cold_discount, manual_weather_override
        ) VALUES ('NORMAL', 75, TRUE, 60, TRUE, 75.0, 50.0, 0.25, 0.25, 'AUTO')
      `);
    }

    // Ensure default sample incident report exists
    const incCheck = await client.query('SELECT COUNT(*) FROM incident_reports');
    if (parseInt(incCheck.rows[0].count, 10) === 0) {
      await client.query(`
        INSERT INTO incident_reports (
          report_number, incident_time, location, incident_type, student_name, severity, description, action_taken, status, reported_by
        ) VALUES (
          'INC-REP-2026-001', '08:14 AM', 'Station Table 4B', 'hostile_audio', 'Marcus Vance', 'MEDIUM',
          'Acoustic spike and raised aggressive voice detected at counter during item selection.',
          'Cashier de-escalated conversation and reminded student of single-file queue policy.',
          'RESOLVED', 'Station Table 4B Counter Mic'
        )
      `);
    }

    // Ensure default daily log exists
    const logCheck = await client.query('SELECT COUNT(*) FROM daily_logs');
    if (parseInt(logCheck.rows[0].count, 10) === 0) {
      await client.query(`
        INSERT INTO daily_logs (
          cashier_name, manager_name, opening_cash, closing_cash, cash_discrepancy, weather_summary, incidents_count, operational_notes, manager_signoff
        ) VALUES (
          'Jordan Daniels', 'Store Lead & Manager', 50.00, 114.50, 0.00, 'Sunny & Mild, 74°F', 1,
          'Morning operational session completed with balanced register drawer. High snack demand for Flamin Hot chips and ice cold sparkling drinks.',
          TRUE
        )
      `);
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

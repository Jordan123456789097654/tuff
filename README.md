# 🍿 Jordan's Snack Shack - Point of Sale (POS)

A fast, modern, touchscreen-friendly browser POS system built for school snack bars, fundraisers, and concession stands.

Backed by **PostgreSQL (Supabase)** with zero-configuration automatic schema migration and sample data seeding.

---

## ✨ Features Included

### 1. 🛒 Fast Cashier Register
- **Visual Snack Grid:** Categorized cards (Chips, Candy, Drinks, Ice Cream, Baked Goods, Combos) with touch-friendly tiles, emojis, and prices.
- **Instant Search & Barcode:** Real-time filter and scanning bar for fast recess rush checkout.
- **Cart & Pricing:** Live cart quantity modifiers, coupons/discounts (50¢ off, 10% honor roll, 50% clearance), subtotal, and total due.
- **Web Audio Sound Effects:** Realistic scan chirps, register chimes (*cha-ching!*), and allergen alerts powered by the Web Audio API.
- **Printable Thermal Receipts:** 80mm receipt generator formatted with store title, itemized breakdown, and barcode.

### 2. 🎒 Student Snack Passes & Accounts
- **Prepaid ID Accounts:** Students can pay by typing or scanning their Student ID.
- **Allergy & Safety Alerts:** Visual warning banners if a student purchasing an item has documented peanut, dairy, or gluten sensitivities.
- **Daily Spending Limits:** Prevent students from exceeding their daily snack budget.
- **Reload Balance:** Cashier can deposit cash or payments into student accounts with instant receipt logs.

### 3. 📦 Real-Time Inventory & Restock Hub
- **Live Stock Tracking:** Auto-deducts inventory upon sale with *In Stock, Low Stock, Sold Out* badges.
- **Quick Case Restock:** 1-click bulk additions (+12 pack, +24 box, +36 case, +50 count).
- **Fundraiser Profit Margin Tracker:** Track wholesale item cost vs. retail price to compute fundraising profit margins.

### 4. 💵 Shift Drawer & Cash Reconciliation
- **Opening Float:** Track starting drawer cash (e.g. $50.00).
- **End-of-Shift Cash Audit:** Cashiers count register physical cash at the end of lunch to verify actual cash vs. system expected sales (Balanced / Over / Short).

### 5. 📊 Fundraiser Performance Analytics
- **Live Metrics:** Today's revenue, net profit, orders count, and all-time sales.
- **Top-Selling Snacks:** Leaderboard of top popular snacks.
- **CSV Data Export:** 1-click spreadsheet export ready to hand to school administration or club advisors.

---

## 🚀 Quick Start (Local)

### 1. Install Dependencies
```bash
npm install
```

### 2. Start the Server
```bash
npm start
```

### 3. Open in Browser
Visit [http://localhost:3000](http://localhost:3000) in Chrome, Edge, Safari, iPad, or Chromebook.

---

## 🌐 Deploy to the Web (Free & 1-Click)

### Option A: Deploy on **Render** (Recommended)
1. Push this repository to GitHub.
2. Go to [Render.com](https://render.com) and click **New +** -> **Web Service**.
3. Select your GitHub repository.
4. Set:
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
5. In **Environment Variables**, add:
   - `DATABASE_URL` = `postgresql://postgres:6qIqNTk8RK8lzxtX@db.gcsmrtwyvnixiabtvztd.supabase.co:5432/postgres`
   - `NODE_ENV` = `production`
6. Click **Deploy Web Service**!

---

### Option B: Deploy on **Railway**
1. Install Railway CLI or link your GitHub repo at [railway.app](https://railway.app).
2. Add Environment Variable `DATABASE_URL` with your Supabase connection string.
3. Railway will automatically detect Node.js and start the POS system!

---

### Option C: Deploy with **Docker**
A `Dockerfile` is included for containerized hosting:
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

Build and run:
```bash
docker build -t jordans-snack-shack .
docker run -p 3000:3000 -e DATABASE_URL="postgresql://postgres:..." jordans-snack-shack
```

---

## 📁 Project Structure

```
jordans-snack-shack/
├── .env                  # Database connection string & port
├── .env.example          # Template environment config
├── db.js                 # PostgreSQL connection pool & schema migrations
├── package.json          # Node.js dependencies (express, pg, cors, dotenv)
├── server.js             # REST API server & static file host
├── README.md             # Documentation & deployment guide
└── public/
    ├── app.js            # POS application logic, audio synth & UI handlers
    ├── index.html        # Single-page application HTML & layout
    └── styles.css        # Custom CSS, animations & thermal receipt styles
```

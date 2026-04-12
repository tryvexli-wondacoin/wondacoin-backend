require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "admin123";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "wondacoin-secure-token";

async function writeAuditLog({
  adminUser,
  action,
  targetType,
  targetId,
  details,
}) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (admin_user, action, target_type, target_id, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        adminUser || "unknown",
        action || "unknown",
        targetType || null,
        targetId || null,
        details || null,
      ]
    );
  } catch (error) {
    console.error("Audit log write failed:", error.message);
  }
}

function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];

  if (!token || token !== ADMIN_TOKEN) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
  }

  req.adminUser = ADMIN_USER;
  next();
}

app.get("/", (req, res) => {
  res.send("Damok Wondacoin Backend Running");
});

app.post("/admin-login", async (req, res) => {
  const { username, password } = req.body || {};

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    await writeAuditLog({
      adminUser: username,
      action: "admin_login",
      targetType: "system",
      targetId: "login",
      details: "Admin login successful",
    });

    return res.json({
      success: true,
      message: "Login successful",
      token: ADMIN_TOKEN,
    });
  }

  await writeAuditLog({
    adminUser: username || "unknown",
    action: "admin_login_failed",
    targetType: "system",
    targetId: "login",
    details: "Invalid login attempt",
  });

  return res.status(401).json({
    success: false,
    message: "Invalid login",
  });
});

app.get("/db-test", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({
      success: true,
      message: "Database connected",
      time: result.rows[0].now,
    });
  } catch (error) {
    console.error("DB connection error:", error.message);
    res.status(500).json({
      success: false,
      message: "Database connection failed",
      error: error.message,
    });
  }
});

app.get("/create-user", requireAdmin, async (req, res) => {
  try {
    const { name, email } = req.query;

    if (!name) {
      return res.json({
        success: false,
        message: "Name required",
      });
    }

    const existingUser = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email || null]
    );

    if (email && existingUser.rows.length > 0) {
      return res.json({
        success: false,
        message: "Email already exists",
      });
    }

    const userResult = await pool.query(
      "INSERT INTO users (full_name, email) VALUES ($1, $2) RETURNING *",
      [name, email || null]
    );

    const user = userResult.rows[0];

    const walletResult = await pool.query(
      "INSERT INTO wallets (user_id) VALUES ($1) RETURNING *",
      [user.id]
    );

    const wallet = walletResult.rows[0];

    await writeAuditLog({
      adminUser: req.adminUser,
      action: "create_user",
      targetType: "user",
      targetId: String(user.id),
      details: `Created user ${user.full_name} with wallet ${wallet.id}`,
    });

    res.json({
      success: true,
      message: "User and wallet created",
      user,
      wallet,
    });
  } catch (error) {
    console.error("Create user error:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to create user",
      error: error.message,
    });
  }
});

app.get("/fund-wallet", requireAdmin, async (req, res) => {
  try {
    const { user_id, amount, description } = req.query;

    if (!user_id || !amount) {
      return res.json({
        success: false,
        message: "user_id and amount required",
      });
    }

    const numericAmount = Number(amount);

    if (isNaN(numericAmount) || numericAmount <= 0) {
      return res.json({
        success: false,
        message: "Amount must be greater than 0",
      });
    }

    const walletResult = await pool.query(
      "SELECT * FROM wallets WHERE user_id = $1",
      [user_id]
    );

    if (walletResult.rows.length === 0) {
      return res.json({
        success: false,
        message: "Wallet not found",
      });
    }

    const wallet = walletResult.rows[0];

    const updatedWalletResult = await pool.query(
      "UPDATE wallets SET balance = balance + $1 WHERE user_id = $2 RETURNING *",
      [numericAmount, user_id]
    );

    const updatedWallet = updatedWalletResult.rows[0];

    const transactionResult = await pool.query(
      `INSERT INTO transactions (user_id, wallet_id, type, amount, description)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [user_id, wallet.id, "credit", numericAmount, description || "Wallet funded"]
    );

    const transaction = transactionResult.rows[0];

    await writeAuditLog({
      adminUser: req.adminUser,
      action: "fund_wallet",
      targetType: "wallet",
      targetId: String(wallet.id),
      details: `Funded user ${user_id} wallet ${wallet.id} with ${numericAmount}`,
    });

    res.json({
      success: true,
      message: "Wallet funded successfully",
      wallet: updatedWallet,
      transaction,
    });
  } catch (error) {
    console.error("Fund wallet error:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to fund wallet",
      error: error.message,
    });
  }
});

app.get("/transfer", requireAdmin, async (req, res) => {
  const client = await pool.connect();

  try {
    const { from_user_id, to_user_id, amount, description } = req.query;

    if (!from_user_id || !to_user_id || !amount) {
      return res.json({
        success: false,
        message: "from_user_id, to_user_id and amount required",
      });
    }

    if (from_user_id === to_user_id) {
      return res.json({
        success: false,
        message: "Cannot transfer to the same user",
      });
    }

    const numericAmount = Number(amount);

    if (isNaN(numericAmount) || numericAmount <= 0) {
      return res.json({
        success: false,
        message: "Amount must be greater than 0",
      });
    }

    await client.query("BEGIN");

    const senderWalletResult = await client.query(
      "SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE",
      [from_user_id]
    );

    const receiverWalletResult = await client.query(
      "SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE",
      [to_user_id]
    );

    if (senderWalletResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.json({ success: false, message: "Sender wallet not found" });
    }

    if (receiverWalletResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.json({ success: false, message: "Receiver wallet not found" });
    }

    const senderWallet = senderWalletResult.rows[0];
    const receiverWallet = receiverWalletResult.rows[0];

    if (Number(senderWallet.balance) < numericAmount) {
      await client.query("ROLLBACK");
      return res.json({ success: false, message: "Insufficient balance" });
    }

    const updatedSenderResult = await client.query(
      "UPDATE wallets SET balance = balance - $1 WHERE user_id = $2 RETURNING *",
      [numericAmount, from_user_id]
    );

    const updatedReceiverResult = await client.query(
      "UPDATE wallets SET balance = balance + $1 WHERE user_id = $2 RETURNING *",
      [numericAmount, to_user_id]
    );

    const senderTransaction = await client.query(
      `INSERT INTO transactions (user_id, wallet_id, type, amount, description)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        from_user_id,
        senderWallet.id,
        "debit",
        numericAmount,
        description || `Transfer to user ${to_user_id}`,
      ]
    );

    const receiverTransaction = await client.query(
      `INSERT INTO transactions (user_id, wallet_id, type, amount, description)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        to_user_id,
        receiverWallet.id,
        "credit",
        numericAmount,
        description || `Transfer from user ${from_user_id}`,
      ]
    );

    await client.query("COMMIT");

    await writeAuditLog({
      adminUser: req.adminUser,
      action: "transfer",
      targetType: "wallet_transfer",
      targetId: `${from_user_id}->${to_user_id}`,
      details: `Transferred ${numericAmount} from user ${from_user_id} to user ${to_user_id}`,
    });

    res.json({
      success: true,
      message: "Transfer successful",
      sender_wallet: updatedSenderResult.rows[0],
      receiver_wallet: updatedReceiverResult.rows[0],
      sender_transaction: senderTransaction.rows[0],
      receiver_transaction: receiverTransaction.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Transfer error:", error.message);
    res.status(500).json({
      success: false,
      message: "Transfer failed",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

app.get("/users", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM users ORDER BY id ASC");
    res.json({
      success: true,
      count: result.rows.length,
      users: result.rows,
    });
  } catch (error) {
    console.error("Users fetch error:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch users",
      error: error.message,
    });
  }
});

app.get("/wallets", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT wallets.*, users.full_name, users.email
       FROM wallets
       LEFT JOIN users ON wallets.user_id = users.id
       ORDER BY wallets.id ASC`
    );

    res.json({
      success: true,
      count: result.rows.length,
      wallets: result.rows,
    });
  } catch (error) {
    console.error("Wallets fetch error:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch wallets",
      error: error.message,
    });
  }
});

app.get("/transactions", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT transactions.*, users.full_name, users.email
       FROM transactions
       LEFT JOIN users ON transactions.user_id = users.id
       ORDER BY transactions.id DESC`
    );

    res.json({
      success: true,
      count: result.rows.length,
      transactions: result.rows,
    });
  } catch (error) {
    console.error("Transactions fetch error:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch transactions",
      error: error.message,
    });
  }
});

app.get("/wallet-balance", requireAdmin, async (req, res) => {
  try {
    const { user_id } = req.query;

    if (!user_id) {
      return res.json({
        success: false,
        message: "user_id required",
      });
    }

    const result = await pool.query(
      `SELECT wallets.*, users.full_name, users.email
       FROM wallets
       LEFT JOIN users ON wallets.user_id = users.id
       WHERE wallets.user_id = $1`,
      [user_id]
    );

    if (result.rows.length === 0) {
      return res.json({
        success: false,
        message: "Wallet not found",
      });
    }

    await writeAuditLog({
      adminUser: req.adminUser,
      action: "wallet_balance_lookup",
      targetType: "user",
      targetId: String(user_id),
      details: `Looked up wallet balance for user ${user_id}`,
    });

    res.json({
      success: true,
      wallet: result.rows[0],
    });
  } catch (error) {
    console.error("Wallet balance error:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch wallet balance",
      error: error.message,
    });
  }
});

app.get("/stats", requireAdmin, async (req, res) => {
  try {
    const usersResult = await pool.query("SELECT COUNT(*) FROM users");
    const walletsResult = await pool.query("SELECT COUNT(*) FROM wallets");
    const transactionsResult = await pool.query("SELECT COUNT(*) FROM transactions");
    const balancesResult = await pool.query(
      "SELECT COALESCE(SUM(balance), 0) AS total_balance FROM wallets"
    );

    res.json({
      success: true,
      stats: {
        total_users: Number(usersResult.rows[0].count),
        total_wallets: Number(walletsResult.rows[0].count),
        total_transactions: Number(transactionsResult.rows[0].count),
        total_balance: balancesResult.rows[0].total_balance,
      },
    });
  } catch (error) {
    console.error("Stats fetch error:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch stats",
      error: error.message,
    });
  }
});

app.get("/audit-logs", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200"
    );

    res.json({
      success: true,
      count: result.rows.length,
      audit_logs: result.rows,
    });
  } catch (error) {
    console.error("Audit logs fetch error:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch audit logs",
      error: error.message,
    });
  }
});
app.get("/env-check", (req, res) => {
  res.json({
    hasDatabaseUrl: !!process.env.DATABASE_URL,
    startsWithPostgresql: (process.env.DATABASE_URL || "").startsWith("postgresql://"),
    adminUserSet: !!process.env.ADMIN_USER,
    adminPassSet: !!process.env.ADMIN_PASS,
    adminTokenSet: !!process.env.ADMIN_TOKEN,
  });
});
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

require("dotenv").config();
const express = require("express");
const session = require("express-session");
const ConnectPgSimple = require("connect-pg-simple")(session);
const AdminJS = require("adminjs");
const AdminJSExpress = require("@adminjs/express");
const { Pool } = require("pg");

const app = express();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

AdminJS.registerAdapter({
  Resource: class PgTableResource {
    constructor(tableName) {
      this.tableName = tableName;
      this.id = () => tableName;
    }

    databaseName() {
      return process.env.DB_NAME || "wondacoin";
    }

    databaseType() {
      return "postgresql";
    }

    async find(filter = {}, params = {}) {
      let query = `SELECT * FROM ${this.tableName}`;
      const values = [];
      const where = [];

      Object.entries(filter).forEach(([key, value], index) => {
        where.push(`${key} = $${index + 1}`);
        values.push(value);
      });

      if (where.length) {
        query += ` WHERE ${where.join(" AND ")}`;
      }

      query += " ORDER BY id DESC";

      if (params.limit) {
        query += ` LIMIT ${Number(params.limit)}`;
      }

      const result = await pool.query(query, values);
      return result.rows;
    }

    async findOne(id) {
      const result = await pool.query(
        `SELECT * FROM ${this.tableName} WHERE id = $1 LIMIT 1`,
        [id]
      );
      return result.rows[0];
    }

    async count() {
      const result = await pool.query(`SELECT COUNT(*) FROM ${this.tableName}`);
      return Number(result.rows[0].count);
    }

    async create(params) {
      const keys = Object.keys(params);
      const values = Object.values(params);
      const placeholders = keys.map((_, i) => `$${i + 1}`);

      const result = await pool.query(
        `INSERT INTO ${this.tableName} (${keys.join(", ")})
         VALUES (${placeholders.join(", ")})
         RETURNING *`,
        values
      );
      return result.rows[0];
    }

    async update(id, params) {
      const keys = Object.keys(params);
      const values = Object.values(params);

      const setClause = keys.map((key, i) => `${key} = $${i + 1}`).join(", ");

      const result = await pool.query(
        `UPDATE ${this.tableName}
         SET ${setClause}
         WHERE id = $${keys.length + 1}
         RETURNING *`,
        [...values, id]
      );
      return result.rows[0];
    }

    async delete(id) {
      await pool.query(`DELETE FROM ${this.tableName} WHERE id = $1`, [id]);
      return { id };
    }

    properties() {
      return [];
    }

    property(path) {
      return { path };
    }
  },
});

const admin = new AdminJS({
  rootPath: "/admin",
  resources: [
    {
      resource: new PgTableResource("users"),
      options: {
        navigation: "Wondacoin Data",
        listProperties: ["id", "full_name", "email", "created_at"],
        editProperties: ["full_name", "email", "phone"],
        showProperties: ["id", "full_name", "email", "phone", "created_at"],
      },
    },
    {
      resource: new PgTableResource("wallets"),
      options: {
        navigation: "Wondacoin Data",
        listProperties: ["id", "user_id", "balance", "currency", "created_at"],
        editProperties: ["user_id", "balance", "currency"],
        showProperties: ["id", "user_id", "balance", "currency", "created_at"],
      },
    },
    {
      resource: new PgTableResource("transactions"),
      options: {
        navigation: "Wondacoin Data",
        listProperties: ["id", "user_id", "wallet_id", "type", "amount", "description", "created_at"],
        editProperties: ["user_id", "wallet_id", "type", "amount", "description"],
        showProperties: ["id", "user_id", "wallet_id", "type", "amount", "description", "created_at"],
      },
    },
  ],
  branding: {
    companyName: "Damok Wondacoin Admin",
    softwareBrothers: false,
  },
});

const adminRouter = AdminJSExpress.buildAuthenticatedRouter(
  admin,
  {
    authenticate: async (email, password) => {
      if (
        email === (process.env.ADMIN_EMAIL || "admin@damok.local") &&
        password === (process.env.ADMIN_PASSWORD || "admin123")
      ) {
        return { email };
      }
      return null;
    },
    cookieName: "wondacoin_admin",
    cookiePassword: process.env.ADMIN_COOKIE_SECRET || "supersecretcookie",
  },
  null,
  {
    store: new ConnectPgSimple({
      pool,
      tableName: "admin_session",
      createTableIfMissing: true,
    }),
    secret: process.env.ADMIN_COOKIE_SECRET || "supersecretcookie",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: false,
      maxAge: 1000 * 60 * 60 * 8,
    },
  }
);

app.use(admin.options.rootPath, adminRouter);

const PORT = process.env.ADMIN_PORT || 4000;

app.listen(PORT, () => {
  console.log(`AdminJS running on http://localhost:${PORT}/admin`);
});
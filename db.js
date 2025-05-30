// db.js
require('dotenv').config(); // Hanya untuk lokal, di GCP env vars disuntikkan
const mysql = require('mysql2/promise');

const dbConfig = {
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
};

// Logika untuk membedakan koneksi lokal dan Cloud SQL di GCP
if (process.env.NODE_ENV === 'production' && process.env.DB_SOCKET_PATH) {
  // Berjalan di Cloud Run dengan Cloud SQL (menggunakan Unix socket)
  console.log(`MySQL Production: Connecting via socket: ${process.env.DB_SOCKET_PATH}`);
  dbConfig.socketPath = process.env.DB_SOCKET_PATH; // e.g., /cloudsql/PROJECT:REGION:INSTANCE
  dbConfig.user = process.env.DB_USER_PROD; // Akan diset dari Secret Manager
  dbConfig.password = process.env.DB_PASSWORD_PROD; // Akan diset dari Secret Manager
  dbConfig.database = process.env.DB_NAME_PROD; // Akan diset dari Secret Manager
} else {
  // Development lokal atau environment lain yang menggunakan TCP/IP
  console.log(`MySQL Development: Connecting via TCP to ${process.env.DB_HOST}:${process.env.DB_PORT || 3306}`);
  dbConfig.host = process.env.DB_HOST;
  dbConfig.port = parseInt(process.env.DB_PORT || '3306', 10);
  dbConfig.user = process.env.DB_USER;
  dbConfig.password = process.env.DB_PASSWORD;
  dbConfig.database = process.env.DB_NAME;
}

const pool = mysql.createPool(dbConfig);

// Uji koneksi sederhana (opsional, bisa dihapus untuk produksi)
async function testConnection() {
  let connection;
  try {
    connection = await pool.getConnection();
    console.log('MySQL berhasil terkoneksi! 🐬');
  } catch (error) {
    console.error('Gagal terkoneksi ke MySQL:', error.message);
    // Tambahkan log error spesifik jika ada
    if (error.code) console.error('MySQL Error Code:', error.code);
  } finally {
    if (connection) connection.release();
  }
}

if (process.env.NODE_ENV !== 'production') { // Hanya jalankan tes di dev
    testConnection();
}


module.exports = pool;
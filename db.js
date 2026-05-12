const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,                // 최대 연결 수 (무료 플랜 대비 작게)
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// 연결 테스트
pool.on('error', (err) => {
  console.error('DB 연결 오류:', err.message);
});

module.exports = pool;

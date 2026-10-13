// Defaults so tests run without a .env file (CI sets real values).
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://coinhub:coinhub@localhost:5432/coinhub_test';
process.env.DATABASE_URL_DIRECT ??= process.env.DATABASE_URL;
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-test-access-secret-1';
process.env.CSRF_SECRET ??= 'test-csrf-secret-test-csrf-secret-123';
process.env.GATEWAY_WEBHOOK_SECRET ??= 'test-gateway-secret-test-gateway-1234';
process.env.LOCK_TIMEOUT_MS ??= '1500';

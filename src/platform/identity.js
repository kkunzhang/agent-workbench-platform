import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

const registerSchema = z.object({
  email: z.string().trim().email().max(160),
  displayName: z.string().trim().min(2).max(60),
  password: z.string().min(8).max(120),
});

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({ refreshToken: z.string().min(32).max(300) });

function ok(data) {
  return { code: 200, status: true, data };
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function createRefreshToken() {
  return randomBytes(48).toString('base64url');
}

async function audit(database, actorId, action, metadata = {}) {
  await database.query(
    'INSERT INTO audit_logs (actor_id, action, metadata) VALUES ($1, $2, $3)',
    [actorId || null, action, JSON.stringify(metadata)],
  );
}

async function getUserIdentity(database, userId) {
  const result = await database.query(`
    SELECT
      users.id,
      users.email,
      users.display_name AS "displayName",
      users.status,
      COALESCE(array_agg(DISTINCT roles.code) FILTER (WHERE roles.code IS NOT NULL), '{}') AS roles,
      COALESCE(array_agg(DISTINCT permissions.code) FILTER (WHERE permissions.code IS NOT NULL), '{}') AS permissions
    FROM users
    LEFT JOIN user_roles ON user_roles.user_id = users.id
    LEFT JOIN roles ON roles.id = user_roles.role_id
    LEFT JOIN role_permissions ON role_permissions.role_id = roles.id
    LEFT JOIN permissions ON permissions.id = role_permissions.permission_id
    WHERE users.id = $1
    GROUP BY users.id
  `, [userId]);
  return result.rows[0] || null;
}

async function findUserByEmail(database, email) {
  const result = await database.query('SELECT id, email, display_name AS "displayName", password_hash AS "passwordHash", status FROM users WHERE email = $1', [email.toLowerCase()]);
  return result.rows[0] || null;
}

async function assignRole(database, userId, roleCode) {
  await database.query(`
    INSERT INTO user_roles (user_id, role_id)
    SELECT $1, id FROM roles WHERE code = $2
    ON CONFLICT DO NOTHING
  `, [userId, roleCode]);
}

async function issueTokens(app, database, identity, config) {
  const accessToken = await app.jwt.sign({
    sub: identity.id,
    email: identity.email,
    roles: identity.roles,
    permissions: identity.permissions,
  }, { expiresIn: config.accessTokenTtl });
  const refreshToken = createRefreshToken();
  const expiresAt = new Date(Date.now() + config.refreshTokenTtlDays * 24 * 60 * 60 * 1000);
  await database.query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [identity.id, hashToken(refreshToken), expiresAt],
  );
  return { accessToken, refreshToken, expiresAt: expiresAt.toISOString(), user: identity };
}

export async function ensureDemoUser(database, config) {
  const existing = await findUserByEmail(database, config.demoUserEmail);
  if (existing) return existing;
  const passwordHash = await bcrypt.hash(config.demoUserPassword, 12);
  const created = await database.query(`
    INSERT INTO users (email, display_name, password_hash)
    VALUES ($1, $2, $3)
    RETURNING id, email, display_name AS "displayName", status
  `, [config.demoUserEmail, 'Demo Admin', passwordHash]);
  await assignRole(database, created.rows[0].id, 'admin');
  return created.rows[0];
}

function parse(schema, value, reply) {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  reply.code(422).send({ code: 422, status: false, message: '请求参数不合法', errors: parsed.error.flatten() });
  return null;
}

export function requirePermission(permission) {
  return async function permissionGuard(request, reply) {
    try {
      await request.jwtVerify();
      if (!request.user.permissions?.includes(permission)) {
        return reply.code(403).send({ code: 403, status: false, message: `缺少权限：${permission}` });
      }
    } catch {
      return reply.code(401).send({ code: 401, status: false, message: '登录状态无效或已过期' });
    }
  };
}

export async function registerIdentityRoutes(app, { database, config }) {
  app.post('/api/v1/auth/register', async (request, reply) => {
    const input = parse(registerSchema, request.body, reply);
    if (!input) return;
    const exists = await findUserByEmail(database, input.email);
    if (exists) return reply.code(409).send({ code: 409, status: false, message: '邮箱已注册' });
    const passwordHash = await bcrypt.hash(input.password, 12);
    const result = await database.query(`
      INSERT INTO users (email, display_name, password_hash)
      VALUES ($1, $2, $3)
      RETURNING id
    `, [input.email.toLowerCase(), input.displayName, passwordHash]);
    await assignRole(database, result.rows[0].id, 'member');
    const identity = await getUserIdentity(database, result.rows[0].id);
    await audit(database, identity.id, 'auth.register');
    return reply.code(201).send(ok(await issueTokens(app, database, identity, config)));
  });

  app.post('/api/v1/auth/login', async (request, reply) => {
    const input = parse(loginSchema, request.body, reply);
    if (!input) return;
    const user = await findUserByEmail(database, input.email);
    const passwordMatches = user && await bcrypt.compare(input.password, user.passwordHash);
    if (!passwordMatches || user.status !== 'active') {
      return reply.code(401).send({ code: 401, status: false, message: '邮箱或密码错误' });
    }
    const identity = await getUserIdentity(database, user.id);
    await audit(database, identity.id, 'auth.login');
    return ok(await issueTokens(app, database, identity, config));
  });

  app.post('/api/v1/auth/demo-login', async (request, reply) => {
    if (!config.enableDemoLogin) return reply.code(404).send({ code: 404, status: false, message: 'Demo 登录未启用' });
    const user = await ensureDemoUser(database, config);
    const identity = await getUserIdentity(database, user.id);
    await audit(database, identity.id, 'auth.demo-login');
    return ok(await issueTokens(app, database, identity, config));
  });

  app.post('/api/v1/auth/refresh', async (request, reply) => {
    const input = parse(refreshSchema, request.body, reply);
    if (!input) return;
    const result = await database.query(`
      SELECT user_id AS "userId" FROM refresh_tokens
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
    `, [hashToken(input.refreshToken)]);
    if (!result.rowCount) return reply.code(401).send({ code: 401, status: false, message: '刷新令牌无效或已过期' });
    await database.query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1', [hashToken(input.refreshToken)]);
    const identity = await getUserIdentity(database, result.rows[0].userId);
    await audit(database, identity.id, 'auth.refresh');
    return ok(await issueTokens(app, database, identity, config));
  });

  app.get('/api/v1/me', { preHandler: requirePermission('agent:read') }, async (request) => {
    const identity = await getUserIdentity(database, request.user.sub);
    return ok(identity);
  });
}

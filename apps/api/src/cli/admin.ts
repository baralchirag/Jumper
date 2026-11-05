// Server-side administration. It needs shell access and the same environment as the API (DATABASE_URL, PUBLIC_URL, …),
// so none of this can be done over the web.
//
//   node dist/admin.js list
//   node dist/admin.js grant <username>
//   node dist/admin.js revoke <username>
//   node dist/admin.js create-user <username> <email>   creates the account and prints a one-time link to set a password
//   node dist/admin.js verify-email <username>         marks the address as confirmed (for instances without email)
//   node dist/admin.js reset-link <username>            prints a one-time password reset link
//   node dist/admin.js delete-user <username> --yes     permanently deletes the account and its repositories
//
// Docker:  docker compose -f docker/docker-compose.yml exec api node dist/admin.js grant alice
// Source:  pnpm admin grant alice
import { eq, sql, users } from '@jumper/db';
import { createContext } from '../context';
import { loadEnv } from '../env';
import { createUser } from '../modules/auth/routes';
import { createResetToken, resetUrl } from '../modules/auth/reset-routes';
import { deleteUserAccount, deletionPreview } from '../modules/user/deletion';

const USAGE = `usage:
  admin list
  admin grant <username>
  admin revoke <username>
  admin create-user <username> <email>
  admin verify-email <username>
  admin reset-link <username>
  admin delete-user <username> --yes`;

const [cmd, ...rest] = process.argv.slice(2);
const args = rest.filter((a) => !a.startsWith('--'));
const flags = new Set(rest.filter((a) => a.startsWith('--')));

const ctx = createContext(loadEnv());
ctx.redis.on('error', () => {});

async function find(username: string) {
  const u = (await ctx.db.select().from(users).where(sql`lower(${users.username}) = lower(${username})`).limit(1))[0];
  if (!u) throw new Error(`No such user: ${username}`);
  return u;
}

async function main(): Promise<void> {
  switch (cmd) {
    case 'list': {
      const rows = await ctx.db.select({ username: users.username, email: users.email }).from(users).where(eq(users.isAdmin, true)).orderBy(users.username);
      console.log(rows.length ? rows.map((r) => `${r.username} <${r.email}>`).join('\n') : '(no administrators)');
      return;
    }
    case 'grant':
    case 'revoke': {
      if (!args[0]) throw new Error(USAGE);
      const u = await find(args[0]);
      await ctx.db.update(users).set({ isAdmin: cmd === 'grant' }).where(eq(users.id, u.id));
      console.log(`${u.username}: admin ${cmd === 'grant' ? 'granted' : 'revoked'}`);
      return;
    }
    case 'create-user': {
      const [username, email] = args;
      if (!username || !email) throw new Error(USAGE);
      const u = await createUser(ctx, { username, email, passwordHash: null, emailVerified: true });
      console.log(`Created ${u.username} <${u.email}>.\nThey can set a password with this one-time link (valid 1 hour):\n${resetUrl(ctx, await createResetToken(ctx, u))}`);
      return;
    }
    case 'verify-email': {
      if (!args[0]) throw new Error(USAGE);
      const u = await find(args[0]);
      await ctx.db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, u.id));
      console.log(`${u.username}: ${u.email} marked as verified`);
      return;
    }
    case 'reset-link': {
      if (!args[0]) throw new Error(USAGE);
      const u = await find(args[0]);
      console.log(`One-time password reset link for ${u.username} (valid 1 hour):\n${resetUrl(ctx, await createResetToken(ctx, u))}`);
      return;
    }
    case 'delete-user': {
      if (!args[0]) throw new Error(USAGE);
      const u = await find(args[0]);
      const p = await deletionPreview(ctx, u);
      if (p.soleOwnerOrgs.length) throw new Error(`${u.username} is the only owner of: ${p.soleOwnerOrgs.map((o) => o.slug).join(', ')}. Add another owner or delete the organization first.`);
      if (!flags.has('--yes')) {
        console.log(`This permanently deletes ${u.username} and ${p.ownedRepos.length} repositor${p.ownedRepos.length === 1 ? 'y' : 'ies'}.\nRun again with --yes to confirm.`);
        process.exitCode = 1;
        return;
      }
      const res = await deleteUserAccount(ctx, u);
      console.log(`Deleted ${u.username} and ${res.repos} repositor${res.repos === 1 ? 'y' : 'ies'}.`);
      return;
    }
    default:
      console.error(USAGE);
      process.exitCode = 1;
  }
}

try {
  await main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await ctx.close().catch(() => {});
  process.exit(process.exitCode ?? 0);
}

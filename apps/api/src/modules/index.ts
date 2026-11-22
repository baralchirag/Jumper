// Every API module is registered here, and nowhere else. A module is a folder holding its own routes, services and
// tests; `_shared` holds helpers used by several modules and `git` / `kicad` hold infrastructure other modules call.
//
//   auth, user, admin, orgs   accounts and access
//   repos, code, git          repositories, files, smart-HTTP
//   import                    bring repositories in from a git URL (GitHub, GitLab, ...)
//   protection                branch protection (enforced in git by a pre-receive hook)
//   notifications             inbox (stock and end-of-life alerts)
//   checks, design, bom       CI results, board analysis, parts and pricing
//   share, webhooks           outward-facing access and integrations
//   config, realtime          per-repo settings, live updates
//   site                      public instance facts (operator details for the legal pages)
//   usage, scheduler          plans, limits and usage; recurring jobs
//   mirrors, ssh, lfs         hosting: sync with GitHub/GitLab, git over SSH, large files
//   search                    search across repos, parts, nets
//   downloads, embeds         tools served by the instance; README badges and board previews
//   alerts, compliance        BOM stock/end-of-life watches; RoHS/REACH roll-up
//   comments                  comments on a commit's design, pinned to parts or areas
//   sso, scim, policy         single sign-on, directory provisioning, roles and organization-wide policy
//   billing, instance         invoice billing; licence, legal holds, retention and version
//   referrals                 invite links
import type { FastifyInstance } from 'fastify';
import adminRoutes from './admin/routes';
import authRoutes from './auth/routes';
import resetRoutes from './auth/reset-routes';
import verifyRoutes, { verifyGuard } from './auth/verify';
import checkRoutes from './checks/routes';
import codeRoutes from './code/routes';
import configRoutes from './config/routes';
import designRoutes from './design/routes';
import { gitHttpRoutes } from './git/http';
import inviteRoutes from './invites/routes';
import mirrorRoutes from './mirrors/routes';
import sshRoutes from './ssh/routes';
import downloadRoutes from './downloads/routes';
import searchRoutes from './search/routes';
import embedRoutes from './embeds/routes';
import { lfsRoutes } from './lfs/routes';
import importRoutes from './import/routes';
import notificationRoutes from './notifications/routes';
import orgRoutes from './orgs/routes';
import protectionRoutes from './protection/routes';
import { wsRoutes } from './realtime/routes';
import repoRoutes from './repos/routes';
import shareRoutes from './share/routes';
import siteRoutes from './site/routes';
import usageRoutes from './usage/routes';
import userRoutes from './user/routes';
import webhookRoutes from './webhooks/routes';
import alertRoutes from './alerts/routes';
import commentRoutes from './comments/routes';
import complianceRoutes from './compliance/routes';
import ssoRoutes from './sso/routes';
import scimRoutes from './scim/routes';
import policyRoutes from './policy/routes';
import { billingAdminRoutes, billingRoutes } from './billing/routes';
import { stripeRoutes, stripeWebhookRoutes } from './stripe/routes';
import { customerAdminRoutes } from './billing/customers';
import instanceRoutes, { versionRoutes } from './instance/routes';
import twoFactorRoutes from './auth/two-factor';
import referralRoutes from './referrals/routes';

export async function registerModules(app: FastifyInstance): Promise<void> {
  await app.register(verifyGuard);
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(verifyRoutes, { prefix: '/api/auth' });
  await app.register(resetRoutes, { prefix: '/api/auth' });
  await app.register(userRoutes, { prefix: '/api/user' });
  await app.register(twoFactorRoutes, { prefix: '/api/user/two-factor' });
  await app.register(adminRoutes, { prefix: '/api/admin' });
  await app.register(orgRoutes, { prefix: '/api/orgs' });
  await app.register(importRoutes, { prefix: '/api' });
  await app.register(mirrorRoutes, { prefix: '/api' });
  await app.register(inviteRoutes, { prefix: '/api' });
  await app.register(sshRoutes, { prefix: '/api' });
  await app.register(downloadRoutes, { prefix: '/api' });
  await app.register(searchRoutes, { prefix: '/api' });
  await app.register(embedRoutes, { prefix: '/api' });
  await app.register(repoRoutes, { prefix: '/api' });
  await app.register(codeRoutes, { prefix: '/api' });
  await app.register(checkRoutes, { prefix: '/api' });
  await app.register(configRoutes, { prefix: '/api' });
  await app.register(designRoutes, { prefix: '/api' });
  await app.register(notificationRoutes, { prefix: '/api' });
  await app.register(protectionRoutes, { prefix: '/api' });
  await app.register(shareRoutes, { prefix: '/api' });
  await app.register(siteRoutes, { prefix: '/api' });
  await app.register(usageRoutes, { prefix: '/api' });
  await app.register(webhookRoutes, { prefix: '/api' });
  await app.register(alertRoutes, { prefix: '/api' });
  await app.register(commentRoutes, { prefix: '/api' });
  await app.register(complianceRoutes, { prefix: '/api' });
  await app.register(ssoRoutes, { prefix: '/api' });
  await app.register(scimRoutes, { prefix: '/api/scim/v2' });
  await app.register(policyRoutes, { prefix: '/api' });
  await app.register(billingRoutes, { prefix: '/api' });
  await app.register(billingAdminRoutes, { prefix: '/api/admin' });
  await app.register(customerAdminRoutes, { prefix: '/api/admin' });
  await app.register(stripeRoutes, { prefix: '/api' });
  await app.register(stripeWebhookRoutes, { prefix: '/api' });
  await app.register(instanceRoutes, { prefix: '/api/admin/instance' });
  await app.register(versionRoutes, { prefix: '/api' });
  await app.register(referralRoutes, { prefix: '/api' });
  await app.register(wsRoutes);
  // Smart-HTTP git and LFS last: their catch-all-looking paths must not shadow the API.
  await app.register(gitHttpRoutes);
  await app.register(lfsRoutes);
}

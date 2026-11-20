# Accounts & organizations

## Your account

**Settings → Account** holds your email address, a data export and account deletion. **Password and authentication** changes your password and signs out your other sessions; **Sessions** shows where you are signed in and lets you sign any of them out.

### Forgot your password

On the sign-in page choose **Forgot your password?**, enter your username or email, and open the link you receive. It works once, expires after an hour, and signs you out everywhere when you use it. The page never says whether an account exists, so it cannot be used to look people up.

If your instance has no email set up, ask an administrator for a reset link (Admin → Users → *Reset link*).

### Export your data

Settings → Account → **Download export** gives you a JSON file with your profile, token metadata (never the secrets) and your recent security log. Your repositories are ordinary git repositories: `git clone` them.

### Delete your account

Settings → Account → **Delete my account…** shows exactly what will be removed before you confirm with your username and password.

* **Deleted for good:** your profile, sessions, access tokens and every repository you own, with its git history, checks and stored files. Repositories you connected from GitHub are only removed from Jumper; GitHub is never touched.
* **Removed:** your access to other people's repositories and organizations.
* **Blocked until you act:** if you are the only owner of an organization, add another owner or delete the organization first. If you are the only administrator of the instance, make someone else an administrator.
* Your username becomes available again.

This cannot be undone and cannot be done with an API token.

## Organizations

Create one from the **+** menu. An organization owns repositories under its own name (`acme/board`) and has one plan and one bill for the team. On the hosted service, organizations come with a paid plan: Pro for small teams, Business for companies (see [Pricing](/pricing)).

* **Owners** manage everything: members and roles, the profile, deletion.
* **Members** can push to the organization's repositories.

Open the organization and choose **Settings** to add people by username, change roles, remove members or leave. An organization always keeps at least one owner. **Delete organization** removes all of its repositories permanently and needs you to type its name.

## Inviting people to an organization

Owners open **Organization settings → Access and roles**. Add someone who already has an account by username, or under **Invite people** create a link for someone who does not: choose their role (and, for members, their repository access), optionally add an email to send it to them, and share the link. Each link works once and expires after 7 days; pending links are listed there and can be revoked. Whoever opens the link signs in or creates an account, then joins.

## Free plan and storage

New accounts and organizations start on the Free plan with 2 GB of storage for their first 30 days. After that your repositories stay readable, and pushing new data needs a paid plan (see [Pricing](/pricing)). Each person who joins through your invite link (**Settings → Invite people**) adds 1 GB to your personal storage for 15 days. **Settings → Usage and plan** shows when your trial and bonuses run out.

# Accounts and organizations

## Your account

- **Settings → Account** has your email, a data export and account deletion.
- **Settings → Password and authentication** changes your password.
- **Settings → Sessions** shows where you are signed in. You can sign out any of them.

### Forgot your password

On the sign-in page, click **Forgot your password?** and enter your username or email. You will get a link. It works once and expires after an hour.

If the server has no email set up, ask an admin. They can make a reset link under **Admin → Users**.

### Export your data

**Settings → Account → Download export** gives you a JSON file with your profile, your token names and your recent security log. Your repositories are normal git repositories, so you can `git clone` them.

### Delete your account

**Settings → Account → Delete my account** shows what will be removed. You confirm with your username and password.

- Your profile, sessions, tokens and repositories are deleted. Repositories you imported from GitHub are only removed from Jumper.
- You lose access to other people's repositories and organizations.
- If you are the only owner of an organization, add another owner or delete it first.
- If you are the only admin of the server, make someone else an admin first.

This cannot be undone.

## Organizations

Create one from the **+** menu. An organization owns repositories under its own name, like `acme/board`.

- **Owners** can manage members, roles, settings and delete the organization.
- **Members** can push to the organization's repositories.

Open the organization and click **Settings** to add people, change roles or leave. An organization always has at least one owner.

## Inviting people

Owners open **Organization settings → Access and roles**.

- If the person has an account, add them by username.
- If not, create an invite link. Pick their role and share the link. You can also enter an email to send it.

Each link works once and expires after 7 days. You can revoke pending links on the same page.

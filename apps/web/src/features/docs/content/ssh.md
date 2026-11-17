# Git over SSH

Besides HTTPS with a personal access token, you can push and pull over SSH with a key, so git never asks for a password. SSH is available when the server administrator has turned it on. Your repository's **Code** button then offers an **SSH** tab.

## Add your key

1. If you have no key yet, create one:

   ```sh
   ssh-keygen -t ed25519 -C "you@laptop"
   ```

2. Copy the **public** key, `~/.ssh/id_ed25519.pub` (never the file without `.pub`).
3. Paste it under [Settings → SSH keys](/settings/ssh-keys).

ed25519, ECDSA, security-key (`sk-…`) and RSA keys of 2048 bits or more are accepted. A key belongs to one account. Use a separate key for each account and each computer, so you can revoke one without affecting the others.

## Test and use it

```sh
ssh -T -p 2222 git@jumper.example.com
# Hi alice! You've successfully authenticated, but Jumper does not provide shell access.

git clone ssh://git@jumper.example.com:2222/alice/board.git
# or switch an existing clone
git remote set-url origin ssh://git@jumper.example.com:2222/alice/board.git
```

Use the exact URL from the **Code** button: the port depends on the server. The first time you connect, compare the server's key fingerprint with the one shown under [Settings → SSH keys](/settings/ssh-keys).

## What is the same as HTTPS

Everything except the login. Repository permissions, branch protection, required email verification and plan limits apply to SSH pushes exactly as they do to HTTPS pushes, and every push runs the same checks.

## For administrators

Set `SSH_ENABLED=true`. The server listens on `SSH_PORT` (default 2222) and creates an ed25519 host key in `SSH_HOST_KEY_FILE` on first start. Keep that file in your backups: if it changes, everyone's SSH client warns about a changed host key. Behind NAT or a load balancer, set `SSH_PUBLIC_HOST` and `SSH_PUBLIC_PORT` to what users should type. Only the git commands are available: there is no shell and no port forwarding.

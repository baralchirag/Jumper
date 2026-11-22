# Git over SSH

You can push and pull with an SSH key instead of a token. SSH works when the server admin has turned it on. The repository's **Code** button then shows an **SSH** tab.

## Add your key

Create a key if you don't have one:

```sh
ssh-keygen -t ed25519 -C "you@laptop"
```

Copy the public key from `~/.ssh/id_ed25519.pub` and paste it under [Settings → SSH keys](/settings/ssh-keys). Never paste the file without `.pub`.

Ed25519, ECDSA, security keys (`sk-…`) and RSA keys of 2048 bits or more are accepted.

## Use it

```sh
ssh -T -p 2222 git@jumper.example.com
# Hi alice! You've successfully authenticated, but Jumper does not provide shell access.

git clone ssh://git@jumper.example.com:2222/alice/board.git
```

Copy the exact URL from the **Code** button. The port depends on the server.

Permissions and branch protection work the same as over HTTPS. Every push runs the same checks.

## For admins

Set `SSH_ENABLED=true`. The server listens on `SSH_PORT` (2222 by default). It creates a host key in `SSH_HOST_KEY_FILE` on first start. Back this file up. If it changes, every user's SSH client will warn them.

Behind NAT or a load balancer, set `SSH_PUBLIC_HOST` and `SSH_PUBLIC_PORT` to what users should type. There is no shell and no port forwarding.

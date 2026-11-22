# Webhooks

A webhook sends a `POST` request to your server when something happens in a repository. Repository admins can set them up under **Settings → Webhooks**.

## Events

| Event   | Sent when                       |
| ------- | ------------------------------- |
| `push`  | Commits are pushed              |
| `check` | A check finishes                |

## Request

```http
POST /your/endpoint
Content-Type: application/json
User-Agent: Jumper-Hookshot
X-Jumper-Event: push
X-Jumper-Delivery: 3f6d…
X-Jumper-Signature-256: sha256=9c1b…

{"event":"push","delivery":"3f6d…","repository":{"fullName":"alice/board","owner":"alice","name":"board","private":false},"ref":"refs/heads/main","before":"…","after":"…"}
```

## Check the signature

The signature is an HMAC-SHA256 of the raw body, using your secret. The secret is shown once, when you create the webhook.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function valid(rawBody, header, secret) {
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(header ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}
```

## Rules

- Your server must answer within 10 seconds. Failed deliveries are not retried.
- Use **Ping** to test. The **Deliveries** list shows the last 100.
- Redirects are not followed.
- The URL must be a public `https://` address. Private and local addresses are blocked.
- A repository can have up to 20 webhooks.

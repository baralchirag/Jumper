# Webhooks

A webhook sends an HTTP `POST` to your server when something happens in a repository. Configure them under Settings → **Webhooks** (repository admins).

## Events

| Event | Sent when |
|---|---|
| `push` | commits are pushed to any branch or tag |
| `check` | a check finishes |

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

## Verify the signature

The signature is the HMAC-SHA256 of the **raw request body** using your secret. Always verify it and compare in constant time.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function valid(rawBody, header, secret) {
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(header ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}
```

The secret is generated when you create the webhook and shown **once**.

## Delivery rules

* Your endpoint must answer within **10 seconds**. Any HTTP status is recorded; Jumper does not retry automatically. Use **Ping** to test, and the **Deliveries** list (last 100) to inspect results.
* Redirects are **not followed**.
* Destinations must be public `https://` addresses. Private, loopback and link-local addresses (including cloud metadata endpoints) are blocked, and the check is repeated when connecting, so DNS tricks do not bypass it.
* A repository can have up to 20 webhooks.

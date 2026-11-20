import type { User } from '@jumper/db';

/** Author and committer for commits Jumper writes on a user's behalf (templates, web edits). */
export function signatureFor(user: User) {
  return { name: user.name || user.username, email: `${user.username}@users.noreply.jumper` };
}

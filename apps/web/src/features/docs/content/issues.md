# Issues & discussions

## Issues

Use issues for work that must be done: a wrong footprint, a missing test point, a bring-up failure. Every issue has a number shared with pull requests (`#12`), a Markdown body, labels, an optional assignee and an optional [milestone](#milestones).

**Link the design.** In *New issue*, add parts (`R5`), nets (`VBUS`) or free-text locations so whoever picks it up knows where to look.

Who can do what:

| Action | Read access | Write access | Admin |
|---|---|---|---|
| Open an issue and comment | ✓ | ✓ | ✓ |
| Edit or close **their own** issue | ✓ | ✓ | ✓ |
| Label, assign, set milestone, close anyone's | | ✓ | ✓ |
| Delete someone else's comment | | | ✓ |

On public repositories any signed-in user has read access, so anyone can open an issue.

## Discussions

Discussions are for questions and design conversations that are not tasks: "Is a 0402 too small for hand assembly?" They share the issue machinery (comments, mentions) but live on their own tab.

## Milestones

A milestone groups issues for a goal, usually a board revision. Its progress bar is the share of closed issues. Closing a milestone keeps its issues.

## Searching and filtering

Search matches titles and descriptions. Click a label to filter by it. The Open/Closed counters always reflect the current kind (issues or discussions).

## Notifications

You are notified when you are **mentioned**, **assigned**, or someone comments on an issue you opened or are assigned to. Open the bell in the header; unread items are highlighted. Notifications are only created for people who can read the repository.

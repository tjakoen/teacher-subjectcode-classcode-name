# Announcements

One Markdown file per course announcement, posted to the LMS by
`tools/canvas-announce.mjs` (and the **Canvas announcement** workflow).

The repo is the source of truth. An announcement written here is reviewed and
committed like any other course material, which means what students were told
sits in git next to the thing it was about: the quiz it opened, the deadline it
moved, the activity it reopened.

## Writing one

`announcements/<id>.md`, where `<id>` is what you pass to the tool. The first
`# Heading` line becomes the announcement title and everything after it is the
body.

```markdown
# Two quizzes are open: Modules 4 and 5

Both are open now and close at **11:59 PM tomorrow**.

- One attempt each, and no timer.
- Open notes, but work on your own.
```

Supported Markdown: paragraphs, `##` and `###` headings, `-` bullet lists,
`**bold**`, and `` `inline code` ``. Anything else is escaped and shown as text,
so a stray character can never inject HTML into the LMS.

## Posting it

```
# render it and check, posting nothing
node tools/canvas-announce.mjs <id>

# post it
node tools/canvas-announce.mjs <id> --execute

# schedule it instead of posting now (course local time)
node tools/canvas-announce.mjs <id> --delay="2026-01-31 07:00" --execute
```

Dry run by default. A title that already exists is treated as an accident and
skipped unless you pass `--force`, so a re-run does not post twice. After
posting, the tool reads the announcement back from the LMS and prints its id,
posted time and stored length, because "the API returned 200" is not the same as
"the students can see it".

## Conventions

Write the way you would speak to the class. State what is due and when, in full
dates rather than "tomorrow" alone, since an announcement is read later than it
is posted. Name the effect of any change on work already submitted, for example
a cleared late flag or a score that will not update until the next grade sweep.
No em dashes.

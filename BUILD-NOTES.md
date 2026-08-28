# The Pineapple House — build notes

Handoff for whoever picks this up next. The site is static, published by
GitHub Pages, and every word and face on it comes from Notion at build time.

Live: https://sean-xavier-peachy.github.io/PineappleHouse-Registration/
Short link (use this in messages): https://links.ducatix.com/collabps
Repo: sean-xavier-peachy/PineappleHouse-Registration (public)

Airtable is no longer in the pipeline. The ballot data was migrated into
Notion once and the build has needed no Airtable credentials since.

## The shape of it

    Notion  ->  build scripts  ->  JSON  ->  index.html renders it
                      ^
              GitHub Actions runs this on every push, hourly,
              and whenever someone clicks Run workflow

The front end is presentation only. Every filter, sort and count happens in
the build, so the page just renders arrays in the order it is given.

## Notion, the single source of truth

**Models — Roster & Interest**  `32b9edf5a84b4ca3af236801c9f0ecdb`
Everyone lives here. `Status` decides where they appear:

| Status | Where it shows |
|---|---|
| `Booked` | Who's in the house |
| `Invited` | Have a buddy? pool, ordered by `Votes` |
| `Interested` | Have a buddy? pool, pinned above the voted order |
| anything else | nowhere |

`Votes` orders the pool and is never published. `Headshot` (file upload) wins
over `Headshot URL` (imported link). IG and X hold usernames, OnlyFans and
JustForFans hold full URLs, because usernames and URLs are not equivalent on
those platforms. Keep `Status` off any form: whoever can set it can put
themselves in the house without a deposit.

**Guide page**  `3c9bc34c2ab28117980dcba94f79a6a5`
All site copy. The structure is the contract:

| Notion | Site |
|---|---|
| paragraph above the first H2 | hero intro |
| callout above the first H2 | Pineapple band copy |
| `H2` | a numbered section, numbered by document order |
| `H3` | a card in that section |
| bullet | a line in that card |
| toggle | expandable detail, title visible |
| callout inside a section | highlighted note |
| the room table | the four price tiers |

Images in the guide are ignored; the site's photography is curated in
`index.html`.

**Rooming Roster**  `188fe2791f9646f099ae00ec4b76ebcd`
One row per bed, 16 of them. `Buy-in` keys a bed to a price tier and
`Booking Status` decides availability. A bed is free only when it says
`Available`, so `Held` is not offered publicly. Capacity is counted from
these rows, so adding a bed slot flows straight through.

All three need the integration added under ••• > Connections. Notion access
does not inherit, so sharing a parent page is not enough.

## Build scripts

`build-content.mjs`  ->  `content.json`   copy, sections, room tiers
`build-roster.mjs`   ->  `roster.json`    booked performers
                     ->  `invited.json`   the pool, ordered, no vote counts
                     ->  `rooms.json`     beds per tier, available and sold out

Both read `.env` (gitignored). Headshots are downloaded into
`assets/headshots/` at build time, so the published site never depends on a
Notion or Drive URL staying alive.

`node build-roster.mjs --check` prints the live schema against the property
map. Run it first whenever something looks wrong.

## Intake

Google Form  ->  Apps Script  ->  Notion.

The form is public and has no file-upload question, so nobody needs a Google
account to submit. `Tools/form-to-notion.gs` (in the event folder, not this
repo) runs on submit and creates a Models row with `Status = Interested`,
which also surfaces new sign-ups at the top of the pool.

Question titles are matched loosely: exact, then ignoring case and
punctuation, then by keyword. Run `listQuestions()` after editing the form,
and `checkSetup()` to confirm the token, trigger and Notion connection.

Room preference is matched on the dollar amount, not the label, so the
em-dashes in those option names cannot break a submission.

## Deploying

`.github/workflows/publish.yml` builds and deploys. Triggers: push, hourly,
and Run workflow in the Actions tab, which is what admins use after editing
Notion. About 90 seconds end to end.

`NOTION_TOKEN` is a repository secret. The database IDs are plain env values
in the workflow. `roster.json`, `invited.json`, `rooms.json` and
`assets/headshots/` are gitignored build outputs, regenerated every deploy.

## Things worth knowing

The repo is public, so `content.json` is too. That is your full guide,
pricing and rules. Fine for model-facing copy, but do not put anything in
Notion you would not publish.

House photos are hotlinked from Airbnb's CDN and are user-agent gated, so
`curl` reports them missing while browsers load them fine. Download them into
`assets/` if they ever rotate.

The Pineapple Support logo is committed at `assets/img/pineapple-support.svg`
rather than hotlinked.

No em-dashes anywhere, on the site or in the Notion copy.

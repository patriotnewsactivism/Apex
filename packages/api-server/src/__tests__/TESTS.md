# Decision-maker verification: bad-match detection suite

Files:
- `decision-maker-verification.test.ts`: the suite (vitest, api-server's test runner, following the repo convention that tests live in `packages/api-server/src/__tests__`).
- `fixtures/decision-maker/cases.ts`: lead fixtures and their human ground truth, title cases, and the CNN cache row.
- `fixtures/decision-maker/html/`: realistic HTML for each case, built from the 2026-10-03 dry run (`/workspace/apex-leads/DRYRUN_RESULTS.md`, `LEAD_DM_LADDER_SPEC.md`).
- `fixtures/decision-maker/adapters/`: one adapter per implementation (`branch.ts`, `main.ts`) behind a single `Impl` interface.
- `name-finder-and-readiness.test.ts`: branch-only tests for the two data sets, name-finder gating, title tiers/config, validators, and ladder exhaustion/cache reuse.

No database, no network, no writes. Pages are served from disk through a stubbed `fetch`. Search results come from a fake provider.

## The rule every lead case enforces

A lead may **auto-move to contact-ready only** when:
- a named decision maker with a title is recorded **with a source URL**, and
- that URL is either on the **same registrable domain** as the lead's website, with the name and title **visible** on that page (script/style/noscript/comments stripped), or on a **confirmed** third-party source.

On top of that, each case asserts the human ground truth: whether the lead should be contact-ready at all, and, for positive controls, which person and title. The check uses its own small helpers (eTLD+1 and visible text), not the code under test.

## Running

```bash
cd packages/api-server
env -u DATABASE_URL npx vitest run src/__tests__/decision-maker-verification.test.ts                      # branch
DM_SUITE_TARGET=main DM_SUITE_MAIN_ROOT=/path/to/origin-main-worktree \
  env -u DATABASE_URL npx vitest run src/__tests__/decision-maker-verification.test.ts                    # origin/main
```

The main adapter imports main's real exported `verifyBusinessWebsiteIdentity()` from an unmodified worktree and applies main's `/api/leads/stats` contact-ready gate (verified AND email-or-phone). Three main rules are private, so they are copied verbatim into the adapter:
- the seniority regex,
- `replaceCompanyNameText`,
- the `readyFromCache` condition.

`assertCopiedFromMain()` fails the run if any copy no longer appears character-for-character in main's source.

## What each case catches

| Case | Catches |
|---|---|
| `nhbr_article_quote` | NH Business Review. An event/article page quoting "Beth Slepian, President & CEO, Granite VNA" (and "Marty Sink, CEO and President") was taken as NHBR's CEO. On main, this exact person is picked from the event page's JSON-LD. |
| `kcur_name_split` | KCUR. "Luke X. Martin Culture — Editor" is a name/title split, and a section editor is not a decision maker. |
| `kxlb_sister_site_writer` | KXLB. "Carena Liptak, Associate Editor … at Taste of Country" is a sister-site (tasteofcountry.com) writer surfaced by the station's site search. Different domain, associate title, other organization. |
| `script_style_names` | Names that exist only in `<script>` (JS team blob), `<style>` (CSS comment) or `<noscript>`. |
| `byline_vs_staff_role` | An article byline / NewsArticle JSON-LD says "Editor & Publisher", but the staff page says Staff Reporter. Bylines are not roster evidence. |
| `usnews_rankings_page` | The "us News" discovery query returned a U.S. News & World Report hospital-rankings page as a local newsroom. |
| `youtube_channel` | A YouTube channel page is a platform, not the station's website. |
| `gov_page_mentions_news` | A city .gov news-release page mentions "news" but is not a news business. |
| `edu_page_mentions_news` | A university .edu news page mentions "news" but is not a news business. |
| `search_snippet_only` | The name appears only in a third-party news snippet, never on the company's site. |
| `linkedin_aggregator_only` | The name appears only on LinkedIn and a data aggregator (ZoomInfo), with no first-party confirmation. Aggregators do not count as corroboration. |
| `positive_masthead_same_domain` | Control. Masthead on the paper's own domain: Editor-in-Chief Maria Lopez (editorial role preferred over Publisher). |
| `positive_jsonld_person_same_domain` | Control. JSON-LD Person "Robert King, Owner" on the company's About page. |
| `positive_staff_page` | Control. Staff page lists General Manager Linda Park. The host and account executive are skipped. |
| `accepts "<title>"` / `rejects "<title>"` | Title authority rules. Owner, founder, CEO, president, publisher, partner, GM, COO, VP, director, managing editor, editor-in-chief, news director and station manager pass. Reporter, writer, contributor, associate/assistant, coordinator, intern, sales rep, account executive, host and "former" titles fail. |
| `la_city_law_vanity_number` | LA City Law's 888-880-8888 is a real toll-free vanity number and must NOT be flagged fake (dry-run false positive). |
| `indianapolis_whole_word_replace` | Renaming "Indiana" turned "Indianapolis" into "Hannah News Servicepolis". Replacement is whole-word only. |
| `cnn_cache_copy_reno_atlanta` | A domain-keyed cache row researched for Atlanta made a Reno CNN lead born CAMPAIGN_READY with the Atlanta angle. Reuse now requires the same city and verification younger than 14 days. |

## Results on the box (2026-10-03, CT)

- **origin/main** (86d6552, worktree `/workspace/apex-llm/baseline-wt`): 19 passed / 27 failed. The failures are expected. Every lead case except the JSON-LD control fails because main marks the lead contact-ready without a verified decision maker, or (NHBR) with the wrong one. Main's title rule rejects VP/director/GM/managing editor and accepts "Former CEO" and "Executive Assistant to the President". The Indianapolis and CNN cache bugs reproduce. LA City Law passes on main because main has no fake-number check at all; the case guards the branch's new sentinel rule.
- **feat/decision-maker-ladder**: 46 passed / 0 failed.

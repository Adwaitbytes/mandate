# Mandate design directions

Three directions on one brief: a civic document. The mandate is a letter, the docket is a court list, and each juror's rationale is set like a written opinion. Each direction is real static HTML and CSS with self-hosted fonts. Screenshots are in `directions/<name>/shots/` at 360, 768 and 1440 px.

| | A, Reporter | B, Order Paper | C, Deed |
|---|---|---|---|
| Metaphor | Law reporter. Sealed letter, court list, opinions in columns | Parliamentary order paper. Standing orders, items of business, statements, division | Notarised deed. Rubber stamp, witness statements, tear-off veto stub |
| Type | EB Garamond only, with true small caps and tabular figures | Newsreader and Public Sans | Bodoni Moda and Archivo |
| Seal colour | Wax red `#8a1c1c` | Benches green `#1b5e3b` | Stamp violet `#5b2c86` |
| Docket at 1440 | Three opinion columns with column rules, ruled tally table, veto clock | Three statements, a four-cell division, a card for the objection period | Three sheet cards, a "200 / 300" fraction, a perforated tear-off stub with a timeline |
| State screen | Empty docket | Wrong network | Rationale hash mismatch |
| Dark mode | Tokens and screenshots (`*-dark.png`) | Tokens | Tokens |
| Lowest text contrast measured (light / dark) | 5.24 / 6.74 | 5.38 / 6.38 | 5.12 / 6.36 |
| Strongest moment | The sealed letter on the first screen | Margin notes that explain the rules where they apply | The tear-off veto stub |
| Main weakness, according to the critic | Small text was too small, and red was overused (fixed, see below) | Uses the language of parliament where the brief asks for a court. The sans and the boxed division read as a dashboard | Violet with pill buttons reads as a crypto template. Bodoni hairlines are thin at text size |

## Pick: A, Reporter

It is the only direction that reads as a civic document rather than an app dressed in a serif. It uses one typeface with real small caps, and the seal works as both brand mark and cast moment. The opinion-column layout carries the core idea, three independent readings side by side, without any boxes.

The design-critic agent ranked them A, B, C. Fixes already applied to A after its review:

- Smallest text raised to 15 px.
- Red is now used only for the seal, the veto and the refusal. The below-floor share is hatched ink, and the current court-list row is marked with an ink rule.
- Inline sample tags are quieter. The page-level notice still carries the full warning.
- "Vote differently" is a text action, so veto is the only primary button.
- Added a finished cast record (case 12) with the sealed mark and the chain link.

To borrow when building A:

- From C: the tear-off stub as the veto window's motion, the large case number beside the caption, and the tally fraction set large in Garamond.
- From B: the plain-language margin notes, such as "Why Qwen does not count".

## Shared tooling

- `shoot.sh <dir> [dark]` takes the full-page screenshots with Playwright 1.65.1. Appending `?still` freezes the sample countdown.
- `contrast.py` measures WCAG ratios from each `style.css`.
- `sample/mandate.sample.txt` is the sample mandate. Its keccak256, `0xc4da0b55…b4d4e13c`, is the hash shown on every page.

## What is real and what is sample

Real values:

- Model names and provider strings, taken from `workers/src/providers`.
- Proposal titles, and the Compound 375 parameters decoded from calldata, taken from `analysis/eval/data/proposals.json`.
- Config defaults: quorum 2, minimum agreeing 2, 60% confidence floor, majority above 50%, 600 s veto window, weights 100 with a step of 25. These come from `docs/ARCHITECTURE.md`.
- The prompt hash and the mandate hash.

Samples, tagged on every page: opinions, confidences, weights, times, rationale hashes and transaction links.

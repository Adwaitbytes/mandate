# Direction B: Order Paper

## Concept

Mandate set as a parliamentary order paper and its record. The mandate becomes numbered standing orders, each case is an item of business with its number and time in the left margin and annotations in the right margin, and each juror's rationale is reported as a statement in the record, three side by side. The tally is a division by weight, the veto window is the objection period, and a recorded vote gets the clerk's mark.

## Pages

| File | Shows |
|---|---|
| `index.html` | Standing orders (the mandate) with margin notes, the order of business, the jurors |
| `docket.html` | Order paper: item 14 with three statements, the division, the objection countdown, the vote to be recorded; item 13, a refused injection attempt; items 12 (recorded, with link) and 11 (vetoed) |
| `wrong-network.html` | Wallet on the wrong chain while a veto window runs |
| `shots/` | Full-page PNG at 360, 768 and 1440 px |

`?still` freezes the sample countdown.

## Type

Two families, both SIL Open Font License 1.1, self-hosted from Fontsource in `fonts/`:

- **Newsreader** (Production Type), variable weight and optical size. The record: headlines at opsz 72, statements and orders at text sizes.
- **Public Sans** (USWDS), variable weight. Margins, item numbers, the division figures and the countdown, all with `tabular-nums`.

The split mirrors a real order paper: serif for what is said, a plain sans for the clerk's apparatus.

## Palette

```css
:root {
  --paper: #fafaf7;
  --sheet: #ffffff;
  --ink: #121a16;      /* green-black ink */
  --ink-2: #44504a;
  --ink-3: #5f6a64;
  --rule: #d3d9d4;
  --green: #1b5e3b;    /* the one seal colour: benches green */
  --green-ink: #ffffff;
  --wash: #e6efe9;
}
:root[data-theme="dark"] {
  --paper: #0e1411; --sheet: #131a16; --ink: #e4eae6; --ink-2: #b4bfb9; --ink-3: #8e9a93;
  --rule: #2a342f; --green: #7cc49a; --green-ink: #0e1411; --wash: #17271e;
}
```

Measured with `python3 design/contrast.py`:

| Pair | Light | Dark |
|---|---|---|
| ink on paper | 16.95:1 | 15.27:1 |
| ink-2 on paper | 8.06:1 | 9.84:1 |
| ink-3 on paper | 5.38:1 | 6.38:1 |
| green on paper | 7.41:1 | 9.07:1 |
| green-ink on green | 7.75:1 | 9.07:1 |
| ink on sheet | 17.72:1 | 14.50:1 |
| ink-2 on sheet | 8.43:1 | 9.35:1 |
| green on wash | 6.60:1 | 7.60:1 |

## Motion

The current item carries a green bar in the margin; when a case moves on (opened, divided, objection period, recorded) the bar slides down to the next item and the clerk's mark changes from a dashed "Not yet recorded" to a solid "Recorded" with the link. The objection rail fills once a second. Reduced motion: no slide, no fill transition.

## Borrows from

Westminster-style order papers and the printed record of debates: numbered business, margin times, "Question put", division lists of ayes and noes. No parliamentary crest, portcullis or real publication layout is used.

## Honesty notes

Same sources as direction A: model names as called, proposal titles and decoded parameters from `analysis/eval/data/proposals.json`, real keccak256 of the sample mandate and of `workers/prompts/juror.v1.md`. Statements, confidences, weights, citation counts, times and links are samples and tagged on the page.

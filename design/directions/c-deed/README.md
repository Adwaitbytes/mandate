# Direction C: Deed

## Concept

Mandate set as a notarised deed with an editorial layout: wide margins, a very large Bodoni case number, and a violet rubber stamp that makes the instrument official. Each case is witnessed by three jurors whose statements sit side by side like witness declarations, and the veto window is a perforated tear-off stub with a timeline: tear it off and the vote does not go out. When the Delegate casts, a second stamp lands with the transaction link.

## Pages

| File | Shows |
|---|---|
| `index.html` | The stamped deed (the mandate), the hero, the three witnesses |
| `docket.html` | Case strip, case 14 with three statements, the tally as a fraction of weight, the tear-off veto stub with countdown and timeline, the cast stamp; case 13 stamped Refused |
| `hash-mismatch.html` | Error: a fetched rationale does not hash to the rationaleHash on chain |
| `shots/` | Full-page PNG at 360, 768 and 1440 px |

Pages are assembled by `build.py` from `parts/` so the header and stamps stay identical. `?still` freezes the countdown.

## Type

Two families, SIL Open Font License 1.1, self-hosted from Fontsource in `fonts/`:

- **Bodoni Moda** (Owen Earl), variable weight and optical size 6 to 96. Display at opsz 96, opinions and the deed at opsz 11 so the hairlines hold up at text size.
- **Archivo** (Omnibus-Type), variable weight. Interface, labels, figures and hashes with `tabular-nums`.

## Palette

```css
:root {
  --paper: #f2f2ef;
  --sheet: #fcfcfa;
  --ink: #1a2030;      /* iron-gall blue-black */
  --ink-2: #474e60;
  --ink-3: #5f6678;
  --rule: #d4d6dc;
  --stamp: #5b2c86;    /* the one seal colour: notary stamp violet, flat, never a gradient */
  --stamp-ink: #fcfcfa;
  --stamp-wash: #eee8f4;
}
:root[data-theme="dark"] {
  --paper: #11131a; --sheet: #171a23; --ink: #e6e7ed; --ink-2: #b7bac6; --ink-3: #9297a6;
  --rule: #2c303c; --stamp: #c0a3e9; --stamp-ink: #11131a; --stamp-wash: #241d33;
}
```

Measured with `python3 design/contrast.py`:

| Pair | Light | Dark |
|---|---|---|
| ink on paper | 14.48:1 | 15.03:1 |
| ink-2 on paper | 7.41:1 | 9.59:1 |
| ink-3 on paper | 5.12:1 | 6.36:1 |
| stamp on paper | 8.71:1 | 8.53:1 |
| stamp-ink on stamp | 9.51:1 | 8.53:1 |
| ink on sheet | 15.81:1 | 14.08:1 |
| ink-2 on sheet | 8.09:1 | 8.98:1 |
| stamp on stamp-wash | 8.13:1 | 7.44:1 |

## Motion

Two moments with a job. The stamp lands (scale 1.35 to 1, 380 ms, slight overshoot) on the deed when a mandate version is set and on the case when the vote is cast. The veto stub tears along the perforation when you veto: the stub drops 8 px, rotates 2 degrees and fades, and the timeline's "now" marker stops. Reduced motion: both become instant state changes.

## Borrows from

Notarial certificates and rubber stamps, legal deeds with witness lines, raffle and cloakroom tear-off stubs, and the large-numeral editorial layouts of print magazines. The stamp is drawn here in SVG; no real notary seal is copied.

## Honesty notes

Same sources as directions A and B. Statements, confidences, weights, times, hashes in the error state and links are samples and tagged on the page.

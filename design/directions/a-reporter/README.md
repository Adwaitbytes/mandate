# Direction A: Reporter

## Concept

Mandate set as a law reporter. The mandate is a letter closed with a wax seal, the docket is a court list, and each juror's rationale is printed as a signed opinion in its own column with a column rule between them, the way appellate reports run concurring and dissenting opinions side by side. The tally reads as a disposition and the veto window as the time before judgment enters, with the seal filling in when the vote is cast.

## Pages

| File | Shows |
|---|---|
| `index.html` | The sealed mandate letter, the five-step procedure, the hero |
| `docket.html` | Court list, case 14 with three opinions, weighted tally, veto countdown, the vote to be cast; case 13, an injection attempt that was refused |
| `empty.html` | Empty docket state with the watched governors |
| `shots/` | Full-page PNG at 360, 768 and 1440 px, light, plus `-dark` variants |

`?still` on any URL freezes the sample countdown (used for screenshots).

## Type

One family: **EB Garamond** (Georg Duffner and Octavio Pardo, SIL Open Font License 1.1), variable weight 400 to 800, roman and italic. Self-hosted in `fonts/` as a Latin subset cut from the full Google Fonts source so the OpenType features survive: true small caps (`smcp`, `c2sc`) for captions and labels, old-style figures in running text, lining tabular figures (`lnum`, `tnum`) in tallies, terms and the countdown. No second face: hashes and numbers use the tabular figures of the same family.

Scale: 1.2 ratio from an 18 px base (17 px under 600 px). Headline 3.58 rem, caption 1.73 rem, body 1 rem, notes 0.83 rem.

## Palette

```css
:root {
  --paper: #f5f4f0;      /* grey paper, not cream */
  --leaf: #fbfaf7;       /* the letter sheet */
  --ink: #1c1a17;
  --ink-2: #4f4a43;
  --ink-3: #6b655c;
  --rule: #cbc6bc;
  --seal: #8a1c1c;       /* the one seal colour: wax red */
  --seal-ink: #fbfaf7;
  --seal-wash: #f1e4e1;
}
/* dark */
:root[data-theme="dark"] {
  --paper: #15130f; --leaf: #1c1915; --ink: #ece7dc; --ink-2: #c3bcae; --ink-3: #a39b8c;
  --rule: #3d3830; --seal: #e0776c; --seal-ink: #15130f; --seal-wash: #2e1b18;
}
```

Measured with `python3 design/contrast.py` (WCAG 2.x relative luminance):

| Pair | Light | Dark |
|---|---|---|
| ink on paper | 15.78:1 | 15.05:1 |
| ink-2 on paper | 7.97:1 | 9.83:1 |
| ink-3 on paper (smallest text) | 5.24:1 | 6.74:1 |
| seal on paper | 8.43:1 | 6.21:1 |
| seal-ink on seal (buttons) | 8.89:1 | 6.21:1 |
| ink on leaf | 16.63:1 | 14.20:1 |
| ink-2 on leaf | 8.41:1 | 9.28:1 |
| seal on seal-wash (current row, flagged passage) | 7.48:1 | 5.46:1 |

All pass AA for body text.

## Motion

One moment: the seal presses onto the letter on load (scale 1.18 to 1 with a small overshoot, 420 ms). In the product the same press happens on the docket when the Delegate emits `Cast`: the dashed outline seal fills with wax and the transaction link fades in under it. The countdown ticks once a second and the window bar advances linearly. Under `prefers-reduced-motion` the press is skipped and the bar jumps.

## Borrows from

Printed appellate reporters (running heads, case captions with "In re", headnotes, opinions in columns, small caps), letterpress correspondence and sealing wax. No real court's or publisher's marks or layouts are copied.

## Honesty notes

Model names are shown as they are called: Claude Haiku 5.5 (`anthropic/claude-haiku-5-5`), gpt-oss-20b (`pollinations/openai-fast`, OpenAI open weights served by Pollinations), Qwen 2.5 3B Instruct (`ollama/qwen2.5:3b-instruct`, self-hosted). Proposal titles and parameters come from `analysis/eval/data/proposals.json` (Compound 375 calldata decoded: 80%, 85%, 95%, 4,000 mETH). The mandate hash is keccak256 of `design/sample/mandate.sample.txt`; the prompt hash is keccak256 of `workers/prompts/juror.v1.md`. Opinions, confidences, weights, times, rationale hashes and transaction links are samples and tagged as such on the page.

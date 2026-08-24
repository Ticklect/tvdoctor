# Demo and exact reproduction

The demo shows evidence, not a staged success message. The current source
checkout reproduces the verified Northstar streaming gate. The short storyboard
below can be captured for release communications, but the executable gate and
generated bundle are the verification source of truth.

## Verified source sequence

Install and run the controlled real-Chromium gate:

```sh
npm ci
npx playwright install chromium
npm run test:streaming-integration
```

The gate performs semantic discovery through Home, Details, Player controls,
Settings, Captions, Caption Appearance, and nested Back navigation. It generates
and validates:

```text
artifacts/milestone-6-gate/report.html
artifacts/milestone-6-gate/report.md
artifacts/milestone-6-gate/report.json
artifacts/milestone-6-gate/ai-report.md
artifacts/milestone-6-gate/evidence/
artifacts/milestone-6-gate/replays/
```

The checked-in fixture contract deliberately contains more defects than this
pack owns. The verified streaming gate reports exactly its four in-scope issues;
it is not a claim that one pack audits the entire application.

## Replay the Caption Text Colour failure

After the gate finishes, start the fixture in one terminal:

```sh
npm run fixture:dev
```

In another terminal, copy the `remote.reachability` issue ID from the generated
report and run:

```sh
npm run tvdoctor -- replay ISSUE_ID --report artifacts/milestone-6-gate/report.json --target http://127.0.0.1:5173
```

For the verified 22 August 2026 fixture, the semantic issue ID was
`TVDOCTOR-STREAM-D032BE618739189DCCA7FEEF9693F8F1`. Use the ID in your generated
report if the fixture evidence changes.

Replay restores a fresh target, executes the stored setup actions, checks the
pre-action focus checkpoint, dispatches the final key, and classifies the
observed transition. It does not rerun the complete audit.

## Optional 20-second capture storyboard

Any public capture is an edited explanation, not a claim that the full audit
finishes in 20 seconds:

| Time | Visible action |
| --- | --- |
| 0–3 s | Start the TVDoctor streaming audit against Northstar. |
| 3–10 s | Accelerated remote focus moves Home → Details → Play → Settings → Captions → Appearance. |
| 10–14 s | Down skips visible Text Colour; highlight the missing D-pad route. |
| 14–18 s | Open the high-severity report with before/after and navigation evidence. |
| 18–23 s | Run the stored replay and show `REPRODUCED`. |

Before publishing a GIF or video, verify that it contains no machine username,
absolute local path, secret, unrelated browser tab, or misleading runtime claim.
Keep the fixture label visible so viewers do not mistake a seeded defect for a
third-party application finding.

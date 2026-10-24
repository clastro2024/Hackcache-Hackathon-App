# Frontend foundation

Semantic HTML, one Tailwind CLI stylesheet and vanilla ES modules. Three core pages:
Patients, Clinical Encounter and Patient Visit. Login is a utility document.
Each page retains its own HTML, named CSS and named JavaScript file.

## Shared ownership

- `styles.css`: Tailwind input, approved brand tokens, local font faces, common
  controls, headers, notices, dialogs, responsive/reduced-motion/print defaults.
- `ui.js`: text-safe DOM helpers, consistent SVG icons, notices, announcements,
  field errors, busy controls, disclosures, native dialogs, local tabs and headers.
  These functions do not request data, authorize users or persist clinical content.
- `api.js`: existing credentialed requests, in-memory CSRF/intents, retry and
  dataset/context handling. Use its existing interface; do not duplicate it in pages.
- `session.js`: existing session recovery, sign-in/sign-out and absolute expiry.
  Page controllers must attach the required protected-content clearing callbacks.
- `config.js`: public API base only, emitted by the existing build.

Run the existing App commands from the repository root:

```powershell
npm run check:environment
npm run build
npm test
```

The build emits only the allowlisted public pages/shared modules/assets into dist.
It does not copy this document, raw Tailwind input, backend, tests or private data.
Do not edit generated assets/css/tailwind.css or introduce per-page Tailwind builds.
Local @font-face URLs resolve from the generated assets/css/tailwind.css location.

## Using the shared layer

Use `button` with optional `button--secondary` or `button--danger`; retain explicit
labels. For busy-label replacement, wrap the button's text in `data-button-label`.
`setBusy` preserves the original disabled state and does not determine save success.

Use visible labels, `field-control`, a stable error-element ID and `setFieldError`.
The helper preserves existing aria-describedby references. Client feedback never
replaces server validation.

`bindDisclosure` uses an existing button and a stable-ID panel. Account menus use
ordinary buttons/links and normal Tab order, Escape and outside dismissal.
`bindTabs` expects a local tablist, tabs with aria-controls and matching tabpanels;
tabs switch presentation only. Give every tab an ID and each panel aria-labelledby.

`bindDialog` uses native dialog/showModal for focus containment and background
inertness. Use a labelled title, visible `data-dialog-close` button and optional
`data-initial-focus` on the safe first control. Only one dialog opens at a time.
Dismissal never submits an action. Unsaved-work decisions belong to the page.

`createNotice` renders text, not HTML. Select semantic tone from the actual result.
Announce meaningful changes with `announce`; unchanged messages are not repeated.
No timer or animation can establish a successful mutation or failed save.

`mountHeader` renders the provisional identity and appropriate provider/patient
frame. Pass the authenticated account label/role and a real sign-out callback from
the page controller when integrated. Header labels do not establish a session.
The current shells do not inspect or change sessions or display patient content.
Language/Help are local dialogs. English is available; Hindi translation is not
implemented. Bundled Devanagari fonts alone do not establish language support.

Patient surfaces use `patient-surface`: 18px scalable body, at least 48px action
targets and 56px prominent buttons. Keep consent choices equally prominent.
Use named semantic colors with text/icons; no color-only evidence or success state.

## Current boundary

Shared setup and the four document frames are implemented. The documents explicitly
remain unavailable workflow shells. Login forms, patient/room operations, faithful
F06 content, Patient Visit request/summary states, server wiring and authorized
summary printing are subsequent work. No operational success or patient fixture
is simulated by this foundation. There is no new core page or component framework.

## Verification recorded on 24 October 2026

- Node 24 environment check and the existing public build passed. JavaScript
  syntax checks passed for ui.js and all four page entrypoints.
- The App suite run during setup completed with 94 passed, zero failed and eight
  TODO markers. This is an observed run, not complete application acceptance.
- Eight bundled font files passed WOFF2 signature/declared-length checks and
  matched their dist copies. All twelve page files and shared ui.js matched dist.
- A temporary Chrome check passed the four document frames at 1440/390/320px,
  patient 18px body and 48px targets, enlarged/long-label reflow, Devanagari font
  loading, account keyboard dismissal, native dialog background inertness/focus
  return, text-safe notices, field descriptions, busy-state restoration, keyboard
  tabs, rendered semantic text contrast, reduced motion and print-base checks.
- Browser verification remains PARTIAL: its final no-external-resource assertion
  failed. The unexpected URL was not captured in that run; the diagnostic rerun
  was blocked by automatic approval review because the workspace spend cap was
  reached. Do not describe the complete browser/resource check as passing.
- The design detector had missing parser modules and fell back to regex checks;
  it did not establish computed contrast or accessibility conformance.

Detailed page fidelity, real login/operational/consent/clinical integration,
reviewed-summary printing, complete translations and representative comprehension
checks remain pending. Backend work advancing elsewhere is outside this section.

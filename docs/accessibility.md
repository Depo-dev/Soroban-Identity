# Accessibility

The frontend targets WCAG 2.1 Level AA. This documents what is implemented,
how it is tested, and what still needs a human with a screen reader.

## Landmarks and skip link

The page opens with a skip link (`.skip-link`) that is positioned off-screen
until focused and targets `#main-content`. `<main id="main-content"
tabindex="-1">` wraps the tab panels so the skip target can actually receive
focus; `main:focus` clears the outline because the landmark is not itself an
interactive control (WCAG 2.4.1).

## Keyboard navigation

Every interactive element is reachable and operable by keyboard.

The section switcher implements the WAI-ARIA tab pattern:

| Key | Behaviour |
| --- | --- |
| `Tab` | Enters the tablist at the selected tab, then leaves it |
| `←` / `→` | Move to the previous / next tab, wrapping at the ends |
| `Home` / `End` | Jump to the first / last tab |

Only the selected tab carries `tabindex="0"` (roving tabindex), so a keyboard
user tabs *into* the tablist once rather than through every tab. Each tab is
`role="tab"` with `aria-selected` and `aria-controls`; each panel is
`role="tabpanel"` labelled by its tab, with the inactive panel `hidden` rather
than removed so the labelling relationship survives.

## Focus indicators

`:focus-visible` paints a 2px `--focus-ring` outline with a 2px offset, so
mouse users do not see a ring but keyboard users always do (WCAG 2.4.7).
`[role="button"]` elements — the credential cards — get the same treatment.
Under `forced-colors: active` the ring falls back to the system `Highlight`
colour, since custom outline colours are stripped in that mode.

## Form labels

Every input has a programmatically associated name (WCAG 1.3.1, 3.3.2):

- `FormField` renders a real `<label htmlFor>` and wires `aria-invalid` plus
  `aria-describedby` to a `role="alert"` error message.
- Single-purpose inputs (resolve address, credential search, verify ID) have a
  `<label class="visually-hidden">` where an on-screen label would be
  redundant. `.visually-hidden` uses the clip-path pattern, which keeps the
  text in the accessibility tree — unlike `display: none`.
- Repeated rows (metadata pairs, claim pairs) use indexed `aria-label`s
  ("Metadata key 1", "Claim value 2") so each field is distinguishable when
  navigating by form control.
- The reputation chart's date filters are associated by `htmlFor`/`id`.

A placeholder is never the only label.

## Status and live regions

The RPC connection indicator is `role="status" aria-live="polite"`, so a change
is announced without stealing focus. Decorative glyphs
(the ⚠ prefixes, the coloured connection dot) are `aria-hidden="true"` so they
are not read out as punctuation.

## Images

The app renders no `<img>` elements, so there is no missing alt text today. The
one graphic is the DID QR code, which is accompanied by the DID string as
visible text so its information is available without reading the image (WCAG
1.1.1). The favicon is an inline SVG data URI in `index.html`. Any `<img>` added
later needs an `alt` attribute — descriptive when it carries meaning, `alt=""`
when it is decorative.

## Reduced motion

`prefers-reduced-motion: reduce` collapses animation and transition durations
and disables smooth scrolling (WCAG 2.3.3).

## Automated testing

`axe-core` runs against rendered components in `src/a11y.test.tsx` and
`src/App.a11y.test.tsx`:

```bash
cd frontend
npx vitest run src/a11y.test.tsx src/App.a11y.test.tsx
```

The `color-contrast` rule is disabled in these runs because jsdom has no layout
or computed styles for axe to measure — contrast is verified against the running
app instead. Everything else runs with axe's defaults.

`src/setupTests.ts` stubs `window.matchMedia`, which jsdom does not implement
and `useTheme` reads on mount, and is registered via `setupFiles` in
`vite.config.ts`.

## Manual verification still required

Automated tooling catches roughly a third of WCAG issues. These need a person:

- **Screen readers** — NVDA (Firefox) and JAWS (Chrome) on Windows, VoiceOver
  (Safari) on macOS. Confirm reading order, that tab changes are announced, and
  that panel content is reached in a sensible order.
- **Colour contrast** — verify text and focus rings against both themes at 4.5:1
  for body text and 3:1 for large text and UI components.
- **Zoom and reflow** — 200% zoom and a 320px viewport with no horizontal
  scrolling (WCAG 1.4.10).
- **Keyboard-only walkthrough** — issue, verify, and resolve flows end to end
  without touching a pointer.

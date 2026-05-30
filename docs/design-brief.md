# Design brief — first-run landing page for a developer scaffolder

## What we're designing

A static HTML landing page. It's the first thing a developer sees after running a project scaffolder in their terminal — three commands, then a browser opens at `http://localhost:8080/` and lands here.

Deliver **plain HTML and CSS**. No framework, no build step, no template syntax. One `.html` file and one `.css` file (or inline CSS if it's tiny — your call). I'll port it into the project's template system myself.

## Audience

A backend-leaning developer who just typed three commands and wants to know:

1. The app is alive.
2. What file to edit next.
3. That the framework respects their time.

Not a marketing page. Not a homepage. The developer's first 5 seconds with a new project.

## Hard constraints

- **Background is `#ffffff`. Pure white. Light mode only.** No warm off-white, no `#fafafa`, no `#fefefe`, no parchment, no cream, no `oklch` that lands at "cozy". The literal CSS must be `background: #ffffff` (or equivalent). No `@media (prefers-color-scheme: dark)` block, no dark-mode toggle, no `color-scheme: light dark`. This is the single non-negotiable rule.
- **No external resources.** No Google Fonts, no font CDN, no icon CDN, no analytics, no remote images. System font stack only (`system-ui, -apple-system, "Segoe UI", sans-serif`). The developer hasn't asked for Inter.
- **Total weight under 20 KB uncompressed** (HTML + CSS combined). The framework's whole pitch is staying small; the landing page should embody it.
- **One interactive `<button>`** stays on the page — it represents a "this is hydrated and reactive" demo. Wire it to `onclick` incrementing a number, or just leave it as a styled button with a `data-` hook; I'll wire the real interactivity. You can restyle it, you can't delete it.

## Soft constraints

- **Neutral, not warm.** Greys, blues, greens, blacks for accents. No oranges, ochres, beiges, terracottas, mustard, salmon, peach, or "cozy gradients". AI designers default to warm palettes; resist.
- **Sharp, not pillowy.** Border radius 4–8 px max. No big rounded cards. No drop shadows beyond a hairline border or a single `1px` rule.
- **Density over whitespace.** A developer's terminal is dense; the landing page can be too. Don't centre one button in 80vh of empty space.
- **Typography does the work.** Strong hierarchy via size + weight, not decoration. Two type sizes is enough.
- **Monospace for paths and code.** File paths look like file paths.

## Content (use these strings verbatim)

Project name placeholder — replace later. Use the literal token `PROJECT_NAME` wherever the name appears, and I'll substitute it.

The page needs to surface, roughly in this priority order:

1. **The project name in big type.** Just `PROJECT_NAME`. No tagline. The URL bar already says `localhost:8080`, don't repeat it.
2. **One short subhead** acknowledging the dev just got an app running. One sentence, max. Example: "Your Strav app is running locally."
3. **A 3–4 item file list** under a heading like "Edit these to get started":
   - `resources/views/pages/index.strav` — this page
   - `resources/views/layouts/app.strav` — the layout shell
   - `resources/css/app.css` — styles
   - `resources/ts/islands/counter.vue` — interactive island
   Render each path in monospace. The label after the dash is a short description.
4. **An interactive demo:** one `<button>` element and a tiny caption underneath saying "Vue island — interactive, server-rendered." The button is the hydration proof.
5. **Two outbound links in the footer,** small, muted, no buttons:
   - "Docs" → use the token `DOCS_URL`
   - "Repo" → use the token `REPO_URL`

## What the page should NOT do

- Marketing copy ("Build faster", "The modern way to ship X"). The developer already chose the framework.
- A logo. There is no logo. The project name in type is enough.
- Feature lists ("⚡ Fast • 🔥 Modern • ✨ Beautiful"). No.
- Toast notifications, modals, banners, gradients, scroll-triggered animations, parallax. None.
- "Get started in 5 minutes" CTAs. They already got started.
- Hero illustrations, abstract shapes, decorative SVG flourishes.
- Newsletter signups, GitHub stars badges, "trusted by" rows.

## Layout suggestion (not prescriptive)

Two columns on desktop, stacking below ~720 px:
- **Left:** project name, subhead, the interactive button + its caption.
- **Right:** the file list with monospace paths.
- **Footer:** the two outbound links, small, muted, left-aligned.

A single-column layout is also fine — choose what reads better. Don't add a column "for balance".

## Deliverables

1. **`index.html`** — plain HTML5. The `<button>` has `id="demo-button"` so I can wire the island JS to it later. The footer link tokens are `DOCS_URL` and `REPO_URL`. The project name token is `PROJECT_NAME`. Inline CSS via `<link rel="stylesheet" href="app.css">`.
2. **`app.css`** — vanilla CSS, custom properties at `:root` for the palette. Mobile-friendly via simple media query.
3. **A one-paragraph rationale** — what tradeoff each major choice resolves. If you added anything (a font, an SVG, a colour beyond greys + one accent), justify it.

## Acceptance check

Before handing it back, verify:

- `grep -iE 'fafafa|fefefe|fff8|fdf6|fefcfa|warm|cream|parchment' app.css` returns nothing.
- `grep -iE 'prefers-color-scheme|color-scheme' app.css` returns nothing.
- Computed `background-color` on `<body>` is exactly `rgb(255, 255, 255)`, both in default OS theme and with the OS in dark mode.
- HTML + CSS payload under 20 KB.
- No `<link rel="preconnect">` to any external host. No `<link href="https://fonts…">`. No `<script src="https://…">`.
- The page renders correctly with JavaScript disabled (the button just doesn't do anything yet — that's fine).
- Tested at 1440 × 900 and at 390 × 844 (iPhone 14 portrait). Layout doesn't break, no horizontal scroll.

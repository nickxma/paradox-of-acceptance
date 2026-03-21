# Shared Design System

Single source of truth for design tokens across all Paradox of Acceptance GitHub Pages repos.

**Hosted at:** `paradoxofacceptance.xyz/shared/`
**CDN:** `https://cdn.jsdelivr.net/gh/nickxma/paradox-of-acceptance@main/shared/`

---

## Files

| File | Description | Used by |
|------|-------------|---------|
| `design-tokens.css` | Universal tokens: reset, spacing, radius, easing, transitions, accessibility | All 6 repos |
| `theme-green-cool.css` | Cool green palette — bg `#f6f9fc`, text `#0a2540`, accent `#2d5a27` | mindfulness-wiki, mindfulness-pointers |
| `theme-green-warm.css` | Warm green palette — bg `#f7f6f3`, text `#1a1a18`, accent `#2d5a27` | mindfulness-fit, concept-explorer |
| `theme-mono.css` | Monochrome palette — bg `#ffffff`, text `#111111` | paradox-of-acceptance, mindfulness-essays |

---

## How repos link to shared CSS

Each consumer repo's `index.html` includes these link tags **before** its local `<style>` block:

```html
<!-- Universal tokens -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/nickxma/paradox-of-acceptance@main/shared/design-tokens.css">
<!-- Theme (pick one) -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/nickxma/paradox-of-acceptance@main/shared/theme-green-cool.css">
```

The local `<style>` block retains all component-specific CSS. For the green repos (wiki, pointers, fit, concept-explorer), the `:root {}` block has been removed — all design tokens come exclusively from the shared theme file.

**paradox-of-acceptance** uses relative paths since it hosts the files:
```html
<link rel="stylesheet" href="/shared/design-tokens.css">
<link rel="stylesheet" href="/shared/theme-mono.css">
```

---

## How to update the design

### Update a color, spacing, or token

1. Edit the relevant file in `paradox-of-acceptance/shared/`
2. Commit and push to `main`
3. All sites using that theme file update automatically via CDN within ~24h
4. For immediate update: [purge the jsDelivr cache](https://www.jsdelivr.com/tools/purge)

### Update shared structural tokens (reset, spacing, easing)

Edit `design-tokens.css` — affects all 6 repos.

### Add a new theme

1. Create a new `theme-<name>.css` file in `shared/`
2. Add link tags to the target repos
3. Update this README

---

## Local development

Use the sync script to copy shared CSS into each repo for offline development:

```bash
# Check status
./tools/sync-design-tokens.sh

# Copy files to all consumer repos
./tools/sync-design-tokens.sh --apply
```

When testing locally, each repo will have a `shared/` directory with the CSS files. The link tags in their HTML files point to the CDN URL — swap to relative paths (`./shared/...`) for local testing, then revert before committing.

---

## Available CSS custom properties

### design-tokens.css (universal)

```css
--font-serif, --font-sans, --font-display
--space-1 through --space-16
--radius-sm, --radius-md, --radius-lg, --radius-full
--ease, --ease-spring
--transition-fast, --transition-base, --transition-slow
```

### theme-green-cool.css

```css
--bg, --surface, --border, --border-light
--text, --text-secondary, --text-tertiary
--accent, --accent-soft, --accent-glow
--shadow-sm, --shadow-md, --shadow-lg
--content-width
```

### theme-green-warm.css

```css
--bg, --surface, --border
--text, --text-muted
--accent, --accent-light
```

### theme-mono.css

```css
--bg, --surface, --border
--text, --text-secondary, --text-muted
--accent, --accent-soft
```

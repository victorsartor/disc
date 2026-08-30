---
name: Abyssal Interface
colors:
  surface: '#111412'
  surface-dim: '#111412'
  surface-bright: '#373a37'
  surface-container-lowest: '#0c0f0d'
  surface-container-low: '#1a1c1a'
  surface-container: '#1e201e'
  surface-container-high: '#282b28'
  surface-container-highest: '#333533'
  on-surface: '#e2e3df'
  on-surface-variant: '#c4c6cc'
  inverse-surface: '#e2e3df'
  inverse-on-surface: '#2f312e'
  outline: '#8e9196'
  outline-variant: '#44474c'
  surface-tint: '#bac8dc'
  primary: '#bac8dc'
  on-primary: '#243141'
  primary-container: '#0d1b2a'
  on-primary-container: '#768497'
  inverse-primary: '#525f71'
  secondary: '#bbc6e2'
  on-secondary: '#263046'
  secondary-container: '#3e4960'
  on-secondary-container: '#adb8d3'
  tertiary: '#afc9ea'
  on-tertiary: '#17324d'
  tertiary-container: '#001b33'
  on-tertiary-container: '#6b85a4'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#d6e4f9'
  primary-fixed-dim: '#bac8dc'
  on-primary-fixed: '#0f1c2c'
  on-primary-fixed-variant: '#3a4859'
  secondary-fixed: '#d7e2ff'
  secondary-fixed-dim: '#bbc6e2'
  on-secondary-fixed: '#101b30'
  on-secondary-fixed-variant: '#3c475d'
  tertiary-fixed: '#d1e4ff'
  tertiary-fixed-dim: '#afc9ea'
  on-tertiary-fixed: '#001d36'
  on-tertiary-fixed-variant: '#2f4865'
  background: '#111412'
  on-background: '#e2e3df'
  surface-variant: '#333533'
typography:
  display-lg:
    fontFamily: Inter
    fontSize: 40px
    fontWeight: '700'
    lineHeight: 48px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.01em
  headline-sm:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '600'
    lineHeight: 24px
  chat-body:
    fontFamily: Inter
    fontSize: 15px
    fontWeight: '400'
    lineHeight: 22px
  chat-code:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-caps:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '700'
    lineHeight: 16px
    letterSpacing: 0.05em
  label-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  sidebar-width: 240px
  server-rail-width: 72px
  gutter: 16px
  stack-gap-sm: 4px
  stack-gap-md: 12px
  container-padding: 24px
---

## Brand & Style

This design system is built on the concept of "Serene Power." It utilizes a **Modern-Corporate** aesthetic blended with **Glassmorphism** to evoke the feeling of high-tech equipment submerged in oceanic depths. The interface is intentionally dark to reduce eye strain during long-form communication while maintaining a sense of mystery and sophistication.

Visual hierarchy is established through "Luminance Depth"—where the most important interactive elements are the "brightest" against the ink-black abyss. The style avoids harsh lines in favor of soft, translucent layers and subtle gradients that mimic the filtration of light through water.

## Colors

The palette is strictly dark-mode, leveraging blue-toned neutrals to create a cohesive atmosphere.

- **Primary (Ink Black):** Used for the main chat canvas and foundational backgrounds.
- **Secondary (Prussian Blue):** Used for structural navigation elements like sidebars and server lists.
- **Tertiary (Dusk Blue):** Reserved for interactive "mid-ground" elements, selected states, and dividers.
- **Lavender Grey:** The primary color for utility text, iconography, and secondary labels.
- **Alabaster Grey:** The highest contrast tone, used exclusively for primary headings and critical readability.

## Typography

The system uses **Inter** for its systematic clarity and high legibility in dense information environments. For technical snippets and developer-centric chat features, **JetBrains Mono** is utilized to provide a distinct "instrument-panel" feel.

- **Scale:** High-contrast headlines (Alabaster Grey) transition into softer, high-readability body text (Lavender Grey).
- **Chat Legibility:** The `chat-body` level uses a slightly increased line height (1.45x) to ensure long message threads remain scannable.
- **Metadata:** All timestamps and channel category headers use `label-caps` to distinguish them from active conversation.

## Layout & Spacing

The layout follows a **Fixed-Fluid Hybrid** model typical of complex communication platforms.

1.  **Server Rail:** A fixed 72px left-aligned vertical bar.
2.  **Navigation Sidebar:** A fixed 240px pane for channel lists and server headers.
3.  **Chat Canvas:** A fluid central area that expands to fill remaining viewport width.
4.  **Member List:** A collapsible 240px right-aligned pane.

Spacing follows an 8px base grid, though a 4px "half-step" is permitted for dense UI elements like message grouping and reaction chips.

## Elevation & Depth

Elevation is communicated through **Tonal Layering** and **Background Blurs** rather than traditional drop shadows.

- **Level 0 (The Deep):** `#0D1B2A` - Main chat area.
- **Level 1 (The Surface):** `#1B263B` - Sidebars and modal backdrops.
- **Level 2 (The Deck):** `#415A77` at 20% opacity with a 12px backdrop blur. Used for hover states, floating tooltips, and pop-out profile cards.
- **Outlines:** Instead of shadows, use 1px inner borders of `#415A77` at 30% opacity to define the edges of surfaces.

## Shapes

The shape language balances modern software aesthetics with organic oceanic curves.

- **Standard Elements:** Buttons, input fields, and chat bubbles use a `0.5rem` (8px) radius.
- **Server Icons:** Use a dynamic transition. Default state is a `rounded-xl` (24px) squircle; active/hover state transitions to a `rounded-lg` (16px) radius.
- **Profile Avatars:** Strictly circular to distinguish humans from server/bot entities.

## Components

### Buttons & Inputs
- **Primary Action:** Solid `#415A77` background with `#E0E1DD` text. 
- **Ghost Input:** Background `#0D1B2A` with a 1px border of `#415A77`. On focus, the border glows with a soft 4px blur of the same color.

### Chat Messages
- **Grouping:** Messages from the same user within 5 minutes omit the avatar and name, using a `4px` vertical stack gap.
- **Hover State:** Entire message row receives a 5% opacity highlight of `#778DA9`.
- **Mentions:** Background of `#415A77` at 15% opacity with a solid 2px left-accent border.

### Profile Cards
- **Construction:** Use a vertical gradient from `#1B263B` to `#0D1B2A`. 
- **Details:** User roles are displayed as small, low-contrast chips with `#778DA9` text on a `#415A77` 10% opacity base.

### Status Indicators
- **Online:** A vibrant cyan-blue dot (keeping within the cool palette).
- **Away:** A crescent moon in `#778DA9`.
- **Busy:** A flat bar in `#415A77`.
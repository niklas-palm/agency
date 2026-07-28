---
name: frontend-guidance
description: UI polish, component design, animation decisions, and the invisible details that make software feel great. Use this whenever making any frontend or UI change in this project - building or editing React components, styling, transitions/animations, interaction states (hover/active/focus), loading/empty states, layout, or reviewing UI code. Consult BEFORE writing component or animation code.
---

# Frontend Guidance

> **Attribution.** This guidance is adapted from Emil Kowalski's design-engineering
> skill ([emilkowalski/skill](https://github.com/emilkowalski/skill), MIT licensed) and
> the philosophy taught in his course at [animations.dev](https://animations.dev).
> Condensed and adapted for this project; the substance, and much of the wording, is his.

You are a design engineer with craft sensibility. You build interfaces where every detail compounds into something that feels right. In a world where everyone's software is good enough, taste is the differentiator.

## Core Philosophy

### Taste is trained, not innate

Good taste is not personal preference. It is a trained instinct: the ability to see beyond the obvious and recognize what elevates. Don't just make UI work - study why the best interfaces feel the way they do, reverse engineer animations, inspect interactions, be curious.

### Unseen details compound

Most details users never consciously notice. That is the point. When a feature functions exactly as someone assumes it should, they proceed without giving it a second thought. The aggregate of invisible correctness creates interfaces people love without knowing why.

### Beauty is leverage

People select tools based on the overall experience, not just functionality. Good defaults and good animations are real differentiators. Beauty is underutilized in software - use it to stand out.

## Review Format (Required)

When reviewing UI code, you MUST use a markdown table with Before/After columns. Do NOT use a list with "Before:" and "After:" on separate lines. Always output an actual markdown table like this:

| Before | After | Why |
| --- | --- | --- |
| `transition: all 300ms` | `transition: transform 200ms ease-out` | Specify exact properties; avoid `all` |
| `transform: scale(0)` | `transform: scale(0.95); opacity: 0` | Nothing in the real world appears from nothing |
| `ease-in` on dropdown | `ease-out` with custom curve | `ease-in` feels sluggish; `ease-out` gives instant feedback |
| No `:active` state on button | `transform: scale(0.97)` on `:active` | Buttons must feel responsive to press |
| `transform-origin: center` on popover | anchor to the trigger's origin | Popovers should scale from their trigger (not modals - modals stay centered) |

Correct format: A single markdown table with | Before | After | Why | columns, one row per issue found. The "Why" column briefly explains the reasoning.

## The Animation Decision Framework

Before writing any animation code, answer these questions in order:

### 1. Should this animate at all?

**Ask:** How often will users see this animation?

| Frequency                                                   | Decision                     |
| ----------------------------------------------------------- | ---------------------------- |
| 100+ times/day (keyboard shortcuts, command palette toggle) | No animation. Ever.          |
| Tens of times/day (hover effects, list navigation)          | Remove or drastically reduce |
| Occasional (modals, drawers, toasts)                        | Standard animation           |
| Rare/first-time (onboarding, feedback forms, celebrations)  | Can add delight              |

**Never animate keyboard-initiated actions.** These are repeated hundreds of times daily. Animation makes them feel slow, delayed, and disconnected from the user's actions.

### 2. What is the purpose?

Every animation must have a clear answer to "why does this animate?"

Valid purposes:

- **Spatial consistency**: a toast enters and exits from the same direction, making swipe-to-dismiss feel intuitive
- **State indication**: a morphing button shows the state change
- **Explanation**: a marketing animation that shows how a feature works
- **Feedback**: a button scales down on press, confirming the interface heard the user
- **Preventing jarring changes**: elements appearing or disappearing without transition feel broken

If the purpose is just "it looks cool" and the user will see it often, don't animate.

### 3. What easing should it use?

Is the element entering or exiting?
  Yes → ease-out (starts fast, feels responsive)
  No →
    Is it moving/morphing on screen? → ease-in-out (natural acceleration/deceleration)
    Is it a hover/color change? → ease
    Is it constant motion (marquee, progress bar)? → linear
    Default → ease-out

**Critical: use custom easing curves.** The built-in CSS easings are too weak. They lack the punch that makes animations feel intentional.

```css
/* Strong ease-out for UI interactions */
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);

/* Strong ease-in-out for on-screen movement */
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);

/* iOS-like drawer curve */
--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);
```

**Never use ease-in for UI animations.** It starts slow, which makes the interface feel sluggish. A dropdown with `ease-in` at 300ms feels slower than `ease-out` at the same 300ms, because ease-in delays the initial movement - the exact moment the user is watching most closely.

### 4. How fast should it be?

| Element                  | Duration      |
| ------------------------ | ------------- |
| Button press feedback    | 100-160ms     |
| Tooltips, small popovers | 125-200ms     |
| Dropdowns, selects       | 150-250ms     |
| Modals, drawers          | 200-500ms     |
| Marketing/explanatory    | Can be longer |

**Rule: UI animations should stay under 300ms.** A 180ms dropdown feels more responsive than a 400ms one. A faster-spinning spinner makes the app feel like it loads faster, even when the load time is identical.

### Perceived performance

Speed in animation is not just about feeling snappy - it directly affects how users perceive your app's performance:

- A **fast-spinning spinner** makes loading feel faster (same load time, different perception)
- A **180ms select** animation feels more responsive than a **400ms** one
- **Instant tooltips** after the first one is open (skip delay + skip animation) make the whole toolbar feel faster

Easing amplifies this: `ease-out` at 200ms feels faster than `ease-in` at 200ms because the user sees immediate movement.

## Spring Animations

Springs feel more natural than duration-based animations because they simulate real physics. They settle based on physical parameters rather than fixed durations.

### When to use springs

- Drag interactions with momentum
- Elements that should feel "alive"
- Gestures that can be interrupted mid-animation
- Decorative mouse-tracking interactions

Use `useSpring` from Motion (Framer Motion) to interpolate value changes with spring-like behavior instead of updating immediately. This works when the animation is **decorative**. If it were a functional graph in a banking app, no animation would be better - know when decoration helps and when it hinders.

### Spring configuration

Apple's approach (recommended, easier to reason about):

```js
{ type: "spring", duration: 0.5, bounce: 0.2 }
```

Keep bounce subtle (0.1-0.3). Avoid bounce in most UI contexts; use it for drag-to-dismiss and playful interactions. Springs maintain velocity when interrupted (CSS keyframes restart from zero), which makes them ideal for gestures users might change mid-motion.

## Component Building Principles

### Buttons must feel responsive

Add `transform: scale(0.97)` on `:active`. This gives instant feedback, making the UI feel like it is truly listening.

```css
.button {
  transition: transform 160ms ease-out;
}
.button:active {
  transform: scale(0.97);
}
```

This applies to any pressable element. The scale should be subtle (0.95-0.98).

### Never animate from scale(0)

Nothing in the real world disappears and reappears completely. Elements animating from `scale(0)` look like they come out of nowhere. Start from `scale(0.95)` or higher, combined with opacity.

```css
/* Bad */  .entering { transform: scale(0); }
/* Good */ .entering { transform: scale(0.95); opacity: 0; }
```

### Make popovers origin-aware

Popovers should scale in from their trigger, not from center. The default `transform-origin: center` is wrong for almost every popover. **Exception: modals** - they are not anchored to a trigger, so they stay centered in the viewport. Whether the user notices individually doesn't matter; in the aggregate, unseen details compound.

### Tooltips: skip delay on subsequent hovers

Tooltips should delay before appearing to prevent accidental activation. But once one tooltip is open, hovering adjacent tooltips should open them instantly with no animation - faster without defeating the initial delay's purpose.

### Use CSS transitions over keyframes for interruptible UI

CSS transitions can be interrupted and retargeted mid-animation; keyframes restart from zero. For any interaction that can be triggered rapidly (adding toasts, toggling states), transitions produce smoother results.

### Use blur to mask imperfect transitions

When a crossfade between two states feels off despite trying different easings and durations, add subtle `filter: blur(2px)` during the transition. Without blur you see two distinct objects overlapping; blur bridges the gap, tricking the eye into perceiving a single smooth transformation. Keep blur under 20px (heavy blur is expensive, especially in Safari).

### Animate enter states with @starting-style

The modern CSS way to animate element entry without JavaScript:

```css
.toast {
  opacity: 1;
  transform: translateY(0);
  transition: opacity 400ms ease, transform 400ms ease;

  @starting-style {
    opacity: 0;
    transform: translateY(100%);
  }
}
```

Fall back to a `data-mounted` attribute set in `useEffect` when browser support requires it.

## CSS Transform Mastery

### translateY with percentages

Percentage values in `translate()` are relative to the element's own size. Use `translateY(100%)` to move an element by its own height, regardless of actual dimensions. Prefer percentages over hardcoded pixels - they are less error-prone and adapt to content.

### scale() scales children too

Unlike `width`/`height`, `scale()` also scales an element's children. When scaling a button on press, the font size, icons, and content scale proportionally. This is a feature.

### transform-origin

Every element has an anchor point from which transforms execute (default: center). Set it to match where the trigger lives for origin-aware interactions.

## clip-path for Animation

`clip-path: inset(top right bottom left)` defines a rectangular clipping region; each value "eats" into the element from that side. Powerful for reveals, tab color transitions, hold-to-delete overlays, scroll reveals, and comparison sliders - all hardware-accelerated with no extra DOM.

```css
.hidden  { clip-path: inset(0 100% 0 0); }  /* fully hidden from right */
.visible { clip-path: inset(0 0 0 0); }     /* fully visible */
```

## Gesture and Drag Interactions

- **Momentum-based dismissal**: don't require passing a distance threshold. Compute velocity (`Math.abs(distance) / elapsedTime`); if it exceeds ~0.11, dismiss. A quick flick should be enough.
- **Damping at boundaries**: when dragging past a natural boundary, the more they drag the less it moves. Things in real life slow down before stopping.
- **Pointer capture**: once dragging starts, capture all pointer events so it continues even if the pointer leaves the element.
- **Multi-touch protection**: ignore additional touch points after the initial drag begins, or the element jumps.
- **Friction instead of hard stops**: allow over-drag with increasing friction rather than an invisible wall.

## Performance Rules

### Only animate transform and opacity

These skip layout and paint, running on the GPU. Animating `padding`, `margin`, `height`, or `width` triggers all three rendering steps.

### CSS variables are inheritable

Changing a CSS variable on a parent recalculates styles for all children. In a list with many items, update `transform` directly on the element instead of a shared `--var` on the container.

### Framer Motion hardware acceleration caveat

Framer Motion's shorthand props (`x`, `y`, `scale`) are NOT hardware-accelerated - they use `requestAnimationFrame` on the main thread. For hardware acceleration, animate the full `transform` string:

```jsx
<motion.div animate={{ x: 100 }} />                          // drops frames under load
<motion.div animate={{ transform: "translateX(100px)" }} />  // hardware accelerated
```

### CSS animations beat JS under load

CSS animations run off the main thread and stay smooth when the browser is busy loading. Use CSS for predetermined animations; JS for dynamic, interruptible ones. The Web Animations API (`element.animate(...)`) gives JS control with CSS performance.

## Accessibility

### prefers-reduced-motion

Reduced motion means fewer and gentler animations, not zero. Keep opacity and color transitions that aid comprehension; remove movement and position animations.

```css
@media (prefers-reduced-motion: reduce) {
  .element { animation: fade 0.2s ease; /* no transform-based motion */ }
}
```

### Touch device hover states

Touch devices trigger hover on tap, causing false positives. Gate hover animations:

```css
@media (hover: hover) and (pointer: fine) {
  .element:hover { transform: scale(1.05); }
}
```

## Building Loved Components

1. **Developer experience is key.** No hooks, no context, no complex setup where avoidable. The less friction to adopt, the more people use it.
2. **Good defaults matter more than options.** Ship beautiful out of the box; most users never customize. Default easing, timing, and visual design should be excellent.
3. **Handle edge cases invisibly.** Pause timers when the tab is hidden, capture pointer events during drag, fill gaps between stacked items to maintain hover state. Users never notice, and that is exactly right.
4. **Use transitions, not keyframes, for dynamic UI.**

### Cohesion matters

Match the motion to the mood. A playful component can be bouncier; a professional dashboard should be crisp and fast. The easing, duration, visual design, and personality should all be in harmony.

### Asymmetric enter/exit timing

Slow where the user is deciding (hold-to-delete: 2s linear), fast where the system is responding (release: 200ms ease-out). This pattern applies broadly.

### Review your work the next day

Review animations with fresh eyes - you notice imperfections the next day that you missed during development. Play animations in slow motion or frame by frame to spot timing issues invisible at full speed.

## Stagger Animations

When multiple elements enter together, stagger their appearance with a small delay after the previous one (30-80ms between items). This cascading effect feels more natural than everything appearing at once. Keep delays short - long delays make the interface feel slow. Stagger is decorative; never block interaction while it plays.

## Review Checklist

| Issue                                      | Fix                                                              |
| ------------------------------------------ | ---------------------------------------------------------------- |
| `transition: all`                          | Specify exact properties: `transition: transform 200ms ease-out` |
| `scale(0)` entry animation                 | Start from `scale(0.95)` with `opacity: 0`                       |
| `ease-in` on UI element                    | Switch to `ease-out` or custom curve                             |
| `transform-origin: center` on popover      | Set to trigger location (modals are exempt - keep centered)      |
| Animation on keyboard action               | Remove animation entirely                                        |
| Duration > 300ms on UI element             | Reduce to 150-250ms                                              |
| Hover animation without media query        | Add `@media (hover: hover) and (pointer: fine)`                  |
| Keyframes on rapidly-triggered element     | Use CSS transitions for interruptibility                         |
| Framer Motion `x`/`y` props under load     | Use `transform: "translateX()"` for hardware acceleration        |
| Same enter/exit transition speed           | Make exit faster than enter                                      |
| Elements all appear at once                | Add stagger delay (30-80ms between items)                        |

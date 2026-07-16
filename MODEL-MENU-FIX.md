# Model menu fix

The model picker is now moved to a body-level fixed portal when opened. This prevents `.shell`, `.main`, or header overflow and stacking contexts from clipping it.

It closes on selection, outside tap/click, Escape, resize/orientation changes, and remains positioned relative to the trigger. The implementation uses standard DOM/CSS APIs supported by Chromium-based Pi Browser and includes `visualViewport` handling with `innerWidth/innerHeight` fallbacks.

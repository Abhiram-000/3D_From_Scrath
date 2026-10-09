/**
 * Landing-page input validation — V1's exact rules (`07`).
 *
 * In its own module because Svelte's template parser scans <script> blocks for markup, and the
 * suspicious-content needles (`<script`, `<iframe`) read as HTML to it. Over here they are just
 * strings.
 */

/** The suspicious-content patterns from `07`: markup and URL schemes are rejected, not escaped. */
const SUSPICIOUS_NEEDLES = ['<script', 'javascript:', 'data:text/html', '<iframe', 'eval('];

export function suspiciousContent(value: string): boolean {
  const lowered = value.toLowerCase();
  if (SUSPICIOUS_NEEDLES.some((needle) => lowered.includes(needle))) return true;
  return /on\w+\s*=/i.test(value);
}

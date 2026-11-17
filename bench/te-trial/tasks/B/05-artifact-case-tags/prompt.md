`npm run build:artifact` (scripts/to-artifact.mjs) breaks on some bundles. When the bundled code contains a character whose lower-case form has a different length, such as the Turkish capital dotted İ, the artifact's HTML comes out damaged: closing tags are found at the wrong offset, so code can leak into the page markup or be cut short.

What I expect: closing tags are matched case-insensitively at their real position in the original text, without changing its length. The emitted document must contain the bundle code verbatim and exactly once, whatever characters it holds.

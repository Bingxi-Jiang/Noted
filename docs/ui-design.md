# Noted UI

Noted is a daily notes workspace. The UI uses native CSS and locally served Phosphor regular SVGs, retaining the existing routes, navigation labels, recording controls, and client-side account preferences.

## Design rules

- Spacing follows a 4px rhythm. Small controls use 8px radii, reading surfaces use 12px, and large cards and dialogs use 16px.
- The application uses one blue interaction accent. Red, green, and amber communicate meaningful recording, completion, error, and warning states. Folder colors and speaker labels remain semantic.
- System fonts avoid a remote font dependency. Notes and transcripts use 14px text with generous line height; metadata is visually secondary.
- Desktop sidebars are 264px (240px on smaller desktop windows). Below 768px the sidebar becomes a dismissible drawer, with independent scrolling and a fixed account footer.
- Layout responds to the main content container, rather than only the viewport. Below 840px available width, transcript and insights stack in one scrollable workspace. Below 700px, the header separates the title from recording controls.
- Full tab names stay on one line. Narrow tab strips scroll horizontally; arrow keys, Home, and End select tabs and reveal the focused tab.
- Long session names clamp to two lines in lists with full names available in tooltips. The editable workspace title grows up to 96px, then scrolls within the field.
- Dialogs fit the dynamic viewport. Their body scrolls while the title, close control, and footer remain available. Nested confirmations disable the underlying dialog and return focus when dismissed.
- Light and dark themes share semantic tokens across all components. A saved preference takes priority; otherwise the initial theme follows the system.
- Inputs, buttons, dialogs, tabs, and speaker fields have keyboard focus and accessible names. Reduced-motion preferences disable animation and transitions.

## Audit findings addressed

The previous mobile layout placed the full sidebar above the application while preventing document scrolling. Fixed-width transcript columns could overflow, tab labels wrapped, and multi-line session titles overlapped their metadata. Settings inherited a narrower generic modal width, select fields stretched to the height of adjacent helper text, and multiple content surfaces retained light-theme colors in dark mode.

The shared stylesheet now controls sizing, responsive layout, typography, scrolling, and both themes without a chain of theme overrides. The home screen includes direct access to recent sessions. Product copy explains the user's next action instead of describing implementation details.

## Verification

Browser review uses isolated sample data, with no AI calls or changes to the user's sessions. It covers home, lecture and meeting workspaces, every insight tab, folder creation, batch moves, delete confirmations, speaker mapping, exports, accounts, and appearance preferences. Checks include long Chinese and English content, empty/loading/error states, keyboard tab selection, dialog focus, and settings scroll retention.

The review matrix includes light and dark themes at 1440×900, 1024×600, 768×1024, 390×844, and 320×480, with additional home/workspace checks at 1024×768 and 320×640. The completed review contains 228 snapshots with no unintended horizontal overflow or browser JavaScript errors. All 12 existing tests pass. Targeted checks also confirm local icon references, provider-field focus retention, modal focus return, drawer dismissal, and scroll chaining from the transcript to notes in stacked layouts.

Screenshots and the local review harness are saved under `output/ui-review/` and `output/ui-review.mjs`. Existing provider, server, startup, and export tests are run with `npm test`. Live microphone capture, external AI generation, Google authentication, and Drive uploads require their respective services and are outside the visual fixture review.

To rebuild the local icon sprite after changing its icon list, run `node scripts/build-icons.js`. The vendored icons retain the [Phosphor MIT license](../public/icons/LICENSE).

# Operator UI locales

`en.json` and `zh-CN.json` are the only editable operator translations. Keys are stable; values support only named `{identifier}` placeholders. Do not put endpoints, tokens, user data, or other secrets in a catalog.

To add or change a locale: edit the canonical JSON catalog, run `pnpm run locales:operator:generate`, then run `pnpm run locales:operator:check`. Generated adapters are tracked for review and must not be edited manually.

The saved language values are exactly `system`, `zh-CN`, and `en`. `system` resolves every Chinese locale to `zh-CN`, and everything else to English; English is the fallback.

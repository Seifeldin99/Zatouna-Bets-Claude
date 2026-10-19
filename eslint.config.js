// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

// Edge Functions run on Deno, not in the app; Deno checks them (`deno check`).
module.exports = defineConfig([expoConfig, { ignores: ['dist/*', 'supabase/functions/*'] }]);

# Contributing to Soroban Identity

Thanks for your interest in contributing. Here's everything you need to get started.

## Fork & Clone

```bash
git clone https://github.com/your-username/Soroban-Identity.git
cd Soroban-Identity
```

## Branch Naming

Use one of these prefixes:

- `feat/` — new features
- `fix/` — bug fixes
- `docs/` — documentation only

Example: `feat/credential-filter-ui`

## Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add credential type filter to CredentialsPanel
fix: handle deploy.sh exit codes
docs: update README quick start
```

## Local Setup

### Contracts (Rust)

```bash
rustup target add wasm32-unknown-unknown
cd contracts && cargo build --target wasm32-unknown-unknown --release
cargo test
```

### SDK (TypeScript)

```bash
cd sdk
npm install
npm run build
npm test
```

### Frontend (React + Vite)

```bash
cd frontend
npm install
npm run dev
```

### Deploy to Testnet

```bash
export STELLAR_SECRET_KEY=S...
bash scripts/deploy.sh
```

## PR Checklist

Before opening a PR:

- [ ] Branch is named with the correct prefix
- [ ] Commits follow Conventional Commits format
- [ ] SDK tests pass (`npm test` in `sdk/`)
- [ ] No TypeScript errors (`npx tsc --noEmit` in `frontend/`)
- [ ] **SDK changes**: Update the `[Unreleased]` section in `sdk/CHANGELOG.md`
- [ ] PR description references the related issue (e.g. `Closes #17`)

## Linking a PR to an Issue

Include one of these in your PR description:

```
Closes #17
Fixes #18
Resolves #19
```

GitHub will automatically close the issue when the PR is merged.

## Questions?

Open a [Discussion](../../discussions) or comment on the relevant issue.


## Internationalization (i18n)

### Locale Validation

We have a locale validation script that ensures all translation files are in sync with the English locale (`en.json`), which serves as the source of truth.

To run the validation:

```bash
cd frontend
node scripts/validate-locales.js
```

This script:
1. Compares all locale files against `en.json`
2. Reports any missing translation keys
3. Fails with a non-zero exit code if keys are missing

### Why Validation Exists

The validation script ensures:
- Consistent user experience across all languages
- No missing translation keys that would expose raw key names in production
- Automatic fallback to English for any missing translations
- Development warnings when keys are missing (development builds only)

### Adding New Translations

1. Always add new keys to `en.json` first
2. Then add the corresponding translations to other locale files
3. Run the validation script to ensure all locales are in sync

### Fallback Behavior

The i18n configuration is set up to:
- Fall back to English (`en`) when a translation key is missing
- Show development warnings for missing keys (development builds only)
- Silently fall back in production builds (no warnings)
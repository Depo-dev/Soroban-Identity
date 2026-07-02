#!/usr/bin/env node

/**
 * Locale validation script
 * 
 * This script validates that all translation keys in locale files
 * match the English locale (en.json) as the source of truth.
 * 
 * Usage: node scripts/validate-locales.js
 */

const fs = require('fs');
const path = require('path');

// Path to locales directory
const LOCALES_DIR = path.join(__dirname, '..', 'src', 'locales');
const ENGLISH_LOCALE = 'en.json';

function getAllKeys(obj, prefix = '') {
  let keys = [];
  for (const key in obj) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
      keys = keys.concat(getAllKeys(obj[key], fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

function findMissingKeys(sourceKeys, targetKeys, localeName) {
  const missingKeys = [];
  for (const key of sourceKeys) {
    if (!targetKeys.includes(key)) {
      missingKeys.push(key);
    }
  }
  return missingKeys;
}

function main() {
  console.log('🔍 Validating locale files...\n');
  
  // Read English locale as source of truth
  const englishPath = path.join(LOCALES_DIR, ENGLISH_LOCALE);
  let englishData;
  try {
    englishData = JSON.parse(fs.readFileSync(englishPath, 'utf8'));
  } catch (error) {
    console.error(`❌ Failed to read ${ENGLISH_LOCALE}:`, error.message);
    process.exit(1);
  }
  
  const englishKeys = getAllKeys(englishData);
  console.log(`📊 ${ENGLISH_LOCALE}: ${englishKeys.length} translation keys\n`);
  
  // Get all locale files except English
  const localeFiles = fs.readdirSync(LOCALES_DIR)
    .filter(file => file.endsWith('.json') && file !== ENGLISH_LOCALE);
  
  let hasErrors = false;
  
  for (const localeFile of localeFiles) {
    const localePath = path.join(LOCALES_DIR, localeFile);
    let localeData;
    
    try {
      localeData = JSON.parse(fs.readFileSync(localePath, 'utf8'));
    } catch (error) {
      console.error(`❌ Failed to read ${localeFile}:`, error.message);
      hasErrors = true;
      continue;
    }
    
    const localeKeys = getAllKeys(localeData);
    const missingKeys = findMissingKeys(englishKeys, localeKeys, localeFile);
    
    if (missingKeys.length === 0) {
      console.log(`✅ ${localeFile}: All ${localeKeys.length} keys present (matches ${ENGLISH_LOCALE})`);
    } else {
      console.log(`❌ ${localeFile}: ${missingKeys.length} missing keys (has ${localeKeys.length}/${englishKeys.length} keys)`);
      console.log('   Missing keys:');
      for (const key of missingKeys.slice(0, 10)) { // Show first 10 missing keys
        console.log(`   - ${key}`);
      }
      if (missingKeys.length > 10) {
        console.log(`   ... and ${missingKeys.length - 10} more`);
      }
      hasErrors = true;
    }
    console.log();
  }
  
  if (hasErrors) {
    console.log('❌ Locale validation failed. Missing translation keys detected.');
    console.log('   Please ensure all locale files have the same keys as en.json.');
    process.exit(1);
  } else {
    console.log('✅ All locale files are in sync!');
  }
}

// Add error handling for file system operations
try {
  if (!fs.existsSync(LOCALES_DIR)) {
    console.error(`❌ Locales directory not found: ${LOCALES_DIR}`);
    process.exit(1);
  }
  
  main();
} catch (error) {
  console.error('❌ Unexpected error:', error.message);
  process.exit(1);
}
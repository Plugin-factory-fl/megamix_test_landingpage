#!/usr/bin/env node

/**
 * Sync plugin version from .jucer file to server.js
 * This ensures the API version endpoint always matches the plugin version
 */

const fs = require('fs');
const path = require('path');

// Paths
const jucerFilePath = path.join(__dirname, '..', 'MegaMixAI', 'MegaMixAI.jucer');
const serverFilePath = path.join(__dirname, 'server.js');

// Read and parse .jucer file
function extractVersionFromJucer() {
    try {
        const jucerContent = fs.readFileSync(jucerFilePath, 'utf8');
        
        // Parse XML to extract version attribute from JUCERPROJECT tag
        // Format: <JUCERPROJECT ... version="1.0.3" ...>
        const versionMatch = jucerContent.match(/<JUCERPROJECT[^>]*version=["']([^"']+)["']/);
        
        if (!versionMatch || !versionMatch[1]) {
            throw new Error('Could not find version in .jucer file');
        }
        
        return versionMatch[1].trim();
    } catch (error) {
        console.error('Error reading .jucer file:', error.message);
        process.exit(1);
    }
}

// Update server.js with new version
function updateServerVersion(newVersion) {
    try {
        let serverContent = fs.readFileSync(serverFilePath, 'utf8');
        
        // Find and replace the version in the API endpoint
        // Pattern: res.json({ version: 'X.X.X' });
        const versionRegex = /res\.json\(\{\s*version:\s*['"]([^'"]+)['"]\s*\}\);/;
        
        if (!versionRegex.test(serverContent)) {
            throw new Error('Could not find version endpoint in server.js');
        }
        
        const oldVersionMatch = serverContent.match(versionRegex);
        const oldVersion = oldVersionMatch ? oldVersionMatch[1] : 'unknown';
        
        // Replace version
        serverContent = serverContent.replace(versionRegex, `res.json({ version: '${newVersion}' });`);
        
        // Write back to file
        fs.writeFileSync(serverFilePath, serverContent, 'utf8');
        
        console.log(`✓ Version updated in server.js: ${oldVersion} → ${newVersion}`);
        return true;
    } catch (error) {
        console.error('Error updating server.js:', error.message);
        process.exit(1);
    }
}

// Main execution
function main() {
    console.log('Syncing plugin version to server.js...');
    
    const version = extractVersionFromJucer();
    console.log(`Found plugin version in .jucer: ${version}`);
    
    updateServerVersion(version);
    
    console.log('✓ Version sync complete!');
}

// Run if called directly
if (require.main === module) {
    main();
}

module.exports = { extractVersionFromJucer, updateServerVersion };

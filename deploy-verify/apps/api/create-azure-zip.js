// create-azure-zip.js
// Usage: node create-azure-zip.js
// This script creates a Linux-compatible zip for Azure App Service deployment.

const fs = require('fs');
const archiver = require('archiver');

const output = fs.createWriteStream('../hobbyiq-backend.zip');
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', function () {
  console.log(archive.pointer() + ' total bytes');
  console.log('hobbyiq-backend.zip has been finalized');
});

archive.on('error', function (err) {
  throw err;
});

archive.pipe(output);


// Add dist/ folder recursively
archive.directory('dist/', 'dist');
// Add package.json and package-lock.json (but NOT node_modules)
archive.file('package.json', { name: 'package.json' });
archive.file('package-lock.json', { name: 'package-lock.json' });

archive.finalize();

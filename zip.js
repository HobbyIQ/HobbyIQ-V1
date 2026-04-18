// zip.js
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

// Always resolve paths relative to the project root
const projectRoot = __dirname;
const outputPath = path.join(projectRoot, 'deploy.zip');
const output = fs.createWriteStream(outputPath);
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => {
  console.log(`deploy.zip created at ${outputPath} (${archive.pointer()} total bytes)`);
});

archive.on('error', err => { throw err; });

archive.pipe(output);

// Only include runtime essentials
archive.file(path.join(projectRoot, 'package.json'), { name: 'package.json' });
archive.file(path.join(projectRoot, 'package-lock.json'), { name: 'package-lock.json' });
archive.directory(path.join(projectRoot, 'dist'), 'dist');

archive.finalize();

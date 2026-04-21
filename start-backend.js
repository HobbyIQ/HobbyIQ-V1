// Root-level script to start the backend from anywhere
const { exec } = require('child_process');
const path = require('path');

const backendDir = path.join(__dirname, 'hobbyiq-backend');

exec('npm start', { cwd: backendDir, stdio: 'inherit' }, (err, stdout, stderr) => {
  if (err) {
    console.error('Failed to start backend:', err);
    process.exit(1);
  }
  process.stdout.write(stdout);
  process.stderr.write(stderr);
});

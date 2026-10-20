import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Never import this module from the renderer. Existing process variables win.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const directory = process.env.PORTABLE_EXECUTABLE_DIR || root;
const filename = process.env.SAS_ENV_FILE || path.join(directory, '.env');
if (fs.existsSync(filename)) process.loadEnvFile(filename);

import { API_BASE_URL } from '../shared/config.js';

// Build wiring only: no request, authentication or clinical behavior.
const status = document.getElementById('build-status');
if (status) status.textContent = `Browser module loaded. API base configured: ${API_BASE_URL}. No request sent.`;

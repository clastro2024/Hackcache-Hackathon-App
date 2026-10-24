import { mountHeader } from '../shared/ui.js';

// Shared frame only. The sign-in controller will use the existing session helper.
mountHeader(document.getElementById('app-header'), { area: 'utility' });

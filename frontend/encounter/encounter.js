import { mountHeader } from '../shared/ui.js';

// Shared frame only. F06 content and its authorized controller follow separately.
mountHeader(document.getElementById('app-header'), { area: 'provider', page: 'encounter' });
